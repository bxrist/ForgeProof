import { describe, it, expect, vi } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { sourceManifest, parseSourceReference, load } from "../server/sourceManifest";
import { connectorRequest } from "../server/git-store/githubRuntime";
import { computeEntryHash } from "../server/crypto";
import { readFile } from "node:fs/promises";
vi.mock("../server/git-store/githubRuntime", () => ({ connectorRequest: vi.fn() }));

const reference = `github://bxrist/LifeOS/commit/${"a".repeat(40)}/lifeos-source-manifest.json`;
function fixture() {
  const bytes = Buffer.from(JSON.stringify({ schema: "lifeos-source-provenance", version: 1,
    repository: "https://github.com/bxrist/LifeOS", commit: "a".repeat(40),
    files: [{ path: "src/example.ts", sha256: "b".repeat(64) }] }));
  const keys = generateKeyPairSync("ed25519");
  const receipt: any = { filePath: reference, fileHash: createHash("sha256").update(bytes).digest("hex"),
    modelName: "UNSPECIFIED", modelProvider: "UNSPECIFIED", countryOfOrigin: "UNSPECIFIED",
    prevEntryHash: null, createdAt: new Date("2026-11-10T00:00:00.000Z") };
  const timestamp = receipt.createdAt.toISOString();
  receipt.entryHash = computeEntryHash({ ...receipt, timestamp });
  receipt.publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  receipt.signature = sign(null, Buffer.from(`${receipt.entryHash}|${receipt.fileHash}|${timestamp}`), keys.privateKey).toString("base64");
  return { receipt, bytes };
}
describe("source coverage", () => {
  it("serves receipt 51's exact 822-file manifest without GitHub reconstruction or pending", async () => {
    const hash = "a4306dc82296ba73adb6d054906c82d38c4c0cab08c4b70cd2573c17415e3111";
    const bytes = await readFile(`server/evidence/${hash}.json`);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
    const manifest = JSON.parse(bytes.toString());
    expect(manifest.files).toHaveLength(822);
    const { receipt } = fixture();
    receipt.fileHash = hash;
    receipt.filePath = `github://bxrist/LifeOS/commit/${manifest.commit}/lifeos-source-manifest.json`;
    const timestamp = receipt.createdAt.toISOString();
    receipt.entryHash = computeEntryHash({ ...receipt, timestamp });
    const keys = generateKeyPairSync("ed25519");
    receipt.publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    receipt.signature = sign(null, Buffer.from(`${receipt.entryHash}|${hash}|${timestamp}`), keys.privateKey).toString("base64");
    vi.mocked(connectorRequest).mockClear();
    const result = await sourceManifest(receipt);
    expect(result).toMatchObject({ status: "verified", fileCount: 822, manifestHash: hash });
    expect(result).not.toHaveProperty("pending", true);
    expect(connectorRequest).not.toHaveBeenCalled();
  });
  it("returns cold and repeated pending polls without timers, reuses work, then verifies the result", async () => {
    const { receipt, bytes } = fixture();
    let complete!: (response: Response) => void;
    vi.mocked(connectorRequest).mockReset();
    vi.mocked(connectorRequest).mockImplementation(() => new Promise<Response>(resolve => { complete = resolve; }));
    vi.useFakeTimers();
    try {
      const cold = await sourceManifest(receipt);
      expect(cold).toMatchObject({ status: "unavailable", pending: true, files: [] });
      const repeat = await sourceManifest(receipt);
      expect(repeat).toMatchObject({ status: "unavailable", pending: true, files: [] });
      expect(connectorRequest).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      complete(new Response(JSON.stringify({ type: "file", encoding: "base64", size: bytes.length, content: bytes.toString("base64") })));
      // Flush provider/body parsing microtasks without advancing a wait timer.
      await vi.advanceTimersByTimeAsync(0);
      const ready = await sourceManifest(receipt);
      expect(ready.status).toBe("verified");
      expect(ready.files).toEqual([{ path: "src/example.ts", sha256: "b".repeat(64) }]);
      expect(connectorRequest).toHaveBeenCalledTimes(1);
      const invalid = await sourceManifest({ ...receipt, signature: "bad" });
      expect(invalid.status).toBe("unverified");
      expect(invalid.files).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
  it("uses the commit's root tree and hashes exact Git blob bytes when reconstructing", async () => {
    const root = "c".repeat(40), bytes = Buffer.from("example\n");
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    vi.mocked(connectorRequest).mockImplementation(async (path: string) => {
      let data: any;
      if (path.includes("/contents/")) return new Response("{}", { status: 404 });
      if (path.includes("/commits/")) data = { sha: "a".repeat(40), tree: { sha: root } };
      else if (path.includes(`/trees/${root}`)) data = { sha: root, tree: [{ type: "blob", mode: "100644", path: "example.ts", sha: blob, size: bytes.length }] };
      else if (path.includes(`/blobs/${blob}`)) data = { encoding: "base64", content: bytes.toString("base64") };
      else throw new Error("Unexpected source request");
      return new Response(JSON.stringify(data));
    });
    const manifests = await load(parseSourceReference(reference)!);
    expect(manifests).toHaveLength(3);
    for (const manifest of manifests) {
      const parsed = JSON.parse(manifest.toString());
      expect(parsed.tree).toBe(root);
      expect(parsed.files).toEqual([{ path: "example.ts", mode: "100644", git_blob: blob,
        sha256: createHash("sha256").update(bytes).digest("hex") }]);
    }
  });
  it("accepts immutable references and rejects traversal and mutable references", () => {
    expect(parseSourceReference(reference)?.commit).toBe("a".repeat(40));
    for (const path of [reference.replace("a".repeat(40), "main"), reference + "/../secret", "https://evil.test/x"]) expect(parseSourceReference(path)).toBeNull();
  });
  it("returns actual hashes only after exact-byte and signature checks", async () => {
    const { receipt, bytes } = fixture();
    const result = await sourceManifest(receipt, async () => [bytes]);
    expect(result.status).toBe("verified");
    expect(result.files).toEqual([{ path: "src/example.ts", sha256: "b".repeat(64) }]);
    const mismatch = await sourceManifest(receipt, async () => [Buffer.concat([bytes, Buffer.from("\n")])]);
    expect(mismatch.status).toBe("unverified");
    expect(mismatch.files).toEqual([]);
  });
  it("does not fetch or disclose source for invalid signatures and handles missing evidence neutrally", async () => {
    const { receipt } = fixture();
    let called = false;
    const invalid = await sourceManifest({ ...receipt, signature: "bad" }, async () => { called = true; return []; });
    expect(invalid.status).toBe("unverified");
    expect(called).toBe(false);
    const missing = await sourceManifest(receipt, async () => { throw Error("private provider detail"); });
    expect(missing.status).toBe("unavailable");
    expect(JSON.stringify(missing)).not.toContain("private provider detail");
  });
});
