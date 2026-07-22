import { db } from "./db";
import { attestationReceipts } from "@shared/schema";
import { sql } from "drizzle-orm";

export interface CommitHealthResult {
  url: string;
  fileName: string;
  status: number | null;
  ok: boolean;
  error?: string;
}

export interface CommitHealthReport {
  checkedAt: string;
  total: number;
  healthy: number;
  broken: number;
  results: CommitHealthResult[];
}

export async function checkSeedCommitUrls(): Promise<CommitHealthReport> {
  const rows = await db
    .select({
      gitCommitUrl: attestationReceipts.gitCommitUrl,
      fileName: attestationReceipts.fileName,
    })
    .from(attestationReceipts)
    .where(
      sql`user_id = 'forgeproof-system' AND git_commit_url IS NOT NULL`,
    );

  const uniqueByUrl = new Map<string, { url: string; fileName: string }>();
  for (const row of rows) {
    if (row.gitCommitUrl && !uniqueByUrl.has(row.gitCommitUrl)) {
      uniqueByUrl.set(row.gitCommitUrl, {
        url: row.gitCommitUrl,
        fileName: row.fileName,
      });
    }
  }

  const entries = Array.from(uniqueByUrl.values());
  const results: CommitHealthResult[] = await Promise.all(
    entries.map(async ({ url, fileName }) => {
      try {
        const res = await fetch(url, {
          method: "HEAD",
          redirect: "follow",
          signal: AbortSignal.timeout(10_000),
        });
        const ok = res.status === 200 || res.status === 301 || res.status === 302;
        return { url, fileName, status: res.status, ok };
      } catch (err: any) {
        return {
          url,
          fileName,
          status: null,
          ok: false,
          error: err?.message ?? String(err),
        };
      }
    }),
  );

  const healthy = results.filter((r) => r.ok).length;
  const broken = results.filter((r) => !r.ok).length;

  return {
    checkedAt: new Date().toISOString(),
    total: results.length,
    healthy,
    broken,
    results,
  };
}

export async function runCommitHealthCheck(): Promise<void> {
  console.log("[commit-health] Checking seed gitCommitUrls…");
  try {
    const report = await checkSeedCommitUrls();
    if (report.broken === 0) {
      console.log(
        `[commit-health] All ${report.total} seed commit URLs are reachable.`,
      );
    } else {
      console.warn(
        `[commit-health] ${report.broken}/${report.total} seed commit URLs are BROKEN:`,
      );
      for (const r of report.results.filter((r) => !r.ok)) {
        console.warn(
          `  ✗ ${r.fileName} — ${r.url} (status=${r.status ?? "network error"}, error=${r.error ?? "-"})`,
        );
      }
    }
  } catch (err) {
    console.error("[commit-health] Health check failed:", err);
  }
}
