import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../scripts/provision-lifeos-identity.ts", import.meta.url), "utf8");
const guide = await readFile(new URL("../docs/milestone-0a-service-identity.md", import.meta.url), "utf8");

test("provisioning is fixed-ID, dry-run by default, and requires an absolute secret path", () => {
  assert.match(source, /LIFEOS_USER_ID = "lifeos-service-0a"/);
  assert.match(source, /if \(!options\.apply\)/);
  assert.match(source, /if \(!isAbsolute\(options\.secretFile\)\)/);
  assert.match(source, /--secret-file \/absolute\/path \[--apply\]/);
  assert.doesNotMatch(source, /argv\.find\(\(arg\) => !arg\.startsWith/);
});

test("user, key, unlimited free entitlement, and audit are created in one transaction", () => {
  assert.match(source, /deps\.db\.transaction\(async \(tx\) =>/);
  assert.match(source, /firstName: SERVICE_LABEL\.firstName[\s\S]*lastName: SERVICE_LABEL\.lastName[\s\S]*email: null[\s\S]*stripeCustomerId: null/);
  assert.match(source, /permissions: \["attest:write", "attest:read"\]/);
  assert.match(source, /attestationLimit: -1[\s\S]*apiKeyLimit: -1[\s\S]*stripeCustomerId: null[\s\S]*stripeSubscriptionId: null/);
  assert.match(source, /action: AUDIT_ACTION/);
  assert.match(source, /await assertNoPriorRows\(tx\)/);
});

test("plaintext key is exclusively created with restrictive mode and removed on failures", () => {
  assert.match(source, /open\(path, "wx", 0o600\)/);
  assert.match(source, /await file\.chmod\(0o600\)/);
  assert.match(source, /if \(secretCreated\) \{[\s\S]*await deps\.removeSecret\(secretPath\)/);
  assert.match(source, /keyPrefix: key\.keyPrefix/);
  assert.doesNotMatch(source, /console\.log\([^\n]*fullKey/);
});

test("operator guide documents safe invocation and scoped rollback", () => {
  assert.match(guide, /--secret-file \/absolute\/secret\/path\/FORGEPROOF_API_KEY/);
  assert.match(guide, /rolls back its transaction and removes the secret file/);
  assert.match(guide, /only `api_keys`, `subscriptions`[\s\S]*`lifeos-service-0a`/);
});
