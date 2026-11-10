import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const state = vi.hoisted(() => ({
  publicKey: Buffer.from("fixture-spki").toString("base64"),
  client: null as any,
}));

vi.mock("../server/github", () => ({
  getGitHubClient: async () => state.client,
}));

vi.mock("../server/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/crypto")>();
  return {
    ...actual,
    hasPinnedDurableSigner: () => true,
    getKeyPair: () => ({ publicKey: state.publicKey, privateKey: "test-only-mock" }),
    signData: (data: string) => Buffer.from(`fixture-signature:${data}`).toString("base64"),
    verifySignature: (data: string, signature: string) =>
      signature === Buffer.from(`fixture-signature:${data}`).toString("base64"),
  };
});

import { appendReceiptToGit, assertLedgerSigner, createLedgerOutboxItem, type GitLedgerConfig, type LedgerOutboxItem } from "../server/gitLedger";
import { computeEntryHash } from "../server/crypto";

const owner = "bxrist";
const repo = "ForgeProof-Evidence";
const branch = "forgeproof/validation/test-ledger";
const baseCommit = "a".repeat(40);
const baseEntryHash = "b".repeat(64);
const signerKeyId = createHash("sha256").update(Buffer.from(state.publicKey, "base64")).digest("hex");
const baseEvent = JSON.stringify({ body: { sequence: 1, repository: "test-ledger" }, signature: "historical" });
const config: GitLedgerConfig = {
  branch,
  repositoryLabel: "test-ledger",
  baseCommit,
  baseEventHash: createHash("sha256").update(baseEvent).digest("hex"),
  baseSequence: 1,
  baseReceiptId: 17,
  baseReceiptEntryHash: baseEntryHash,
  signerKeyId,
};
const item: LedgerOutboxItem = {
  id: 1,
  receiptId: 18,
  eventId: "c".repeat(64),
  payloadHash: "d".repeat(64),
  payload: {
    id: 18,
    fileName: "sample.ts",
    filePath: "src/sample.ts",
    fileHash: "e".repeat(64),
    entryHash: "f".repeat(64),
    prevEntryHash: baseEntryHash,
    signatureValid: true,
    hashMatch: true,
    complianceStatus: "compliant",
    detectedCountry: "US",
    countryOfOrigin: "US",
    modelName: "fixture",
    modelProvider: "fixture",
    signature: "receipt-signature",
    publicKey: "receipt-public-key",
    receiptVersion: "v1",
    createdAt: "2026-11-09T00:00:00.000Z",
    signedAt: "2026-11-09T00:00:00.000Z",
  },
};
item.payload.entryHash = computeEntryHash({
  ...item.payload, timestamp: item.payload.signedAt!,
});
item.payload.signature = Buffer.from(
  `fixture-signature:${item.payload.entryHash}|${item.payload.fileHash}|${item.payload.signedAt}`,
).toString("base64");
Object.assign(item, createLedgerOutboxItem(item.payload), { id: 1 });

