import test from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import nodemailer from "nodemailer";
import { tsImport } from "tsx/esm/api";
import { attestRequestSchema, agentAttestSchema, requestValidationIssues } from "../server/requestValidation.ts";
import { sendGitCommitFailureEmail } from "../server/email.ts";
import { fromError } from "zod-validation-error";

const valid = {
  file_path: "src/example.ts", file_hash: "sha256:example", model_name: "test-model",
  model_provider: "test-provider", country_of_origin: "US",
};

test("PostgreSQL identifiers escape embedded quotes without turning them into SQL", () => {
  const name = 'receipts"; DROP TABLE users; --';
  const query = new PgDialect().sqlToQuery(sql`select ${sql.identifier(name)} where id = ${42}`);
  assert.equal(query.sql, 'select "receipts""; DROP TABLE users; --" where id = $1');
  assert.deepEqual(query.params, [42]);
});

test("attestation validation preserves defaults, optional fields and arbitrary metadata", () => {
  const metadata = { nested: { tags: [1, null, true] }, empty: {} };
  assert.deepEqual(attestRequestSchema.parse({ ...valid, metadata, ignored: true }), {
    ...valid, metadata, attestation_type: "origin",
  });
  for (const attestation_type of ["origin", "security_audit", "refactor", "review"]) {
    assert.equal(attestRequestSchema.parse({ ...valid, attestation_type }).attestation_type, attestation_type);
  }
  const batch = { files: [{ file_path: "x", file_hash: "y" }], model_name: "m", model_provider: "p", country_of_origin: "US", metadata };
  assert.deepEqual(agentAttestSchema.parse(batch), batch);
  assert.equal(agentAttestSchema.safeParse({ ...batch, files: [{}] }).success, false);
});

test("invalid requests retain the public issue codes, paths and messages", () => {
  const input = { ...valid, file_path: 123, model_name: undefined, attestation_type: "bad" };
  const result = attestRequestSchema.safeParse(input);
  assert.equal(result.success, false);
  assert.deepEqual(requestValidationIssues(result.error, input), [
    { code: "invalid_type", expected: "string", received: "number", path: ["file_path"], message: "Expected string, received number" },
    { code: "invalid_type", expected: "string", received: "undefined", path: ["model_name"], message: "Required" },
    { received: "bad", code: "invalid_enum_value", options: ["origin", "security_audit", "refactor", "review"], path: ["attestation_type"], message: "Invalid enum value. Expected 'origin' | 'security_audit' | 'refactor' | 'review', received 'bad'" },
  ]);
  const readable = fromError(result.error);
  assert.ok(readable.message.includes("file_path"));
  assert.equal(readable.details.length, 3);
  const nested = { files: [{ file_path: null, file_hash: "x" }], model_name: "m", model_provider: "p", country_of_origin: "US" };
  const invalid = agentAttestSchema.safeParse(nested);
  assert.deepEqual(requestValidationIssues(invalid.error, nested)[0], {
    code: "invalid_type", expected: "string", received: "null", path: ["files", 0, "file_path"], message: "Expected string, received null",
  });
});

test("Drizzle insert schemas still enforce required fields and database defaults", async () => {
  const { insertRepositorySchema, insertSubscriptionSchema } = await tsImport("../shared/schema.ts", import.meta.url);
  assert.equal(insertRepositorySchema.safeParse({}).success, false);
  assert.equal(insertSubscriptionSchema.safeParse({ userId: "test-user" }).success, true);
  assert.equal(insertSubscriptionSchema.safeParse({ userId: "test-user", attestationLimit: "100" }).success, false);
});

test("email uses the configured transport and renders locally without SMTP", async (t) => {
  // These test-only values replace SMTP configuration before application code reads it.
  Object.assign(process.env, { SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "465", SMTP_USER: "test-user", SMTP_PASS: "test-password", SMTP_FROM: "sender@example.invalid" });
  const original = nodemailer.createTransport.bind(nodemailer);
  const messages = [];
  t.mock.method(nodemailer, "createTransport", (options) => {
    assert.deepEqual(options, { host: "smtp.example.invalid", port: 465, secure: true, auth: { user: "test-user", pass: "test-password" } });
    const local = original({ jsonTransport: true });
    return { async sendMail(message) { messages.push(JSON.parse((await local.sendMail(message)).message)); } };
  });
  t.after(() => { for (const key of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"]) delete process.env[key]; });
  await sendGitCommitFailureEmail({ to: "recipient@example.invalid", receiptId: 42, entryHash: "sha256:test", errorMessage: "Test failure", baseUrl: "https://example.invalid" });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].subject, "ForgeProof: GitHub commit failed — action required");
  assert.match(messages[0].text, /Receipt ID : 42/);
  assert.match(messages[0].html, /https:\/\/example.invalid\/dashboard#github/);
  delete process.env.SMTP_HOST;
  await sendGitCommitFailureEmail({ to: "recipient@example.invalid", receiptId: 42, entryHash: "test", errorMessage: "test", baseUrl: "https://example.invalid" });
  assert.equal(messages.length, 1);
});
