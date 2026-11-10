import type { AttestationReceipt } from "@shared/schema";
import { manifestIdentity } from "@shared/receiptPresentation";

export function logicalReceiptKey(receipt: AttestationReceipt): string {
  return `${receipt.userId}::${receipt.repositoryId ?? "null"}::${manifestIdentity(receipt.filePath) ?? receipt.filePath}`;
}

export function githubLink(value: string | undefined | null): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password) return url.href;
  } catch { /* Invalid evidence URLs are not navigable. */ }
}

export function parseGithubSource(value: string) {
  if (!value.startsWith("github://")) return null;
  const match = /^github:\/\/([^/?#]+)\/([^/@?#]+)(?:@([^/?#]+))?(?:\/([^?#]*))?(?:\?([^#]*))?/.exec(value);
  if (!match) return null;
  const [, owner, repo, atCommit, rest = "", query = ""] = match;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  const params = new URLSearchParams(query);
  const segments = rest.split("/");
  const commit = atCommit || params.get("commit") || (segments[0] === "commit" || segments[0] === "tree" || segments[0] === "blob" ? segments[1] : segments[0]);
  const path = params.get("path") || (atCommit || params.has("commit") ? rest : segments.slice(["commit", "tree", "blob"].includes(segments[0]) ? 2 : 1).join("/"));
  const base = `https://github.com/${owner}/${repo}`;
  return { owner, repo, commit: commit || "UNKNOWN", path, commitUrl: commit ? `${base}/commit/${encodeURIComponent(commit)}` : undefined };
}

export function redactMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactMetadata);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, /secret|token|password|credential|private.?key|api.?key|authorization|cookie/i.test(key) ? "[redacted]" : redactMetadata(item),
    ]));
  }
  return value;
}