function makeGitHubClient() {
  let currentHead = baseCommit;
  const blobs = new Map<string, string>();
  const trees = new Map<string, Array<{ path: string; sha: string }>>();
  const commitChanges = new Map<string, Array<{ path: string; sha: string }>>();
  const commitParents = new Map<string, string[]>();
  const filesByCommit = new Map<string, Map<string, string>>();
  filesByCommit.set(baseCommit, new Map([["event.json", baseEvent]]));
  const getFiles = (ref: string) => filesByCommit.get(ref === branch ? currentHead : ref);
  const missing = () => Object.assign(new Error("Not found"), { status: 404 });
  const shaFor = (value: string) => createHash("sha1").update(value).digest("hex");

  return {
    request: async () => ({ data: [{ type: "deletion" }, { type: "non_fast_forward" }] }),
    repos: {
      get: async () => ({ data: { id: 1449691718, private: true, permissions: { push: true } } }),
      getBranch: async () => ({ data: { protected: true, commit: { sha: currentHead } } }),
      getContent: async ({ path, ref }: { path: string; ref: string }) => {
        const value = getFiles(ref)?.get(path);
        if (value === undefined) throw missing();
        return { data: { type: "file", content: Buffer.from(value).toString("base64"), sha: shaFor(value) } };
      },
    },
    git: {
      getCommit: async ({ commit_sha }: { commit_sha: string }) => ({
        data: { tree: { sha: `tree:${commit_sha}` }, parents: (commitParents.get(commit_sha) || []).map(sha => ({ sha })) },
      }),
      createBlob: async ({ content }: { content: string }) => {
        const sha = shaFor(content);
        blobs.set(sha, content);
        return { data: { sha } };
      },
      createTree: async ({ tree }: { tree: Array<{ path: string; sha: string }> }) => {
        const sha = `tree-${trees.size + 1}`;
        trees.set(sha, tree);
        return { data: { sha } };
      },
      createCommit: async ({ parents, tree }: { parents: string[]; tree: string }) => {
        const sha = `commit-${commitChanges.size + 1}`;
        commitChanges.set(sha, trees.get(tree) || []);
        commitParents.set(sha, parents);
        return { data: { sha, parents } };
      },
      updateRef: async ({ sha, force }: { sha: string; force: boolean }) => {
        if (force !== false) throw new Error("force update forbidden");
        const prior = filesByCommit.get(currentHead) || new Map();
        const next = new Map(prior);
        for (const change of commitChanges.get(sha) || []) {
          const content = blobs.get(change.sha);
          if (content !== undefined) next.set(change.path, content);
        }
        filesByCommit.set(sha, next);
        currentHead = sha;
        return { data: { object: { sha } } };
      },
    },
  };
}

describe("signed private Git receipt append", () => {
  it("rejects staging reuse of the pinned historical production signer", () => {
    vi.stubEnv("FORGEPROOF_ISOLATED_STAGING", "true");
    try {
      expect(() => assertLedgerSigner({ ...config, receiptSignerPin: signerKeyId })).toThrow("must not reuse");
      expect(() => assertLedgerSigner({ ...config, receiptSignerPin: "0".repeat(64) })).not.toThrow();
    } finally { vi.unstubAllEnvs(); }
  });
  beforeEach(() => {
    state.client = makeGitHubClient();
  });

  it("appends a signed event and checkpoint with a non-force ref update", async () => {
    const next = await appendReceiptToGit(item, config, null);
    expect(next.sequence).toBe(2);
    expect(next.receiptEntryHash).toBe(item.payload.entryHash);
    expect(next.commitSha).toMatch(/^commit-/);
  });

  it("recognizes a Git commit made before a database acknowledgement", async () => {
    const first = await appendReceiptToGit(item, config, null);
    const baseline = {
      baseReceiptId: config.baseReceiptId,
      sequence: config.baseSequence,
      eventHash: config.baseEventHash,
      receiptEntryHash: config.baseReceiptEntryHash,
      commitSha: config.baseCommit,
      signerKeyId: config.signerKeyId,
    };
    const recovered = await appendReceiptToGit(item, config, baseline);
    expect(recovered).toEqual(first);
  });

  it("recovers the first append when no SQL checkpoint was committed", async () => {
    const first = await appendReceiptToGit(item, config, null);
    expect(await appendReceiptToGit(item, config, null)).toEqual(first);
  });

  it("rejects a changed durable payload before touching Git", async () => {
    await expect(appendReceiptToGit({ ...item, payloadHash: "0".repeat(64) }, config, null))
      .rejects.toMatchObject({ code: "outbox_conflict" });
  });

  it("blocks a receipt whose predecessor does not match the checkpoint", async () => {
    const payload = { ...item.payload, prevEntryHash: "0".repeat(64) };
    payload.entryHash = computeEntryHash({ ...payload, timestamp: payload.signedAt! });
    payload.signature = Buffer.from(`fixture-signature:${payload.entryHash}|${payload.fileHash}|${payload.signedAt}`).toString("base64");
    const badItem = createLedgerOutboxItem(payload);
    await expect(appendReceiptToGit(badItem, config, null))
      .rejects.toMatchObject({ code: "receipt_gap" });
  });
});
