import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { verifyProductionTail, archivedTail, inspectTailSnapshot } from "../server/productionTail";
import { stableJson } from "../server/gitLedger";
import { getKeyPair, hasPinnedDurableSigner, signData } from "../server/crypto";
import { getGitHubClient } from "../server/github";

async function main() {
  const { values } = parseArgs({ options: {
    origin: { type: "string" }, apply: { type: "boolean", default: false },
    branch: { type: "string" }, "expected-head": { type: "string" },
    "receipt-signer-pin": { type: "string" }, "checkpoint-signer-pin": { type: "string" },
    "tip-id": { type: "string" }, "tip-hash": { type: "string" },
  } });
  // Deliberately cannot target a development or arbitrary caller-supplied host.
  if (values.origin !== "https://forgeproof.flyingcloudtech.com") {
    throw new Error("Explicit verified production origin is required");
  }
  const tip = { id: Number(values["tip-id"]), entryHash: values["tip-hash"] || "" };
  if (!Number.isSafeInteger(tip.id) || tip.id <= 45 || !/^[0-9a-f]{64}$/.test(tip.entryHash)) {
    throw new Error("Explicit current production tip ID and hash required");
  }
  async function snapshot() {
    const response = await fetch(`${values.origin}/api/verify/chain`, {
      redirect: "error", signal: AbortSignal.timeout(15_000), cache: "no-store",
    });
    if (!response.ok) throw new Error("Production chain lookup failed");
    return inspectTailSnapshot(await response.json(), tip);
  }
  const observed = await snapshot();
  async function assertUnchanged() {
    if (stableJson(await snapshot()) !== stableJson(observed)) throw new Error("Production tail changed during reconciliation");
  }
  const rows = [];
  for (const { id, entryHash } of observed) {
    const response = await fetch(`${values.origin}/api/lookup?q=${id}`, {
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Production lookup failed for receipt ${id}`);
    const row = await response.json();
    if (row.id !== id || row.entryHash !== entryHash) throw new Error("Receipt differs from pinned chain snapshot");
    rows.push(row);
  }
  const evidence = verifyProductionTail(rows, archivedTail, tip);
  await assertUnchanged();
  console.log(JSON.stringify({
    mode: values.apply ? "apply-preflight" : "read-only",
    receiptCount: evidence.body.receipts.length,
    archivedReceiptId: 45, currentReceiptId: tip.id,
    signaturesAndLinksValid: true, evidenceDigest: evidence.digest,
    receiptSignerPins: evidence.receiptSignerPins,
    independentlyPinned: false, preservedInGit: false,
  }));
  if (!values.apply) return;
  const hex = /^[0-9a-f]{64}$/;
  if (!hex.test(values["receipt-signer-pin"] || "") ||
      evidence.receiptSignerPins.some(pin => pin !== values["receipt-signer-pin"])) {
    throw new Error("An independently trusted matching receipt signer pin is required");
  }
  if (!hex.test(values["checkpoint-signer-pin"] || "") || !hasPinnedDurableSigner()) {
    throw new Error("Existing durable checkpoint signer and independent signer pin are required; no keys generated");
  }
  const keys = getKeyPair();
  if (createHash("sha256").update(Buffer.from(keys.publicKey, "base64")).digest("hex") !== values["checkpoint-signer-pin"]) {
    throw new Error("Checkpoint signer mismatch");
  }
  const branch = values.branch || "";
  if (!/^forgeproof\/validation\/[A-Za-z0-9_-]+$/.test(branch) ||
      !/^[0-9a-f]{40}$/.test(values["expected-head"] || "")) {
    throw new Error("Existing isolated validation branch and independently pinned head required");
  }
  const github = await getGitHubClient();
  const repo = { owner: "bxrist", repo: "ForgeProof-Evidence" };
  const { data: repository } = await github.repos.get(repo);
  if (!repository.private || repository.id !== 1449691718) throw new Error("Evidence repository identity mismatch");
  const { data: rules } = await github.request("GET /repos/{owner}/{repo}/rules/branches/{branch}", { ...repo, branch });
  if (!rules.some(rule => rule.type === "deletion") || !rules.some(rule => rule.type === "non_fast_forward")) {
    throw new Error("Append-only branch rules required");
  }
  const bundle = { body: evidence.body, digest: evidence.digest,
    checkpointSignerPin: values["checkpoint-signer-pin"],
    signature: signData(stableJson(evidence.body)) };
  const text = stableJson(bundle);
  const path = `ledger/reconciliation/45-${tip.id}.json`;
  const { data: ref } = await github.git.getRef({ ...repo, ref: `heads/${branch}` });
  let existing: any;
  try { existing = (await github.repos.getContent({ ...repo, path, ref: ref.object.sha })).data; }
  catch (error: any) { if (error.status !== 404) throw error; }
  if (existing) {
    if (existing.type !== "file" || Buffer.from(existing.content, "base64").toString("utf8") !== text) {
      throw new Error("Existing evidence conflicts; refusing overwrite");
    }
    await assertUnchanged();
    console.log(JSON.stringify({ preservedInGit: true, replay: true, commit: ref.object.sha, evidenceDigest: evidence.digest }));
    return;
  }
  if (ref.object.sha !== values["expected-head"]) throw new Error("Validation branch moved; refusing write");
  const parent = (await github.git.getCommit({ ...repo, commit_sha: ref.object.sha })).data;
  await assertUnchanged();
  const tree = (await github.git.createTree({ ...repo, base_tree: parent.tree.sha,
    tree: [{ path, mode: "100644", type: "blob", content: text }] })).data;
  const commit = (await github.git.createCommit({ ...repo, message: `Preserve signed production tail through receipt ${tip.id}`,
    tree: tree.sha, parents: [ref.object.sha] })).data;
  await assertUnchanged();
  await github.git.updateRef({ ...repo, ref: `heads/${branch}`, sha: commit.sha, force: false });
  console.log(JSON.stringify({ preservedInGit: true, commit: commit.sha, evidenceDigest: evidence.digest,
    productionBaselineChanged: false }));
}
main().catch(() => { console.error("Reconciliation stopped: preconditions failed; no baseline was advanced. Check secure signer, pins, branch and provider access."); process.exitCode = 1; });
