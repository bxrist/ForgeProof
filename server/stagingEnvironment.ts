import { join } from "node:path";
import { forbiddenStagingSigner, publicSignerFingerprint } from "./stagingSignerPolicy";

// Restore only flattened, bounded PKCS8 framing in the child environment.
// Real Ed25519 parsing and independent public-pin checks remain mandatory.
function stagingPrivatePem(value: string | undefined) {
  if (!value || value.length > 1024 || /[\r\n\\]/.test(value)) return value;
  const match = /^-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/= \t]+)-----END PRIVATE KEY-----$/.exec(value);
  if (!match) return value;
  const body = match[1].replace(/[ \t]/g, "");
  if (body.length < 64 || body.length > 256 ||
      Buffer.from(body, "base64").toString("base64") !== body) return value;
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}

// No global mutation: this environment is used only by the isolated child.
export function prepareStagingEnvironment(source: NodeJS.ProcessEnv, root: string) {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const name of Object.keys(env)) {
    if (name.startsWith("FORGEPROOF_LIVE_") || name.startsWith("PG") ||
        name.startsWith("SMTP_") || name.startsWith("LIFEOS_OWNER_APPROVAL_")) delete env[name];
  }
  const socket = join(root, "generated-artifacts/0b-staging-pg/socket");
  env.DATABASE_URL = `postgresql://runner@localhost/forgeproof_0b_staging?host=${encodeURIComponent(socket)}&port=55439`;
  env.NODE_ENV = "development";
  env.PORT = "5001";
  env.FORGEPROOF_ISOLATED_STAGING = "true";
  env.FORGEPROOF_STRIPE_MODE = "sandbox";
  env.FORGEPROOF_GIT_LEDGER_ENABLED = "true";
  env.FORGEPROOF_ED25519_PRIVATE_KEY_PEM =
    stagingPrivatePem(source.FORGEPROOF_STAGING_SIGNER_PRIVATE_KEY_PEM);
  env.FORGEPROOF_ED25519_PUBLIC_KEY_PIN =
    source.FORGEPROOF_STAGING_SIGNER_PUBLIC_KEY_PIN;
  env.FORGEPROOF_GIT_LEDGER_RECEIPT_SIGNER_PIN =
    source.FORGEPROOF_STAGING_RECEIPT_SIGNER_PIN;
  // Empty explicit credentials disable connector fallback; never borrow a live key.
  env.STRIPE_SECRET_KEY = source.FORGEPROOF_STAGING_STRIPE_SECRET_KEY || "";
  env.STRIPE_WEBHOOK_SECRET = source.FORGEPROOF_STAGING_STRIPE_WEBHOOK_SECRET || "";
  delete env.FORGEPROOF_STRIPE_WEBHOOK_URL;
  delete env.FORGEPROOF_STRIPE_WEBHOOK_ACCOUNT_ID;
  for (const suffix of ["HOST", "PORT", "USER", "PASS"]) {
    env[`SMTP_${suffix}`] = source[`FORGEPROOF_STAGING_SMTP_${suffix}`] || "";
  }
  for (const suffix of ["JSON", "FILE"]) {
    env[`LIFEOS_OWNER_APPROVAL_${suffix}`] = source[`FORGEPROOF_STAGING_LIFEOS_OWNER_APPROVAL_${suffix}`] || "";
  }
  const required = [
    "FORGEPROOF_ED25519_PRIVATE_KEY_PEM", "FORGEPROOF_ED25519_PUBLIC_KEY_PIN",
    "FORGEPROOF_GIT_LEDGER_BRANCH", "FORGEPROOF_GIT_LEDGER_REPOSITORY_LABEL",
    "FORGEPROOF_GIT_LEDGER_BASE_COMMIT", "FORGEPROOF_GIT_LEDGER_BASE_EVENT_HASH",
    "FORGEPROOF_GIT_LEDGER_BASE_SEQUENCE", "FORGEPROOF_GIT_LEDGER_BASE_RECEIPT_ID",
    "FORGEPROOF_GIT_LEDGER_BASE_RECEIPT_ENTRY_HASH", "FORGEPROOF_GIT_LEDGER_SIGNER_KEY_ID",
    "FORGEPROOF_GIT_LEDGER_RECONCILIATION_DIGEST", "FORGEPROOF_GIT_LEDGER_RECEIPT_SIGNER_PIN",
    "FORGEPROOF_GIT_LEDGER_RECONCILIATION_SIGNER_PUBLIC_KEY",
    "CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "STRIPE_SECRET_KEY",
  ];
  const missing = required.filter(name => !env[name]);
  const invalid: string[] = [];
  if (env.FORGEPROOF_ED25519_PUBLIC_KEY_PIN) {
    try {
      if (forbiddenStagingSigner(publicSignerFingerprint(env.FORGEPROOF_ED25519_PUBLIC_KEY_PIN),
        env.FORGEPROOF_GIT_LEDGER_RECEIPT_SIGNER_PIN)) invalid.push("FORGEPROOF_ED25519_PUBLIC_KEY_PIN");
    } catch { invalid.push("FORGEPROOF_ED25519_PUBLIC_KEY_PIN"); }
  }
  // Diagnose an unsafe live-only attempt without ever copying that credential.
  // An explicitly supplied staging key takes precedence for validation too.
  if (!source.FORGEPROOF_STAGING_STRIPE_SECRET_KEY &&
      source.STRIPE_SECRET_KEY?.startsWith("sk_live_")) invalid.push("STRIPE_SECRET_KEY");
  if (env.FORGEPROOF_GIT_LEDGER_BRANCH &&
      !/^forgeproof\/validation\/[A-Za-z0-9_-]+$/.test(env.FORGEPROOF_GIT_LEDGER_BRANCH)) invalid.push("FORGEPROOF_GIT_LEDGER_BRANCH");
  for (const [name, prefix] of [
    ["STRIPE_SECRET_KEY", "sk_test_"], ["CLERK_SECRET_KEY", "sk_test_"],
    ["CLERK_PUBLISHABLE_KEY", "pk_test_"],
  ]) {
    if (env[name] && !env[name]!.startsWith(prefix)) invalid.push(name);
  }
  return { env, socket, missing, invalid };
}
