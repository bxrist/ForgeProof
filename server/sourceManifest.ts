import { createHash } from "node:crypto";
import { connectorRequest } from "./git-store/githubRuntime";
import { computeEntryHash, verifySignature } from "./crypto";
import { getReceiptTimestamp } from "./receiptTimestamp";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export function parseSourceReference(value: string) {
  const m = /^github:\/\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)\/commit\/([a-f0-9]{40})\/(.+)$/.exec(value);
  if (!m || m[4].split("/").some(p => !p || p === "." || p === "..") || /[\\?#\x00-\x1f]/.test(m[4])) return null;
  const [, owner, repo, commit, path] = m;
  const commitUrl = `https://github.com/${owner}/${repo}/commit/${commit}`;
  return { owner, repo, commit, path, commitUrl, url: `https://github.com/${owner}/${repo}/blob/${commit}/${path.split("/").map(encodeURIComponent).join("/")}` };
}
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value: any): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}` : JSON.stringify(value);
type Source = NonNullable<ReturnType<typeof parseSourceReference>>;
const cache = new Map<string, Promise<Buffer[]>>();
const started = new Map<string, number>();
const materializedHash = "a4306dc82296ba73adb6d054906c82d38c4c0cab08c4b70cd2573c17415e3111";
async function materialized(hash: string) {
  if (hash !== materializedHash) return null;
  const directory = process.env.NODE_ENV === "production" ? "dist/evidence" : "server/evidence";
  return readFile(resolve(directory, `${materializedHash}.json`));
}
async function json(path: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await connectorRequest(path, {});
    if (response.ok) return response.json();
    if (![429, 502, 503, 504].includes(response.status) || attempt === 2)
      throw new Error(`Source evidence unavailable (${response.status})`);
    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
  }
}
const blobHashes = new Map<string, { hash: string; size: number }>();
// Rebuild only the documented deterministic LifeOS format. No signing, writes,
// checkout, execution of repository code, or claims about authorship.
export async function load(source: Source): Promise<Buffer[]> {
  const base = `/repos/${source.owner}/${source.repo}`;
  try {
    const file = await json(`${base}/contents/${source.path.split("/").map(encodeURIComponent).join("/")}?ref=${source.commit}`);
    if (file.type === "file" && file.encoding === "base64" && file.size <= 16 * 1024 * 1024) return [Buffer.from(file.content, "base64")];
  } catch { /* Generated manifests intentionally live outside the source tree. */ }
  if (source.owner !== "bxrist" || source.repo !== "LifeOS" || source.path !== "lifeos-source-manifest.json") throw new Error("Manifest unavailable");
  const commit = await json(`${base}/git/commits/${source.commit}`);
  if (commit.sha !== source.commit || !/^[a-f0-9]{40}$/.test(commit.tree?.sha)) throw new Error("Invalid source commit");
  const tree = await json(`${base}/git/trees/${commit.tree.sha}?recursive=1`);
  if (tree.truncated || !Array.isArray(tree.tree) || tree.tree.length > 10000) throw new Error("Incomplete tree");
  const entries = tree.tree.filter((e: any) => e.type !== "tree");
  if (entries.some((e: any) => e.type !== "blob" || !["100644", "100755"].includes(e.mode) || e.size > 64 * 1024 * 1024)) throw new Error("Unsupported tree");
  const files: any[] = [];
  let index = 0, total = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (index < entries.length) {
      const entry = entries[index++];
      const key = `${base}/${entry.sha}`;
      let hashed = blobHashes.get(key);
      if (!hashed) {
        const blob = await json(`${base}/git/blobs/${entry.sha}`);
        if (blob.encoding !== "base64") throw new Error("Unsupported blob");
        const bytes = Buffer.from(blob.content, "base64");
        if (bytes.length > 64 * 1024 * 1024 || digestGitBlob(bytes) !== entry.sha) throw new Error("Invalid source blob");
        hashed = { hash: digest(bytes), size: bytes.length };
        if (blobHashes.size >= 10000) blobHashes.delete(blobHashes.keys().next().value!);
        blobHashes.set(key, hashed);
      }
      total += hashed.size;
      if (total > 512 * 1024 * 1024) throw new Error("Source limit exceeded");
      files.push({ path: entry.path, mode: entry.mode, git_blob: entry.sha, sha256: hashed.hash });
    }
  }));
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return ["accepted_push", "offline", "preview"].map(context => Buffer.from(canonical({
    schema: "lifeos-source-provenance", version: 1, repository: `https://github.com/${source.owner}/${source.repo}`,
    commit: source.commit, tree: commit.tree.sha, context, status: "UNSIGNED_PENDING_FORGEPROOF", files,
  })));
}
function digestGitBlob(bytes: Buffer) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}
export async function sourceManifest(receipt: any, loader = load) {
  const source = parseSourceReference(receipt.filePath);
  if (!source) return { status: "unavailable", reason: "No immutable source manifest reference.", files: [] };
  const timestamp = getReceiptTimestamp(receipt);
  const signatureValid = !!timestamp && computeEntryHash({ ...receipt, timestamp }) === receipt.entryHash &&
    verifySignature(`${receipt.entryHash}|${receipt.fileHash}|${timestamp}`, receipt.signature, receipt.publicKey);
  const common = { source, receiptHash: receipt.fileHash, signatureValid };
  try {
    // Only a cryptographically intact receipt can cause privileged source reads.
    if (!signatureValid) return { ...common, status: "unverified", reason: "Receipt verification failed.", files: [] };
    const key = receipt.filePath;
    // Existing, independently reproduced bytes are packaged server-side only.
    // Every response still validates the original receipt and exact manifest hash.
    const stored = loader === load ? await materialized(receipt.fileHash) : null;
    let pending = stored ? Promise.resolve([stored]) : loader === load ? cache.get(key) : undefined;
    if (!pending) {
      if (loader === load && started.has(key) && Date.now() - started.get(key)! > 120000)
        return { ...common, status: "unavailable", pending: false, reason: "Source reconstruction did not complete. No file count has been established.", files: [] };
      pending = loader(source);
      if (loader === load) {
        started.set(key, Date.now());
        if (cache.size >= 8) cache.delete(cache.keys().next().value!);
        cache.set(key, pending);
        pending.catch(() => {}); // Retain failure rather than restart on every viewer.
      }
    }
    // Poll, do not long-poll: authentication/visibility already incurred a Git
    // read. Return pending without adding a timer to every request. A settled
    // cached promise wins this race; unresolved work continues shared in cache.
    const candidates = await Promise.race([pending, Promise.resolve(null)]);
    if (!candidates && loader === load && Date.now() - (started.get(key) ?? Date.now()) > 120000)
      return { ...common, status: "unavailable", pending: false, reason: "Source reconstruction did not complete. No file count has been established.", files: [] };
    if (!candidates) return { ...common, status: "unavailable", pending: true,
      reason: "Reading immutable source objects. Coverage is not verified yet.", files: [] };
    const bytes = candidates.find(b => digest(b) === receipt.fileHash);
    if (!bytes) return { ...common, status: "unverified", reason: "Source manifest bytes do not match the signed hash.", files: [] };
    const manifest = JSON.parse(bytes.toString("utf8"));
    if (manifest.schema !== "lifeos-source-provenance" || manifest.version !== 1 || manifest.commit !== source.commit ||
        manifest.repository !== `https://github.com/${source.owner}/${source.repo}` || !Array.isArray(manifest.files) ||
        manifest.files.some((f: any) => typeof f.path !== "string" || !/^[a-f0-9]{64}$/.test(f.sha256))) throw new Error("Unsupported manifest");
    return { ...common, status: "verified", manifestHash: digest(bytes), fileCount: manifest.files.length,
      files: manifest.files.map((f: any) => ({ path: f.path, sha256: f.sha256 })) };
  } catch {
    return { ...common, status: "unavailable", reason: "Source coverage could not be retrieved or validated. Receipt remains unchanged.", files: [] };
  }
}
