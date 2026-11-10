import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import nodemailer from "nodemailer";
import {
  insertApiKeySchema,
  insertOrganizationSchema,
  insertRepositorySchema,
} from "../shared/schema";

describe("security dependency upgrade compatibility", () => {
  it("preserves Drizzle-generated insert schema validation with Zod 4", () => {
    const repository = {
      userId: "test-user",
      githubId: 123,
      name: "example",
      fullName: "owner/example",
      url: "https://github.com/owner/example",
    };
    expect(insertRepositorySchema.parse(repository)).toEqual(repository);
    expect(
      insertRepositorySchema.safeParse({ ...repository, githubId: "123" }).success,
    ).toBe(false);
    expect(
      insertRepositorySchema.safeParse({ ...repository, userId: undefined }).success,
    ).toBe(false);
  });

  it("keeps organization and API key insert schemas usable", () => {
    expect(
      insertOrganizationSchema.parse({
        name: "Example",
        slug: "example",
        ownerId: "test-user",
      }),
    ).toEqual({ name: "Example", slug: "example", ownerId: "test-user" });
    expect(
      insertApiKeySchema.safeParse({
        userId: "test-user",
        name: "CI",
        keyHash: "test-hash",
        keyPrefix: "fp_test",
        permissions: ["attest:read"],
      }).success,
    ).toBe(true);
  });

  it("escapes embedded quotes in PostgreSQL identifiers", () => {
    const dialect = new PgDialect();
    const query = dialect.sqlToQuery(sql`select ${sql.identifier('name"; SELECT 1; --')}`);
    expect(query.sql).toBe('select "name""; SELECT 1; --"');
    expect(query.params).toEqual([]);
  });

  it("composes notification mail with Nodemailer 10 without a network connection", async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const result = await transport.sendMail({
      from: "ForgeProof <noreply@example.com>",
      to: "Recipient <recipient@example.com>",
      subject: "ForgeProof: GitHub commit failed — action required",
      text: "The receipt is saved. Reconnect GitHub to retry the commit.",
      html: "<p>The receipt is saved.</p>",
    });
    expect(result.envelope.to).toEqual(["recipient@example.com"]);
    expect(JSON.parse(result.message.toString())).toMatchObject({
      subject: "ForgeProof: GitHub commit failed — action required",
      text: "The receipt is saved. Reconnect GitHub to retry the commit.",
      html: "<p>The receipt is saved.</p>",
    });
  });
});
