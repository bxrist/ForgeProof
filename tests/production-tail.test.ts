import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { computeEntryHash } from "../server/crypto";
import * as cryptoModule from "../server/crypto";
import { validateReconciledTail, stableJson, type GitLedgerConfig } from "../server/gitLedger";
import { verifyProductionTail, inspectTailSnapshot, archivedTail } from "../server/productionTail";

// Ephemeral cryptographic fixtures only; never users, database rows or Git writes.
const keys = generateKeyPairSync("ed25519");
const anchor = { id: 45, entryHash: "a".repeat(64) };
function receipt(id: number, previous: string) {
  const timestamp = "2026-11-09T00:00:00.000Z";
  const fields = { fileHash: "b".repeat(64), modelName: "test", modelProvider: "test",
    countryOfOrigin: "UNSPECIFIED", prevEntryHash: previous, timestamp };
  const entryHash = computeEntryHash(fields);
  return { id, ...fields, entryHash, signedAt: timestamp, createdAt: timestamp,
    publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    signature: sign(null, Buffer.from(`${entryHash}|${fields.fileHash}|${timestamp}`), keys.privateKey).toString("base64") };
}
const first = receipt(46, anchor.entryHash);
const second = receipt(47, first.entryHash);
const tip = { id: 47, entryHash: second.entryHash };
describe("bounded production-tail reconciliation", () => {
  it("preserves both existing signatures and computes a deterministic evidence digest", () => {
    const result = verifyProductionTail([first, second], anchor, tip);
    expect(result.body.receipts.map(row => row.signature)).toEqual([first.signature, second.signature]);
    expect(result.digest).toBe(verifyProductionTail([first, second], anchor, tip).digest);
  });
  it("rejects missing or reordered receipts", () => {
    expect(() => verifyProductionTail([second], anchor, tip)).toThrow();
    expect(() => verifyProductionTail([second, first], anchor, tip)).toThrow();
  });
  it("rejects substituted signatures even if the server claims validity", () => {
    expect(() => verifyProductionTail([{ ...first, signature: second.signature, signatureValid: true }, second], anchor, tip)).toThrow();
  });
  it("rejects a different independently pinned tip or predecessor", () => {
    expect(() => verifyProductionTail([first, second], anchor, { ...tip, entryHash: "c".repeat(64) })).toThrow();
    expect(() => verifyProductionTail([first, second], { ...anchor, entryHash: "d".repeat(64) }, tip)).toThrow();
  });
  it("excludes tenant and private metadata from the evidence bundle", () => {
    const result = verifyProductionTail([{ ...first, userId: "not-exported", metadata: { token: "not-exported" } }, second], anchor, tip);
    expect(JSON.stringify(result)).not.toContain("not-exported");
  });
  it("preserves later evidence and permits sequence-ID gaps only with continuous hashes", () => {
    const third = receipt(50, second.entryHash);
    expect(verifyProductionTail([first, second, third], anchor, { id: 50, entryHash: third.entryHash }).body.receipts).toHaveLength(3);
    expect(() => verifyProductionTail([first, third], anchor, { id: 50, entryHash: third.entryHash })).toThrow();
  });
  it("rejects stale production-tip pins and duplicate listing IDs", () => {
    const a = receipt(46, archivedTail.entryHash);
    const b = receipt(50, a.entryHash);
    const current = { id: b.id, entryHash: b.entryHash };
    const chain = { chainIntegrity: true, entries: [archivedTail, a, b] };
    expect(inspectTailSnapshot(chain, current).map(row => row.id)).toEqual([46, 50]);
    expect(() => inspectTailSnapshot(chain, { id: a.id, entryHash: a.entryHash })).toThrow();
    expect(() => inspectTailSnapshot({ ...chain, entries: [archivedTail, a, a, b] }, current)).toThrow();
    expect(() => inspectTailSnapshot({ ...chain, chainIntegrity: false }, current)).toThrow();
  });
  it("requires preserved evidence and independent pins before accepting an advanced runtime base", async () => {
    const a = receipt(46, archivedTail.entryHash);
    const b = receipt(50, a.entryHash);
    const current = { id: b.id, entryHash: b.entryHash };
    const evidence = verifyProductionTail([a, b], archivedTail, current);
    const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const pin = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");
    const spy = vi.spyOn(cryptoModule, "getKeyPair").mockReturnValue({ publicKey, privateKey: "unused-test-only" });
    try {
      const bundle = { body: evidence.body, digest: evidence.digest, checkpointSignerPin: pin,
        signature: sign(null, Buffer.from(stableJson(evidence.body)), keys.privateKey).toString("base64") };
      const config = { baseReceiptId: 50, baseReceiptEntryHash: b.entryHash, reconciliationDigest: evidence.digest,
        receiptSignerPin: pin, signerKeyId: pin } as GitLedgerConfig;
      await expect(validateReconciledTail(stableJson(bundle), config)).resolves.toBeUndefined();
      const independentWriter = generateKeyPairSync("ed25519");
      const writerPublic = independentWriter.publicKey.export({ type: "spki", format: "der" }).toString("base64");
      spy.mockReturnValue({ publicKey: writerPublic, privateKey: "unused-test-only" });
      const isolatedConfig = { ...config,
        signerKeyId: createHash("sha256").update(Buffer.from(writerPublic, "base64")).digest("hex"),
        reconciliationSignerPublicKey: publicKey };
      await expect(validateReconciledTail(stableJson(bundle), isolatedConfig)).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
      await expect(validateReconciledTail(stableJson(bundle), {
        ...isolatedConfig, reconciliationSignerPublicKey: writerPublic,
      })).rejects.toThrow();
      await expect(validateReconciledTail(stableJson(bundle), { ...isolatedConfig,
        reconciliationSignerPublicKey: "not-a-public-key",
      })).rejects.toThrow();
      spy.mockReturnValue({ publicKey, privateKey: "unused-test-only" });
      await expect(validateReconciledTail(stableJson(bundle), { ...config, reconciliationDigest: "0".repeat(64) })).rejects.toThrow();
      await expect(validateReconciledTail(stableJson(bundle), { ...config, receiptSignerPin: "0".repeat(64) })).rejects.toThrow();
      await expect(validateReconciledTail(stableJson({ ...bundle, body: { ...bundle.body, receipts: [b] } }), config)).rejects.toThrow();
      await expect(validateReconciledTail(stableJson({ ...bundle, signature: a.signature }), config)).rejects.toThrow();
    } finally { spy.mockRestore(); }
  });
});
