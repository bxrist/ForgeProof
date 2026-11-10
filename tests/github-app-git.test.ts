import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { GitAppStateService } from "../server/git-store/store.mjs";
import { AppStore, record, unpack } from "../server/githubApp/store";

it("replays additive App records from signed Git without SQL or altering prior records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forgeproof-app-test-"));
  try {
    execFileSync("git", ["init", "--bare", directory], { stdio: "ignore" });
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const settings = { directory, tenant: "fixture", repository: "fixture", checkpoint: null,
      trust: { eventKeys: { fixture: { actor: "fixture", publicKey } }, receiptKeys: [], receiptPredecessor: null },
      signer: { actor: "fixture", keyId: "fixture", sign: async (bytes: Buffer) => sign(null, bytes, keys.privateKey).toString("base64") } };
    const service = new GitAppStateService(settings);
    await service.append({ idempotencyKey: "original-user", operations: [{
      kind: "users", id: "alice", action: "put", expectedVersion: null, record: { id: "alice", firstName: "Original" },
    }] });
    const original = await service.replay();
    const store = new AppStore(service);
    const state = await store.issue("alice", 11, "install");
    await store.transact(() => ({ rows: [record("installation-11-7", "installation", "alice", {
      appId: 11, id: 7, accountId: 99, accountLogin: "sample", status: "active", repositorySelection: "selected",
      repositories: [{ id: 8, fullName: "sample/source" }],
    })], result: undefined }));
    const cold = new GitAppStateService({ ...settings, checkpoint: original.checkpoint });
    await new AppStore(cold).consume(state, "alice", 11, "install");
    const replay = await cold.replay();
    expect(replay.records.users.alice).toEqual(original.records.users.alice);
    expect(replay.events[0]).toEqual(original.events[0]);
    expect(unpack(replay.records.githubApp["installation-11-7"]).repositories[0].id).toBe(8);
    await expect(new AppStore(cold).consume(state, "alice", 11, "install")).rejects.toThrow("Invalid or expired");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30000);
