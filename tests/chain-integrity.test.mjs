import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { computeEntryHash, verifySignature, getReceiptSigningTimestamp } from "../server/crypto.ts";
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
test("historic signedAt is canonical even when createdAt differs", () => {
  const persisted = { ...receipt, signedAt: timestamp, createdAt: new Date("2026-11-04T12:00:00.000Z") };
  assert.equal(getReceiptSigningTimestamp(persisted), timestamp);
  assert.equal(valid({ ...persisted, timestamp: getReceiptSigningTimestamp(persisted) }), true);
});
test("createdAt is only a valid legacy fallback", () => {
  assert.equal(getReceiptSigningTimestamp({ createdAt: new Date(timestamp) }), timestamp);
  assert.equal(getReceiptSigningTimestamp({ signedAt: "not a timestamp", createdAt: "invalid" }), "");
  assert.equal(getReceiptSigningTimestamp({ signedAt: "not a timestamp", createdAt: timestamp }), "");
  assert.equal(getReceiptSigningTimestamp({ signedAt: "", createdAt: timestamp }), "");
});
test("self-reported public key verifies math but is not a trusted pin", () => {
  const other = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const otherPublic = other.publicKey.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, "");
  assert.equal(valid(receipt), true);
  assert.equal(verifySignature(entryHash + "|" + base.fileHash + "|" + timestamp, signature, otherPublic), false);
});
const lookup = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8").split('app.get("/api/lookup"')[1].split("// ─── Analytics")[0];
const exportRoute = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8").split('app.get("/api/receipt/:id/export"')[1];
test("HTTP lookup and export use the canonical fail-closed signing timestamp", () => {
  assert.match(lookup, /getReceiptSigningTimestamp\(entry\)/);
  assert.match(lookup, /signedAt: entry\.signedAt/);
  assert.match(lookup, /hashMatch: !!timestamp/);
  assert.match(exportRoute, /getReceiptSigningTimestamp\(entry\)/);
  assert.match(exportRoute, /const hashMatch = !!timestamp/);
});
test("HTTP lookup only parses strict decimal IDs, preserving full hash lookup", () => {
  assert.match(lookup, /const idNum = \/\^\\d\+\$\/.test\(q\) \? Number\(q\) : NaN;/);
  assert.match(lookup, /storage\.getAttestationByEntryHash\(q\)/);
  assert.ok(lookup.indexOf("/^\\d+$/.test(q)") < lookup.indexOf("storage.getAttestationByEntryHash(q)"));
});
for (const [name, change] of Object.entries({ provider: { modelProvider: "spoofed" }, model: { modelName: "spoofed" }, country: { countryOfOrigin: "XX" }, time: { timestamp: "2026-11-03T12:01:00.000Z" }, file: { fileHash: "sha256:" + "b".repeat(64) }, signature: { signature: "AAAA" }, key: { publicKey: "invalid" }, link: { prevEntryHash: "f".repeat(64) } })) {
  test("reject " + name, () => assert.equal(valid({ ...receipt, ...change }), false));
}
test("reject wrong predecessor", () => assert.equal(valid(receipt, "f".repeat(64)), false));
