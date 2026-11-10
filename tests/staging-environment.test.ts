import { describe, expect, it } from "vitest";
import { prepareStagingEnvironment } from "../server/stagingEnvironment";
import { parse } from "pg-connection-string";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { forbiddenStagingSigner, ORIGINAL_PRODUCTION_SIGNER_PIN, publicSignerFingerprint } from "../server/stagingSignerPolicy";

describe("isolated staging process configuration", () => {
  it("rejects the original production SPKI even if receipt trust is changed or absent", () => {
    // Public verification material only; no production private key in fixtures.
    const publicKey = "MCowBQYDK2VwAyEAGsyKIv7Pnfz3m1/GPIx/lTyLZ1XDdVxtHtysS+revqE=";
    expect(publicSignerFingerprint(publicKey)).toBe(ORIGINAL_PRODUCTION_SIGNER_PIN);
    for (const trust of [undefined, "0".repeat(64)]) {
      expect(forbiddenStagingSigner(ORIGINAL_PRODUCTION_SIGNER_PIN, trust)).toBe(true);
      expect(prepareStagingEnvironment({
        FORGEPROOF_STAGING_SIGNER_PUBLIC_KEY_PIN: publicKey,
        FORGEPROOF_STAGING_RECEIPT_SIGNER_PIN: trust,
      }, "/isolated").invalid).toContain("FORGEPROOF_ED25519_PUBLIC_KEY_PIN");
    }
    const { publicKey: distinct } = generateKeyPairSync("ed25519");
    const separatePin = distinct.export({ type: "spki", format: "pem" }).toString();
    expect(forbiddenStagingSigner(publicSignerFingerprint(separatePin), ORIGINAL_PRODUCTION_SIGNER_PIN)).toBe(false);
    expect(prepareStagingEnvironment({
      FORGEPROOF_STAGING_SIGNER_PUBLIC_KEY_PIN: separatePin,
      FORGEPROOF_STAGING_RECEIPT_SIGNER_PIN: ORIGINAL_PRODUCTION_SIGNER_PIN,
    }, "/isolated").invalid).not.toContain("FORGEPROOF_ED25519_PUBLIC_KEY_PIN");
  });
  it("restores flattened PKCS8 framing without replacing the key or changing the source", () => {
    const pair = generateKeyPairSync("ed25519");
    const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const flat = pem.replace(/\n/g, "");
    const source = { FORGEPROOF_STAGING_SIGNER_PRIVATE_KEY_PEM: flat };
    const { env } = prepareStagingEnvironment(source, "/isolated");
    const key = createPrivateKey(env.FORGEPROOF_ED25519_PRIVATE_KEY_PEM!);
    expect(key.asymmetricKeyType).toBe("ed25519");
    expect(createPublicKey(key).export({ type: "spki", format: "der" }))
      .toEqual(pair.publicKey.export({ type: "spki", format: "der" }));
    expect(source.FORGEPROOF_STAGING_SIGNER_PRIVATE_KEY_PEM).toBe(flat);
    for (const unchanged of [pem, pem.replace(/\n/g, "\\n"), "not-a-key",
      `-----BEGIN PRIVATE KEY-----${"A".repeat(1024)}-----END PRIVATE KEY-----`]) {
      expect(prepareStagingEnvironment({ FORGEPROOF_STAGING_SIGNER_PRIVATE_KEY_PEM: unchanged }, "/isolated")
        .env.FORGEPROOF_ED25519_PRIVATE_KEY_PEM).toBe(unchanged);
    }
  });
  it("maps staging aliases without mutating the parent's environment", () => {
    const source = { DATABASE_URL: "do-not-use", FORGEPROOF_STAGING_SIGNER_PRIVATE_KEY_PEM: "fixture",
      FORGEPROOF_STAGING_SIGNER_PUBLIC_KEY_PIN: "public-fixture", FORGEPROOF_STAGING_RECEIPT_SIGNER_PIN: "pin" };
    const { env } = prepareStagingEnvironment(source, "/isolated");
    expect(env.FORGEPROOF_ED25519_PRIVATE_KEY_PEM).toBe("fixture");
    expect(env.FORGEPROOF_ED25519_PUBLIC_KEY_PIN).toBe("public-fixture");
    expect(env.FORGEPROOF_GIT_LEDGER_RECEIPT_SIGNER_PIN).toBe("pin");
    expect(env.DATABASE_URL).not.toContain("do-not-use");
    expect(source.DATABASE_URL).toBe("do-not-use");
    const parsed = parse(env.DATABASE_URL!);
    expect(parsed.host).toBe("/isolated/generated-artifacts/0b-staging-pg/socket");
    expect(parsed.database).toBe("forgeproof_0b_staging");
    expect(parsed.user).toBe("runner");
    expect(parsed.port).toBe("55439");
  });
  it("rejects live provider credentials and a non-staging Git branch", () => {
    const result = prepareStagingEnvironment({ STRIPE_SECRET_KEY: "sk_live_fixture",
      CLERK_SECRET_KEY: "sk_live_fixture", FORGEPROOF_GIT_LEDGER_BRANCH: "forgeproof/main" }, "/isolated");
    expect(result.invalid).toEqual(expect.arrayContaining(["CLERK_SECRET_KEY", "FORGEPROOF_GIT_LEDGER_BRANCH"]));
    expect(result.env.STRIPE_SECRET_KEY).toBe("");
    expect(result.missing).toContain("STRIPE_SECRET_KEY");
  });
  it("rejects an explicit staging live Stripe key instead of using an inherited test key", () => {
    const { invalid, env } = prepareStagingEnvironment({
      FORGEPROOF_STAGING_STRIPE_SECRET_KEY: "sk_live_fixture",
      STRIPE_SECRET_KEY: "sk_test_inherited",
    }, "/isolated");
    expect(invalid).toContain("STRIPE_SECRET_KEY");
    expect(env.STRIPE_SECRET_KEY).not.toBe("sk_test_inherited");
  });
  it("isolates a dedicated staging test key from unrelated inherited live credentials", () => {
    const source = {
      FORGEPROOF_STAGING_STRIPE_SECRET_KEY: "sk_test_dedicated",
      STRIPE_SECRET_KEY: "sk_live_inherited",
      FORGEPROOF_LIVE_STRIPE_SECRET_KEY: "sk_live_commercial",
    };
    const { env, invalid, missing } = prepareStagingEnvironment(source, "/isolated");
    expect(env.STRIPE_SECRET_KEY).toBe("sk_test_dedicated");
    expect(env.FORGEPROOF_LIVE_STRIPE_SECRET_KEY).toBeUndefined();
    expect(invalid).not.toContain("STRIPE_SECRET_KEY");
    expect(missing).not.toContain("STRIPE_SECRET_KEY");
    expect(source.STRIPE_SECRET_KEY).toBe("sk_live_inherited");
  });
  it("does not borrow live billing, SMTP, or LifeOS approval configuration", () => {
    const { env } = prepareStagingEnvironment({ FORGEPROOF_LIVE_STRIPE_SECRET_KEY: "never",
      SMTP_PASS: "never", SMTP_HOST: "never", LIFEOS_OWNER_APPROVAL_JSON: "never", PGHOST: "never" }, "/isolated");
    expect(env.FORGEPROOF_LIVE_STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.PGHOST).toBeUndefined();
    expect(env.SMTP_PASS).toBe("");
    expect(env.LIFEOS_OWNER_APPROVAL_JSON).toBe("");
    expect(env.FORGEPROOF_STRIPE_MODE).toBe("sandbox");
    expect(env.PORT).toBe("5001");
  });
  it("reports missing credentials instead of manufacturing a signer or pins", () => {
    const { missing } = prepareStagingEnvironment({}, "/isolated");
    expect(missing).toContain("FORGEPROOF_ED25519_PRIVATE_KEY_PEM");
    expect(missing).toContain("FORGEPROOF_GIT_LEDGER_RECONCILIATION_DIGEST");
  });
  it("never borrows a live signing identity or even an existing test Stripe key", () => {
    const source = {
      FORGEPROOF_ED25519_PRIVATE_KEY_PEM: "LIVE_SIGNER_MUST_NOT_ESCAPE",
      FORGEPROOF_ED25519_PUBLIC_KEY_PIN: "LIVE_PUBLIC_PIN",
      FORGEPROOF_GIT_LEDGER_RECEIPT_SIGNER_PIN: "LIVE_RECEIPT_PIN",
      STRIPE_SECRET_KEY: "sk_test_existing_customer_account",
    };
    const { env, missing } = prepareStagingEnvironment(source, "/isolated");
    expect(env.FORGEPROOF_ED25519_PRIVATE_KEY_PEM).toBeUndefined();
    expect(env.FORGEPROOF_ED25519_PUBLIC_KEY_PIN).toBeUndefined();
    expect(env.FORGEPROOF_GIT_LEDGER_RECEIPT_SIGNER_PIN).toBeUndefined();
    expect(env.STRIPE_SECRET_KEY).toBe("");
    expect(missing).toContain("FORGEPROOF_ED25519_PRIVATE_KEY_PEM");
    expect(missing).toContain("FORGEPROOF_ED25519_PUBLIC_KEY_PIN");
  });

});
