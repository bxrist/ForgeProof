import { afterEach, describe, expect, it } from "vitest";
import {
  createLedgerOutboxItem,
  getGitLedgerConfig,
  receiptToLedgerRecord,
  stableJson,
} from "../server/gitLedger";
import { enqueueReceiptOutbox } from "../server/receiptOutbox";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("private Git receipt outbox", () => {
  it("is disabled by default and does not touch the database", async () => {
    delete process.env.FORGEPROOF_GIT_LEDGER_ENABLED;
    const client = {
      query: async () => {
        throw new Error("unexpected SQL");
      },
    };
    await expect(enqueueReceiptOutbox(client as any, {})).resolves.toBe("disabled");
  });

  it("uses canonical JSON independent of object insertion order", () => {
    expect(stableJson({ b: 2, a: { y: 1, x: 0 } }))
      .toBe(stableJson({ a: { x: 0, y: 1 }, b: 2 }));
  });

  it("exports only the public signed receipt allowlist", () => {
    const record = receiptToLedgerRecord({
      id: 7,
      file_name: "source.ts",
      file_path: "src/source.ts",
      file_hash: "a".repeat(64),
      entry_hash: "b".repeat(64),
      prev_entry_hash: null,
      signature: "not-a-valid-signature",
      public_key: "not-a-valid-public-key",
      country_of_origin: "US",
      model_name: "test",
      model_provider: "test",
      created_at: new Date("2026-11-09T00:00:00.000Z"),
      signed_at: new Date("2026-11-09T00:00:00.000Z"),
      user_id: "must-not-export",
      org_id: 9,
      metadata: { customer: "must-not-export" },
      audit_details: "must-not-export",
      stripe_customer_id: "must-not-export",
    } as any);

    expect(record.signatureValid).toBe(false);
    expect(record.hashMatch).toBe(false);
    expect(record).not.toHaveProperty("userId");
    expect(record).not.toHaveProperty("orgId");
    expect(record).not.toHaveProperty("metadata");
    expect(record).not.toHaveProperty("auditDetails");
    expect(record).not.toHaveProperty("stripeCustomerId");
  });

  it("rejects a receipt unless its public signature and entry hash verify", () => {
    expect(() => createLedgerOutboxItem({
      id: 7,
      file_name: "source.ts",
      file_path: "src/source.ts",
      file_hash: "a".repeat(64),
      entry_hash: "b".repeat(64),
      prev_entry_hash: null,
      signature: "not-a-valid-signature",
      public_key: "not-a-valid-public-key",
      country_of_origin: "US",
      model_name: "test",
      model_provider: "test",
      created_at: new Date("2026-11-09T00:00:00.000Z"),
      signed_at: new Date("2026-11-09T00:00:00.000Z"),
    })).toThrow("Receipt does not pass signature and hash verification");
  });

  it("fails closed when the enabled ledger has incomplete checkpoint configuration", () => {
    process.env.FORGEPROOF_GIT_LEDGER_ENABLED = "true";
    process.env.FORGEPROOF_GIT_LEDGER_BRANCH = "main";
    expect(() => getGitLedgerConfig()).toThrow("Git ledger branch configuration is invalid");
  });
});
