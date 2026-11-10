import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testDir: string;
beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "forgeproof-signer-"));
  vi.spyOn(process, "cwd").mockReturnValue(testDir);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("FORGEPROOF_ED25519_PRIVATE_KEY_PEM", "");
  vi.stubEnv("FORGEPROOF_ED25519_PUBLIC_KEY_PIN", "");
  vi.stubEnv("FORGEPROOF_STAGING_SIGNER_PRIVATE_KEY_PEM", "");
  vi.stubEnv("FORGEPROOF_STAGING_SIGNER_PUBLIC_KEY_PIN", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(testDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetModules();
});

function pair() {
  return generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

const pin = (pem: string) => pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, "");

describe("durable signer pin", () => {
  it("validates current env independently after a legacy signer is cached", async () => {
    vi.stubEnv("FORGEPROOF_ED25519_PRIVATE_KEY_PEM", "");
    vi.stubEnv("FORGEPROOF_ED25519_PUBLIC_KEY_PIN", "");
    const crypto = await import("../server/crypto");
    const cached = crypto.getKeyPair();
    vi.stubEnv("FORGEPROOF_ED25519_PRIVATE_KEY_PEM", cached.privateKey);
    vi.stubEnv("FORGEPROOF_ED25519_PUBLIC_KEY_PIN", cached.publicKey);
    expect(crypto.hasPinnedDurableSigner()).toBe(true);
    const other = pair();
    vi.stubEnv("FORGEPROOF_ED25519_PRIVATE_KEY_PEM", other.privateKey);
    vi.stubEnv("FORGEPROOF_ED25519_PUBLIC_KEY_PIN", pin(other.publicKey));
    expect(() => crypto.hasPinnedDurableSigner()).toThrow(/cached signer/);
  });

  it("fails closed for absent partial, malformed, and mismatched pins while preserving no-env legacy mode", async () => {
    vi.stubEnv("FORGEPROOF_ED25519_PRIVATE_KEY_PEM", "");
    vi.stubEnv("FORGEPROOF_ED25519_PUBLIC_KEY_PIN", "");
    const crypto = await import("../server/crypto");
    expect(crypto.hasPinnedDurableSigner()).toBe(false);
    const keys = pair();
    vi.stubEnv("FORGEPROOF_ED25519_PRIVATE_KEY_PEM", keys.privateKey);
    expect(() => crypto.hasPinnedDurableSigner()).toThrow(/requires both/);
    vi.stubEnv("FORGEPROOF_ED25519_PUBLIC_KEY_PIN", "bad");
    expect(() => crypto.hasPinnedDurableSigner()).toThrow(/does not match/);
    vi.stubEnv("FORGEPROOF_ED25519_PRIVATE_KEY_PEM", "bad pem");
    expect(() => crypto.hasPinnedDurableSigner()).toThrow();
  });
});


