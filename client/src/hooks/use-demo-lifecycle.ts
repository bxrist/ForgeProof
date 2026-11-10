import { useState } from "react";

export interface IllustrationReceipt {
  id: string;
  name: string;
  path: string;
  type: "origin" | "review" | "refactor";
  model: string;
  provider: string;
  origin: string;
  content: string;
  capturedContent: string;
  stage: number;
  parent?: string;
  result?: "match" | "mismatch";
}

const storageKey = "forgeproof.illustration.v1";
const initialReceipts: IllustrationReceipt[] = [
  { id: "illustration-origin", name: "request-policy.ts", path: "src/security/request-policy.ts", type: "origin", model: "Example model A", provider: "Illustrative provider", origin: "UNKNOWN", content: "allowRequest = tenantMatches && authenticated;", capturedContent: "allowRequest = tenantMatches && authenticated;", stage: 0 },
  { id: "illustration-review", name: "request-policy.ts", path: "src/security/request-policy.ts", type: "review", model: "Example model B", provider: "Illustrative provider", origin: "UNKNOWN", content: "review: require a tenant match before access", capturedContent: "review: require a tenant match before access", stage: 0, parent: "illustration-origin" },
  { id: "illustration-refactor", name: "request-policy.ts", path: "src/security/request-policy.ts", type: "refactor", model: "Example model A", provider: "Illustrative provider", origin: "UNKNOWN", content: "allowRequest = authenticated && tenantMatches;", capturedContent: "allowRequest = authenticated && tenantMatches;", stage: 0, parent: "illustration-review" },
];

function loadReceipts(): IllustrationReceipt[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    if (Array.isArray(saved) && saved.length === initialReceipts.length && saved.every((item, index) =>
      item.id === initialReceipts[index].id && typeof item.content === "string" &&
      typeof item.capturedContent === "string" && Number.isInteger(item.stage) && item.stage >= 0 && item.stage <= 3
    )) {
      return initialReceipts.map((receipt, index) => ({
        ...receipt,
        content: saved[index].content,
        capturedContent: saved[index].capturedContent,
        stage: saved[index].stage,
        result: ["match", "mismatch"].includes(saved[index].result) ? saved[index].result : undefined,
      }));
    }
  } catch { /* Storage is optional; the standalone demo still works. */ }
  return initialReceipts.map(receipt => ({ ...receipt }));
}

export function useDemoLifecycle() {
  const [receipts, setReceipts] = useState(loadReceipts);
  const save = (next: IllustrationReceipt[]) => {
    setReceipts(next);
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* In-memory mode. */ }
  };
  const update = (id: string, change: Partial<IllustrationReceipt>) => save(receipts.map(receipt => receipt.id === id ? { ...receipt, ...change } : receipt));
  const advance = (id: string) => {
    const receipt = receipts.find(item => item.id === id);
    if (!receipt) return;
    if (receipt.stage === 0) update(id, { stage: 1, capturedContent: receipt.content, result: undefined });
    else if (receipt.stage === 1) update(id, { stage: 2, result: receipt.content === receipt.capturedContent ? "match" : "mismatch" });
    else if (receipt.stage === 2 && receipt.result === "match") update(id, { stage: 3 });
  };
  return { receipts, update, advance, reset: () => save(initialReceipts.map(receipt => ({ ...receipt }))) };
}

export function illustrationStage(receipt: IllustrationReceipt) {
  return ["Draft example", "Signature simulated", receipt.result === "mismatch" ? "Simulated mismatch" : "Simulated match", "Archive simulated"][receipt.stage];
}
