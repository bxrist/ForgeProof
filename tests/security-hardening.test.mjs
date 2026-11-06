import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { hasApiKeyPermission, mcpToolPermission, verifyGitHubWebhookSignature } from "../server/security.ts";

const routes = await readFile(new URL("../server/routes.ts", import.meta.url), "utf8");

test("no unauthenticated administrative database reseeding is reachable in this source", () => {
  assert.doesNotMatch(routes, /storage\.clearAllAttestations\s*\(/);
  assert.match(routes, /app\.post\("\/api\/admin\/reseed"[\s\S]*?status\(410\)/);
});

test("GitHub webhook fails closed when unconfigured and verifies the signed raw bytes", () => {
  assert.match(routes, /if \(!webhookSecret\) return res\.status\(503\)/);
  assert.match(routes, /verifyGitHubWebhookSignature\(req\.rawBody/);
  const secret = "sample-webhook-secret";
  const exact = Buffer.from("{\"event\":\"push\",\"test\":true}");
  const signature = "sha256=" + createHmac("sha256", secret).update(exact).digest("hex");
  assert.equal(verifyGitHubWebhookSignature(exact, signature, secret), true);
  assert.equal(verifyGitHubWebhookSignature(Buffer.from("different"), signature, secret), false);
  assert.equal(verifyGitHubWebhookSignature(exact, signature, undefined), false);
  assert.equal(verifyGitHubWebhookSignature(exact, "sha256=" + "0".repeat(64), secret), false);
  assert.equal(verifyGitHubWebhookSignature(exact, signature.toUpperCase(), secret), false);
  assert.equal(verifyGitHubWebhookSignature(exact, ["anything"], secret), false);
});

test("capability mapping rejects unrelated permissions and never grants write from read", () => {
  assert.equal(hasApiKeyPermission(["attest:read"], "attest:write"), false);
  assert.equal(hasApiKeyPermission(["attest:write"], "attest:write"), true);
  assert.equal(hasApiKeyPermission(["attest:read"], "attest:read"), true);
  assert.equal(hasApiKeyPermission([], "attest:write"), false);
  assert.equal(hasApiKeyPermission(undefined, "attest:write"), false);
  assert.equal(mcpToolPermission("forgeproof_lookup"), "attest:read");
  assert.equal(mcpToolPermission("forgeproof_verify_chain"), "attest:read");
  for (const tool of ["forgeproof_attest","forgeproof_audit_attest","forgeproof_batch_attest","unknown"]) {
    assert.equal(mcpToolPermission(tool), "attest:write");
  }
  assert.match(routes, /hasApiKeyPermission\(apiKey\.permissions, requiredPermission\)/);
  assert.match(routes, /authenticateApiKey\(req, mcpToolPermission\(tool\)\)/);
});