describe("production signer", () => {
  function configure(keys = pair()) {
    vi.stubEnv("FORGEPROOF_ED25519_PRIVATE_KEY_PEM", keys.privateKey);
    vi.stubEnv("FORGEPROOF_ED25519_PUBLIC_KEY_PIN", pin(keys.publicKey));
    return keys;
  }

  it.each([[false, false], [true, false], [true, true]])("signs with an escaped synthetic PEM (trailing LF: %s, wrapped body: %s)", async (trailingLf, wrapped) => {
    vi.stubEnv("NODE_ENV", "production");
    const keys = configure();
    const pem = wrapped ? keys.privateKey.replace(/([A-Za-z0-9+/]{32})/, "$1\n") : keys.privateKey;
    const encoded = pem.trimEnd().replace(/\n/g, "\\n") + (trailingLf ? "\\n" : "");
    vi.stubEnv("FORGEPROOF_ED25519_PRIVATE_KEY_PEM", encoded);
    const crypto = await import("../server/crypto");
    expect(crypto.hasPinnedDurableSigner()).toBe(true);
    const cached = crypto.getKeyPair();
    expect(cached.privateKey).toBe(encoded.replace(/\\n/g, "\n"));
    expect(cached.publicKey).toBe(pin(keys.publicKey));
    const signature = crypto.signData("synthetic deployment input");
    expect(crypto.verifySignature("synthetic deployment input", signature, cached.publicKey)).toBe(true);
    expect(crypto.verifySignature("changed payload", signature, cached.publicKey)).toBe(false);
    // Literal PEM and escaped PEM represent the same signer.
    configure(keys);
    expect(crypto.getKeyPair()).toBe(cached);
    expect(crypto.hasPinnedDurableSigner()).toBe(true);
    expect(existsSync(join(testDir, ".keys"))).toBe(false);
  });

  const malformedEscapes = [
    ["CRLF escapes", (pem: string) => pem.replace(/\n/g, "\\r\\n")],
    ["double escapes", (pem: string) => pem.replace(/\n/g, "\\\\n")],
    ["mixed literal LF", (pem: string) => pem.replace("\n", "\\n")],
    ["trailing literal LF", (pem: string) => pem.replace(/\n/g, "\\n") + "\n"],
    ["JSON quotes", (pem: string) => JSON.stringify(pem)],
    ["truncated footer", (pem: string) => pem.replace(/\n/g, "\\n").slice(0, -10)],
    ["truncated body", () => "-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----"],
    ["invalid base64", (pem: string) => pem.replace(/\n/g, "\\n").replace("\\n", "\\n!")],
    ["oversized body", () => `-----BEGIN PRIVATE KEY-----\\n${"A".repeat(1024)}\\n-----END PRIVATE KEY-----`],
  ] as const;

  it.each(malformedEscapes)("rejects %s before fallback or cache reuse", async (_label, malformed) => {
    vi.stubEnv("NODE_ENV", "production");
    const keys = configure();
    const crypto = await import("../server/crypto");
    for (const cached of [false, true]) {
      if (cached) {
        configure(keys);
        crypto.getKeyPair();
      }
      vi.stubEnv("FORGEPROOF_ED25519_PRIVATE_KEY_PEM", malformed(keys.privateKey));
      expect(() => crypto.getKeyPair()).toThrow(/Invalid escaped/);
      expect(() => crypto.hasPinnedDurableSigner()).toThrow(/Invalid escaped/);
      expect(() => crypto.signData("must not sign")).toThrow(/Invalid escaped/);
      expect(existsSync(join(testDir, ".keys"))).toBe(false);
    }
  });

  it("checks the independent pin and cached identity for escaped PEMs", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const keys = configure();
    vi.stubEnv("FORGEPROOF_ED25519_PRIVATE_KEY_PEM", keys.privateKey.replace(/\n/g, "\\n"));
    const crypto = await import("../server/crypto");
    vi.stubEnv("FORGEPROOF_ED25519_PUBLIC_KEY_PIN", pin(pair().publicKey));
    expect(() => crypto.getKeyPair()).toThrow(/does not match/);
    expect(() => crypto.hasPinnedDurableSigner()).toThrow(/does not match/);
    vi.stubEnv("FORGEPROOF_ED25519_PUBLIC_KEY_PIN", pin(keys.publicKey));
    crypto.getKeyPair();
    vi.stubEnv("FORGEPROOF_ED25519_PUBLIC_KEY_PIN", "bad");
    expect(() => crypto.getKeyPair()).toThrow(/does not match/);
    expect(() => crypto.hasPinnedDurableSigner()).toThrow(/does not match/);
    const other = configure();
    vi.stubEnv("FORGEPROOF_ED25519_PRIVATE_KEY_PEM", other.privateKey.replace(/\n/g, "\\n"));
    expect(() => crypto.getKeyPair()).toThrow(/cached signer/);
    expect(() => crypto.hasPinnedDurableSigner()).toThrow(/cached signer/);
    expect(existsSync(join(testDir, ".keys"))).toBe(false);
  });

  it.each([false, true])("rejects absent env with local files present: %s", async (withFiles) => {
    vi.stubEnv("NODE_ENV", "production");
    if (withFiles) {
      const keys = pair();
      mkdirSync(join(testDir, ".keys"));
      writeFileSync(join(testDir, ".keys/ed25519_private.pem"), keys.privateKey);
      writeFileSync(join(testDir, ".keys/ed25519_public.pem"), keys.publicKey);
    }
    const crypto = await import("../server/crypto");
    expect(() => crypto.getKeyPair()).toThrow(/Production.*requires both/);
    expect(existsSync(join(testDir, ".keys"))).toBe(withFiles);
  });

  it("cannot reuse a development file signer after entering production", async () => {
    const crypto = await import("../server/crypto");
    crypto.getKeyPair();
    vi.stubEnv("NODE_ENV", "production");
    expect(() => crypto.getKeyPair()).toThrow(/Production.*requires both/);
  });

  it.each(["private", "public"])("rejects partial %s configuration", async (setting) => {
    vi.stubEnv("NODE_ENV", "production");
    const keys = pair();
    if (setting === "private") vi.stubEnv("FORGEPROOF_ED25519_PRIVATE_KEY_PEM", keys.privateKey);
    else vi.stubEnv("FORGEPROOF_ED25519_PUBLIC_KEY_PIN", pin(keys.publicKey));
    const crypto = await import("../server/crypto");
    expect(() => crypto.getKeyPair()).toThrow(/requires both/);
    expect(existsSync(join(testDir, ".keys"))).toBe(false);
  });

  it("validates each call before returning a matching cached signer", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const keys = configure();
    const crypto = await import("../server/crypto");
    const cached = crypto.getKeyPair();
    expect(cached.publicKey).toBe(pin(keys.publicKey));
    expect(crypto.getKeyPair()).toBe(cached);
    expect(crypto.hasPinnedDurableSigner()).toBe(true);
    for (const badPin of ["bad", pin(pair().publicKey)]) {
      vi.stubEnv("FORGEPROOF_ED25519_PUBLIC_KEY_PIN", badPin);
      expect(() => crypto.getKeyPair()).toThrow(/does not match/);
    }
    configure(keys);
    vi.stubEnv("FORGEPROOF_ED25519_PRIVATE_KEY_PEM", "bad pem");
    expect(() => crypto.getKeyPair()).toThrow();
    configure();
    expect(() => crypto.getKeyPair()).toThrow(/cached signer/);
    configure(keys);
    vi.stubEnv("FORGEPROOF_ED25519_PRIVATE_KEY_PEM", "");
    expect(() => crypto.getKeyPair()).toThrow(/requires both/);
    vi.stubEnv("FORGEPROOF_ED25519_PUBLIC_KEY_PIN", "");
    expect(() => crypto.getKeyPair()).toThrow(/requires both/);
    expect(crypto.hasPinnedDurableSigner()).toBe(false);
    expect(existsSync(join(testDir, ".keys"))).toBe(false);
  });

  it("rejects a non-Ed25519 signer", async () => {
    vi.stubEnv("NODE_ENV", "production");
    configure(generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    }));
    const crypto = await import("../server/crypto");
    expect(() => crypto.getKeyPair()).toThrow(/must be Ed25519/);
    expect(existsSync(join(testDir, ".keys"))).toBe(false);
  });
});

describe("production signer secret fallback", () => {
  it("uses the existing production signer pair stored as single-line PEM", async () => {
    const keys = pair();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FORGEPROOF_STAGING_SIGNER_PRIVATE_KEY_PEM", keys.privateKey.trim().replace(/\n/g, " "));
    vi.stubEnv("FORGEPROOF_STAGING_SIGNER_PUBLIC_KEY_PIN", keys.publicKey);
    const { getKeyPair } = await import("../server/crypto");
    expect(getKeyPair().publicKey).toBe(keys.publicKey.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, ""));
  });
  it("never borrows that pair outside production", async () => {
    const keys = pair();
    vi.stubEnv("FORGEPROOF_STAGING_SIGNER_PRIVATE_KEY_PEM", keys.privateKey);
    vi.stubEnv("FORGEPROOF_STAGING_SIGNER_PUBLIC_KEY_PIN", keys.publicKey);
    const { getKeyPair } = await import("../server/crypto");
    expect(getKeyPair().publicKey).not.toBe(keys.publicKey.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, ""));
  });
});
