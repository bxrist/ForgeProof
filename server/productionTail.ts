import { createHash } from "node:crypto";
import { createLedgerOutboxItem, stableJson, type LedgerReceipt } from "./gitLedger";

export const archivedTail = {
  id: 45,
  entryHash: "a03da30aee480d94958de9b967c99057a59fe36022ed1644d68c2c58991ceea1",
};
export const requestedTail = {
  id: 47,
  entryHash: "f952b2923327564c72ad420765acfb5ba9fd78a0b5e0a33c47ba07a7cc4d0777",
};

// Public evidence only. No database connection, user enrollment, signing or
// baseline updates occur here. Signature validity is recomputed locally.
export function verifyProductionTail(
  rows: Record<string, unknown>[],
  anchor = archivedTail,
  tip = requestedTail,
) {
  if (anchor.id !== 45 || !Number.isSafeInteger(tip.id) || tip.id <= anchor.id ||
      !/^[0-9a-f]{64}$/.test(tip.entryHash)) throw new Error("Unsupported reconciliation range");
  if (!rows.length || rows.length > 1000) throw new Error("Bounded nonempty receipt tail required");
  const receipts: LedgerReceipt[] = [];
  let previous = anchor.entryHash;
  let previousId = anchor.id;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (typeof row.id !== "number" || !Number.isSafeInteger(row.id) ||
        row.id <= previousId || row.id > tip.id) throw new Error("Unexpected receipt ID or order");
    const receipt = createLedgerOutboxItem(row).payload;
    if (receipt.prevEntryHash !== previous) throw new Error("Production tail predecessor mismatch");
    receipts.push(receipt);
    previous = receipt.entryHash;
    previousId = receipt.id;
  }
  if (previousId !== tip.id || previous !== tip.entryHash) throw new Error("Production tip does not match the requested pin");
  const body = {
    version: 1,
    kind: "forgeproof-production-tail",
    archivedTail: anchor,
    currentTail: tip,
    receipts,
  };
  return {
    body,
    digest: createHash("sha256").update(stableJson(body)).digest("hex"),
    receiptSignerPins: Array.from(new Set(receipts.map(receipt =>
      createHash("sha256").update(Buffer.from(receipt.publicKey, "base64")).digest("hex")))),
  };
}

// A read-only observation, not a production write lock. Recheck immediately
// before provider writes; production activation still needs a coordinated freeze.
export function inspectTailSnapshot(chain: any, tip: { id: number; entryHash: string }) {
  if (!Array.isArray(chain?.entries) || chain.chainIntegrity !== true) throw new Error("Production chain unavailable or invalid");
  const entries = [...chain.entries].sort((a, b) => a.id - b.id);
  const latest = entries[entries.length - 1];
  if (latest?.id !== tip.id || latest?.entryHash !== tip.entryHash) throw new Error("Production moved beyond the pinned tip");
  const anchor = entries.filter(row => row.id === archivedTail.id);
  if (anchor.length !== 1 || anchor[0].entryHash !== archivedTail.entryHash) throw new Error("Archived anchor mismatch");
  const tail = entries.filter(row => row.id > archivedTail.id);
  if (!tail.length || tail.length > 1000) throw new Error("Invalid tail size");
  let previous = archivedTail.entryHash;
  let previousId = archivedTail.id;
  for (const row of tail) {
    if (!Number.isSafeInteger(row.id) || row.id <= previousId || row.prevEntryHash !== previous ||
        !/^[0-9a-f]{64}$/.test(row.entryHash)) throw new Error("Tail listing discontinuity");
    previousId = row.id;
    previous = row.entryHash;
  }
  return tail.map(row => ({ id: row.id, entryHash: row.entryHash }));
}
