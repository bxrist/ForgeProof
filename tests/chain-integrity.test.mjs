import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { computeEntryHash, verifySignature } from "../server/crypto.ts";
import { getReceiptTimestamp, isReceiptIdQuery } from "../server/receiptTimestamp.ts";
const http = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8").split('app.get("/api/verify/chain"')[1].split('app.get("/api/verify/entry/:id"')[0];
const mcp = readFileSync(new URL("../server/mcp.ts", import.meta.url), "utf8").split("async function handleVerifyChain()")[1].split("async function handleBatchAttest(")[0];
for (const [name, source] of [["HTTP", http], ["MCP", mcp]]) {
  test(name + " fail-closed source predicate", () => {
    assert.match(source, /const hashMatch = !!timestamp && recomputedHash === entry.entryHash;/);
    assert.match(source, /const entryValid = chainValid && signatureValid && hashMatch;/);
  });
}
const keys = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const publicKey = keys.publicKey.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, "");
const timestamp = "2026-11-03T12:00:00.000Z";
const base = { fileHash: "sha256:" + "a".repeat(64), modelName: "unattributed", modelProvider: "unverified", countryOfOrigin: "unknown", prevEntryHash: null, timestamp };
const entryHash = computeEntryHash(base);
const signature = sign(null, Buffer.from(entryHash + "|" + base.fileHash + "|" + timestamp), keys.privateKey).toString("base64");
const receipt = { ...base, entryHash, signature, publicKey };
function valid(r, prev = null) {
  return r.prevEntryHash === prev && computeEntryHash(r) === r.entryHash &&
    verifySignature(r.entryHash + "|" + r.fileHash + "|" + r.timestamp, r.signature, r.publicKey);
}
test("genuine receipt", () => assert.equal(valid(receipt), true));
test("verification uses persisted signedAt when createdAt differs", () => {
  const row = { signedAt: timestamp, createdAt: new Date("2026-11-04T12:00:00.000Z") };
  assert.equal(getReceiptTimestamp(row), timestamp);
  assert.equal(valid({ ...receipt, timestamp: getReceiptTimestamp(row) }), true);
});
test("malformed present signedAt fails closed instead of falling back", () => {
  assert.equal(getReceiptTimestamp({ signedAt: "not-a-time", createdAt: new Date(timestamp) }), null);
  assert.equal(getReceiptTimestamp({ signedAt: "", createdAt: new Date(timestamp) }), null);
});
test("legacy rows fall back to createdAt and missing timestamps fail closed", () => {
  assert.equal(getReceiptTimestamp({ signedAt: null, createdAt: new Date(timestamp) }), timestamp);
  assert.equal(getReceiptTimestamp({ signedAt: null, createdAt: null }), null);
});
test("numeric-prefixed entry hashes are not parsed as receipt IDs", () => {
  assert.equal(isReceiptIdQuery("123"), true);
  assert.equal(isReceiptIdQuery("123abcdef"), false);
  assert.equal(isReceiptIdQuery("12.3"), false);
});
for (const [name, change] of Object.entries({ provider: { modelProvider: "spoofed" }, model: { modelName: "spoofed" }, country: { countryOfOrigin: "XX" }, time: { timestamp: "2026-11-03T12:01:00.000Z" }, file: { fileHash: "sha256:" + "b".repeat(64) }, signature: { signature: "AAAA" }, key: { publicKey: "invalid" }, link: { prevEntryHash: "f".repeat(64) } })) {
  test("reject " + name, () => assert.equal(valid({ ...receipt, ...change }), false));
}
test("reject wrong predecessor", () => assert.equal(valid(receipt, "f".repeat(64)), false));
