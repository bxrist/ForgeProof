#!/usr/bin/env node
/**
 * Standalone commit URL health-check script.
 * Lists every seed gitCommitUrl and verifies it returns HTTP 200/301/302.
 *
 * Run locally:  node scripts/check-commit-urls.mjs
 * Run in CI:    node scripts/check-commit-urls.mjs  (exits 1 if any URL is broken)
 *
 * No database or server required — URLs are sourced from the same constant used
 * in server/seed.ts so this file stays in sync by design.
 */

const GITHUB_REPO = "https://github.com/bxrist/ForgeProof/commit/";

const SEED_COMMIT_URLS = [
  { fileName: "schema.ts",    sha: "f62d5ce17c8ae9093d393fce7f9a2c426f08f144" },
  { fileName: "routes.ts",    sha: "5471de789d8f014d19aa5bca2a397d491bd2cc30" },
  { fileName: "crypto.ts",    sha: "cc3552fee89725d3a2c0602259ac79cba7769f14" },
  { fileName: "landing.tsx",  sha: "d3d6f4e1c2895df9fd2400f71edf7de2befecb5b" },
  { fileName: "dashboard.tsx",sha: "7987b912e38a49ae271ce422f679f7d5ce8b705d" },
  // multi-model audit / remediation entries
  { fileName: "crypto.ts (claude audit)",  sha: "53a268098939b9744903a608ea585fa30d1708bc" },
  { fileName: "crypto.ts (gpt-5 audit)",   sha: "84d1eef8732d4e4fe8e7251a8e3df0907c2054e0" },
  { fileName: "index.ts",     sha: "073bd5ac9af7945755962285e3b6299cfceb27f4" },
  { fileName: "routes.ts (flagged audit)", sha: "b743e220061e6bd9271bc9d69587d61b11a77362" },
  { fileName: "routes.ts (remediation)",   sha: "14e6c786be3188764941b8b78c9b4554d6972495" },
];

const TIMEOUT_MS = 10_000;

async function checkUrl(url) {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ok = res.status === 200 || res.status === 301 || res.status === 302;
    return { url, status: res.status, ok };
  } catch (err) {
    return { url, status: null, ok: false, error: err?.message ?? String(err) };
  }
}

async function main() {
  console.log(`Checking ${SEED_COMMIT_URLS.length} seed commit URLs…\n`);

  const results = await Promise.all(
    SEED_COMMIT_URLS.map(async ({ fileName, sha }) => {
      const url = `${GITHUB_REPO}${sha}`;
      const result = await checkUrl(url);
      return { fileName, ...result };
    }),
  );

  let broken = 0;
  for (const r of results) {
    const icon = r.ok ? "✓" : "✗";
    const detail = r.ok
      ? `HTTP ${r.status}`
      : `HTTP ${r.status ?? "ERR"} ${r.error ? `— ${r.error}` : ""}`;
    console.log(`  ${icon}  ${r.fileName.padEnd(30)} ${detail}`);
    if (!r.ok) broken++;
  }

  console.log(`\n${results.length - broken}/${results.length} URLs reachable.`);

  if (broken > 0) {
    console.error(
      `\n[FAIL] ${broken} seed commit URL(s) are unreachable. ` +
        "Update server/seed.ts with valid commit SHAs.",
    );
    process.exit(1);
  }

  console.log("\n[OK] All seed commit URLs are reachable.");
}

main();
