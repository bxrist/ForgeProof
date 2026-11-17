import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubTransport } from "../server/git-store/github-store.mjs";
import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createGitHubAppRequest } from "../server/git-store/githubAppRequest";
import { connectorRequest, productionGitRequest } from "../server/git-store/githubRuntime";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const env = { FORGEPROOF_GIT_TRANSPORT: "github-app", FORGEPROOF_GIT_APP_ID: "12", FORGEPROOF_GIT_APP_INSTALLATION_ID: "34",
  FORGEPROOF_GIT_APP_REPOSITORY_ID: "56", FORGEPROOF_GIT_GITHUB_REPOSITORY: "owner/evidence",
  FORGEPROOF_GIT_TENANT: "production", FORGEPROOF_GIT_STREAM: "app", FORGEPROOF_GIT_APP_PRIVATE_KEY: pem };
const repo = { id: 56, full_name: "owner/evidence", private: true };
const path = "/repos/owner/evidence/git/blobs";
it.each(["GET", "POST", "PATCH"])("denies unimplemented snapshot ref access via %s before minting", async method => {
  const fetch = vi.fn();
  const ref = "heads/forgeproof-snapshots/production/app";
  const p = method === "GET" ? `/git/ref/${ref}` : method === "POST" ? "/git/refs" : `/git/refs/${ref}`;
  await expect(createGitHubAppRequest(env, fetch)(`/repos/owner/evidence${p}`, {
    method, ...(method === "GET" ? {} : { body: JSON.stringify({ ref: `refs/${ref}`, sha: "a".repeat(40), force: false }) }),
  })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
function fixture(change: (data: any[]) => void = () => {}) {
  const data = [{ id: 34, app_id: 12, account: { login: "owner" }, suspended_at: null },
    { token: "synthetic-secret", expires_at: new Date(Date.now() + 3599000).toISOString(), permissions: { contents: "write", metadata: "read" }, repositories: [repo] },
    { total_count: 1, repositories: [repo] }, repo, { sha: "a".repeat(40) }];
  change(data);
  let i = 0;
  return vi.fn(async (_url: any, _init: any) => new Response(JSON.stringify(data[Math.min(i, 4)]), { status: i++ === 1 || i >= 5 ? 201 : 200 }));
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it("validates App JWT and single-repository token before forwarding unchanged bytes", async () => {
  const fetch = fixture(); const request = createGitHubAppRequest(env, fetch);
  const body = '{"content":"Ynl0ZXM=","encoding":"base64"}';
  expect((await request(path, { method: "POST", body })).status).toBe(201);
  expect(fetch).toHaveBeenCalledTimes(5);
  const jwt = fetch.mock.calls[0][1].headers.authorization.slice(7).split(".");
  expect(verify("RSA-SHA256", Buffer.from(jwt.slice(0, 2).join(".")), keys.publicKey, Buffer.from(jwt[2], "base64url"))).toBe(true);
  expect(JSON.parse(Buffer.from(jwt[1], "base64url").toString()).iss).toBe("12");
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ repository_ids: [56], permissions: { contents: "write" } });
  expect(fetch.mock.calls[4]).toEqual([`https://api.github.com${path}`, expect.objectContaining({ method: "POST", body, redirect: "error", headers: expect.objectContaining({ authorization: "Bearer synthetic-secret" }) })]);
  await request(path, { method: "POST", body }); expect(fetch).toHaveBeenCalledTimes(6);
});
it.each([
  (d: any[]) => { d[0].id = 35; }, (d: any[]) => { d[0].app_id = 13; },
  (d: any[]) => { d[0].account.login = "other"; }, (d: any[]) => { d[0].suspended_at = "date"; },
  (d: any[]) => { d[1].permissions.contents = "read"; }, (d: any[]) => { d[1].permissions.issues = "write"; },
  (d: any[]) => { d[1].repositories = [{ ...repo, id: 57 }]; },
  (d: any[]) => { d[1].repositories = [repo, repo]; }, (d: any[]) => { delete d[1].repositories; },
  (d: any[]) => { d[1].expires_at = new Date(Date.now() - 1).toISOString(); },
  (d: any[]) => { d[1].expires_at = new Date(Date.now() + 7200000).toISOString(); },
  (d: any[]) => { d[2].total_count = 2; }, (d: any[]) => { d[3] = { ...repo, full_name: "other/repo" }; },
])("fails closed on installation, repository, permissions or expiry mismatch", async change => {
  const fetch = fixture(change); await expect(createGitHubAppRequest(env, fetch)(path, { method: "POST", body: "{}" })).rejects.toThrow("authorization/configuration denied");
  expect(fetch.mock.calls.some(([url]) => url.endsWith("/git/blobs"))).toBe(false);
});
it.each([undefined, "personal-PAT", "", "-----BEGIN PRIVATE KEY-----\ninvalid"]) ("rejects missing/malformed key without fallback", key => {
  const fetch = vi.fn(); expect(() => createGitHubAppRequest({ ...env, FORGEPROOF_GIT_APP_PRIVATE_KEY: key }, fetch)).toThrow(); expect(fetch).not.toHaveBeenCalled();
});
it.each(["FORGEPROOF_GIT_APP_ID", "FORGEPROOF_GIT_APP_INSTALLATION_ID", "FORGEPROOF_GIT_APP_REPOSITORY_ID", "FORGEPROOF_GIT_TENANT", "FORGEPROOF_GIT_STREAM"])("requires explicit binding %s", field => {
  expect(() => createGitHubAppRequest({ ...env, [field]: undefined })).toThrow();
});
it("keeps Replit default and never falls back from explicit App selection", () => {
  expect(productionGitRequest({})).toBe(connectorRequest);
  expect(productionGitRequest({ FORGEPROOF_GIT_TRANSPORT: "replit" })).toBe(connectorRequest);
  expect(() => productionGitRequest({ FORGEPROOF_GIT_TRANSPORT: "other" })).toThrow();
  expect(() => productionGitRequest({ FORGEPROOF_GIT_TRANSPORT: "github-app", GITHUB_TOKEN: "personal" })).toThrow();
});
it.each(["https://evil.test/", "/repos/other/evidence/git/blobs", "/repos/owner/evidence/../evil", "/repos/owner/evidence/git/ref/heads/forgeproof/other/app"])("rejects unsafe or cross-project path %s before auth", async p => {
  const fetch = vi.fn(); await expect(createGitHubAppRequest(env, fetch)(p, {})).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
});
it("rejects forced or cross-project ref writes before auth", async () => {
  const fetch = vi.fn(); const request = createGitHubAppRequest(env, fetch);
  await expect(request("/repos/owner/evidence/git/refs/heads/forgeproof/production/app", { method: "PATCH", body: JSON.stringify({ sha: "a".repeat(40), force: true }) })).rejects.toThrow();
  await expect(request(path, { method: "POST", headers: { Authorization: "personal" } })).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
});
it.each([401, 403, 500, 302])("sanitizes auth API status %s with no retry or credential leak", async status => {
  const fetch = vi.fn(async () => new Response("synthetic-secret " + pem, { status }));
  let error: any; try { await createGitHubAppRequest(env, fetch)(path, { method: "POST" }); } catch (e) { error = e; }
  expect(String(error)).toBe("Error: GitHub App authorization/configuration denied"); expect(error.cause).toBeUndefined(); expect(fetch).toHaveBeenCalledTimes(1);
});
it("sanitizes fetch exceptions", async () => {
  const fetch = vi.fn().mockRejectedValue(new Error(pem));
  await expect(createGitHubAppRequest(env, fetch)(path, { method: "POST" })).rejects.toThrow(/^GitHub App authorization\/configuration denied$/);
});
it("refreshes after the bounded cache lifetime", async () => {
  vi.useFakeTimers(); const fetch = fixture(); const request = createGitHubAppRequest(env, fetch);
  await request(path, { method: "POST" }); await vi.advanceTimersByTimeAsync(3540000);
  // New refresh must start from installation verification; stale token never reaches a write.
  await expect(request(path, { method: "POST" })).rejects.toThrow();
  expect(fetch.mock.calls[5][0]).toBe("https://api.github.com/repos/owner/evidence/installation");
});
it("reads only an explicit systemd credential reference and rejects ambiguity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "forgeproof-app-test-"));
  try {
    writeFileSync(join(directory, "project-pem"), pem, { mode: 0o600 });
    const config = { ...env, FORGEPROOF_GIT_APP_PRIVATE_KEY: undefined, CREDENTIALS_DIRECTORY: directory, FORGEPROOF_GIT_APP_KEY_CREDENTIAL: "project-pem" };
    expect((await createGitHubAppRequest(config, fixture())(path, { method: "POST" })).status).toBe(201);
    expect(() => createGitHubAppRequest({ ...config, FORGEPROOF_GIT_APP_KEY_CREDENTIAL: "../other" })).toThrow();
    expect(() => createGitHubAppRequest({ ...config, FORGEPROOF_GIT_APP_KEY_CREDENTIAL: "missing" })).toThrow();
    expect(() => createGitHubAppRequest({ ...config, FORGEPROOF_GIT_APP_PRIVATE_KEY: pem })).toThrow();
  } finally { rmSync(directory, { recursive: true }); }
});
it.each([401, 403, 503])("never retries an actual transport write returning %s or exposes its error body", async status => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  // Use a separate wrapper so the preflight sequence remains intact.
  const preflight = fixture();
  const mocked = vi.fn(async (url: any, init: any) => url.endsWith("/git/blobs")
    ? new Response("synthetic-secret " + pem, { status }) : preflight(url, init));
  const transport = new GitHubTransport({ owner: "owner", repo: "evidence", request: createGitHubAppRequest(env, mocked) });
  expect(await (transport as any).call("/git/blobs", "POST", { content: "bytes" })).toEqual({ status, json: {} });
  expect(mocked).toHaveBeenCalledTimes(5);
  expect(JSON.stringify([...info.mock.calls, ...error.mock.calls])).not.toMatch(/synthetic-secret|PRIVATE KEY/);
});
it("bounds stalled authentication body consumption without ever writing", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => ({ status: 200, text: () => new Promise(() => {}) }) as Response);
  const result = expect(createGitHubAppRequest(env, fetch)(path, { method: "POST" })).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(30000); await result; expect(fetch).toHaveBeenCalledTimes(1);
});
it("rejects malformed successful API JSON without exposing raw data", async () => {
  const fetch = vi.fn(async () => new Response("synthetic-secret " + pem));
  await expect(createGitHubAppRequest(env, fetch)(path, { method: "POST" })).rejects.toThrow(/^GitHub App authorization\/configuration denied$/);
});
it("refreshes successfully and coalesces concurrent token acquisition", async () => {
  vi.useFakeTimers();
  let sequence = fixture();
  const fetch = vi.fn((url: any, init: any) => sequence(url, init));
  const request = createGitHubAppRequest(env, fetch);
  await Promise.all([request(path, { method: "POST" }), request(path, { method: "POST" })]);
  expect(fetch).toHaveBeenCalledTimes(6);
  await vi.advanceTimersByTimeAsync(3540000); sequence = fixture();
  await request(path, { method: "POST" }); expect(fetch).toHaveBeenCalledTimes(11);
});
it.each(["heads/forgeproof/production/app", `heads/forgeproof-vault/production/${"b".repeat(40)}`])("preserves non-forced CAS on scoped ref %s", async ref => {
  const preflight = fixture();
  const fetch = vi.fn((url: any, init: any) => url.includes("/git/refs/")
    ? Promise.resolve(new Response("{}", { status: 409 })) : preflight(url, init));
  const request = createGitHubAppRequest(env, fetch);
  const body = JSON.stringify({ sha: "a".repeat(40), force: false });
  expect((await request(`/repos/owner/evidence/git/refs/${ref}`, { method: "PATCH", body })).status).toBe(409);
  expect(fetch.mock.calls[4][1].body).toBe(body);
});
it.each([0, 1, 2, 3])("rejects null preflight response at phase %s with fixed error", async phase => {
  const fetch = fixture(data => { data[phase] = null; });
  await expect(createGitHubAppRequest(env, fetch)(path, { method: "POST" })).rejects.toThrow(/^GitHub App authorization\/configuration denied$/);
  expect(fetch.mock.calls.some(([url]) => url.endsWith("/git/blobs"))).toBe(false);
});
it("rejects a response completed after token expiry", async () => {
  vi.useFakeTimers(); const preflight = fixture();
  const fetch = vi.fn(async (url: any, init: any) => {
    if (!url.endsWith("/git/blobs")) return preflight(url, init);
    vi.setSystemTime(Date.now() + 3600001);
    return new Response("{}", { status: 201 });
  });
  await expect(createGitHubAppRequest(env, fetch)(path, { method: "POST" })).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(5);
});
it("requires explicit adapter opt-in even with complete App credentials", () => {
  expect(() => createGitHubAppRequest({ ...env, FORGEPROOF_GIT_TRANSPORT: undefined })).toThrow();
});
it("rejects pre-aborted requests before any authentication exchange", async () => {
  const fetch = fixture(); const controller = new AbortController(); controller.abort();
  await expect(createGitHubAppRequest(env, fetch)(path, { method: "POST", signal: controller.signal })).rejects.toThrow(/^GitHub App authorization\/configuration denied$/);
  expect(fetch).not.toHaveBeenCalled();
});
it("aborts an unshared token mint immediately and never executes the cancelled request", async () => {
  const preflight = fixture(); const controller = new AbortController();
  let mintSignal: AbortSignal | undefined;
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: (response: Response) => void;
  const fetch = vi.fn((url: any, init: any) => {
    if (url.endsWith("/access_tokens")) {
      mintSignal = init.signal; entered();
      return new Promise<Response>(resolve => { release = resolve; });
    }
    return preflight(url, init);
  });
  const request = createGitHubAppRequest(env, fetch);
  const result = expect(request(path, { method: "POST", signal: controller.signal })).rejects.toThrow(/^GitHub App authorization\/configuration denied$/);
  await started; controller.abort(); await result;
  expect(mintSignal?.aborted).toBe(true);
  release(new Response("{}", { status: 201 }));
  await Promise.resolve(); await Promise.resolve();
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("lets another caller finish a shared mint after one caller cancels", async () => {
  const preflight = fixture(); const controller = new AbortController();
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let mintSignal: AbortSignal | undefined;
  const fetch = vi.fn(async (url: any, init: any) => {
    if (url.endsWith("/access_tokens")) { mintSignal = init.signal; entered(); await gate; }
    return preflight(url, init);
  });
  const request = createGitHubAppRequest(env, fetch);
  const cancelled = expect(request(path, { method: "POST", signal: controller.signal })).rejects.toThrow();
  const survivor = request(path, { method: "POST" });
  await started; controller.abort(); await cancelled;
  expect(mintSignal?.aborted).toBe(false);
  release(); expect((await survivor).status).toBe(201);
  expect(fetch).toHaveBeenCalledTimes(5);
  await request(path, { method: "POST" }); expect(fetch).toHaveBeenCalledTimes(6);
});
it("bounds the entire shared authentication sequence to 30 seconds", async () => {
  vi.useFakeTimers(); const preflight = fixture();
  const fetch = vi.fn(async (url: any, init: any) => {
    await new Promise(resolve => setTimeout(resolve, 10000));
    if (init.signal.aborted) throw new Error("synthetic-secret");
    return preflight(url, init);
  });
  const result = expect(createGitHubAppRequest(env, fetch)(path, { method: "POST" })).rejects.toThrow(/^GitHub App authorization\/configuration denied$/);
  await vi.advanceTimersByTimeAsync(30000); await result;
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(fetch.mock.calls.every(([, init]) => init.signal.aborted)).toBe(true);
  await vi.advanceTimersByTimeAsync(30000); expect(fetch).toHaveBeenCalledTimes(3);
});
it.each([
  { "retry-after": "120", "x-ratelimit-remaining": "5" },
  { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "RESET" },
])("preserves rate-limit metadata and cooldown without refreshing or replaying writes: %j", async headers => {
  vi.useFakeTimers();
  const safeHeaders = { ...headers };
  if (safeHeaders["x-ratelimit-reset"] === "RESET") safeHeaders["x-ratelimit-reset"] = String(Math.floor(Date.now() / 1000) + 120);
  const preflight = fixture(); let writes = 0;
  const fetch = vi.fn((url: any, init: any) => url.endsWith("/git/blobs")
    ? Promise.resolve(++writes === 1 ? new Response("synthetic-secret " + pem, { status: 403,
      headers: { ...safeHeaders, "x-secret": "synthetic-secret" } }) : new Response("{}", { status: 201 })) : preflight(url, init));
  const request = createGitHubAppRequest(env, fetch);
  const response = await request(path, { method: "POST" });
  expect(response.status).toBe(403); expect(await response.text()).toBe("{}");
  for (const [name, value] of Object.entries(safeHeaders)) expect(response.headers.get(name)).toBe(value);
  expect(response.headers.get("x-secret")).toBeNull();
  expect((await request(path, { method: "POST" })).status).toBe(429);
  expect(fetch).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(120000);
  expect((await request(path, { method: "POST" })).status).toBe(201);
  expect(fetch).toHaveBeenCalledTimes(6);
});
it("does not disguise or retry a known authorization denial", async () => {
  const preflight = fixture();
  const fetch = vi.fn((url: any, init: any) => url.endsWith("/git/blobs")
    ? Promise.resolve(new Response("synthetic-secret", { status: 403, headers: { "x-ratelimit-remaining": "10" } })) : preflight(url, init));
  const request = createGitHubAppRequest(env, fetch);
  expect((await request(path, { method: "POST" })).status).toBe(403);
  expect(fetch).toHaveBeenCalledTimes(5);
  await expect(request(path, { method: "POST" })).rejects.toThrow();
  expect(fetch.mock.calls[5][0]).toBe("https://api.github.com/repos/owner/evidence/installation");
  expect(fetch).toHaveBeenCalledTimes(6);
});
it("cools down rate-limited authentication without reminting or leaking headers", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => new Response("synthetic-secret", { status: 403,
    headers: { "retry-after": "60", "x-ratelimit-reset": "synthetic-secret", "x-ratelimit-limit": "5000" } }));
  const request = createGitHubAppRequest(env, fetch);
  await expect(request(path, { method: "POST" })).rejects.toThrow(/^GitHub App authorization\/configuration denied$/);
  const response = await request(path, { method: "POST" });
  expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("60");
  expect(await response.text()).toBe("{}"); expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60000);
  await expect(request(path, { method: "POST" })).rejects.toThrow(); expect(fetch).toHaveBeenCalledTimes(2);
});
it("uses a safe fallback cooldown for 429 with unsafe rate header values", async () => {
  vi.useFakeTimers(); const preflight = fixture();
  const fetch = vi.fn((url: any, init: any) => url.endsWith("/git/blobs")
    ? Promise.resolve(new Response("synthetic-secret", { status: 429,
      headers: { "retry-after": "synthetic-secret", "x-ratelimit-reset": "synthetic-secret" } })) : preflight(url, init));
  const request = createGitHubAppRequest(env, fetch);
  const response = await request(path, { method: "POST" });
  expect(response.status).toBe(429); expect([...response.headers.values()].join()).not.toContain("synthetic-secret");
  expect((await request(path, { method: "POST" })).headers.get("retry-after")).toBe("60");
  expect(fetch).toHaveBeenCalledTimes(5);
});

const secondaryLimit = JSON.stringify({ message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." });
const patchPath = "/repos/owner/evidence/git/refs/heads/forgeproof/production/app";
const patchBody = JSON.stringify({ sha: "a".repeat(40), force: false });
it.each([secondaryLimit, JSON.stringify({ message: "API rate limit exceeded for synthetic-user." })])(
  "cools down no-header rate limits across overlapping POST/PATCH calls without discarding the token: %s", async body => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const preflight = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let writes = 0;
    const fetch = vi.fn(async (url: any, init: any) => {
      if (url.endsWith("/git/blobs") || url.includes("/git/refs/")) {
        if (++writes === 2) entered();
        await gate;
        return new Response(body, { status: 403 });
      }
      return preflight(url, init);
    });
    const request = createGitHubAppRequest(env, fetch);
    const results = Promise.all([request(path, { method: "POST" }), request(patchPath, { method: "PATCH", body: patchBody })]);
    await started; release();
    for (const response of await results) {
      expect(response.status).toBe(403); expect(await response.text()).toBe("{}");
      expect(response.headers.get("retry-after")).toBe("60");
    }
    expect(fetch).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(59999);
    expect((await request(path, { method: "POST" })).status).toBe(429);
    expect((await request(patchPath, { method: "PATCH", body: patchBody })).status).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(1);
    expect((await request(path, { method: "POST" })).status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/access_tokens"))).toHaveLength(1);
    expect(fetch.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(1);
    expect(writes).toBe(3); // Only the three explicitly requested writes reached GitHub.
    expect(JSON.stringify([...info.mock.calls, ...error.mock.calls])).toBe("[]");
  });
it.each([0, 1, 2, 3])("cools down no-header secondary limits during shared authentication phase %s", async phase => {
  vi.useFakeTimers(); const preflight = fixture(); let index = 0;
  const fetch = vi.fn(async (url: any, init: any) => index++ === phase
    ? new Response(secondaryLimit, { status: 403 }) : preflight(url, init));
  const request = createGitHubAppRequest(env, fetch);
  const results = await Promise.allSettled([
    request(path, { method: "POST" }), request(patchPath, { method: "PATCH", body: patchBody }),
  ]);
  expect(results.every(result => result.status === "rejected" && String(result.reason) === "Error: GitHub App authorization/configuration denied")).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(phase + 1);
  await vi.advanceTimersByTimeAsync(59999);
  expect((await request(path, { method: "POST" })).status).toBe(429);
  expect((await request(patchPath, { method: "PATCH", body: patchBody })).status).toBe(429);
  expect(fetch).toHaveBeenCalledTimes(phase + 1);
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/access_tokens"))).toHaveLength(phase === 0 ? 0 : 1);
  expect(fetch.mock.calls.some(([url]) => url.endsWith("/git/blobs") || url.includes("/git/refs/"))).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetch).toHaveBeenCalledTimes(phase + 1); // No hidden replay when cooldown expires.
});
it.each([
  JSON.stringify({ message: "Resource not accessible by integration" }),
  JSON.stringify({ message: "permission denied: You have exceeded a secondary rate limit." }),
  JSON.stringify({ message: "API rate limit exceededness" }),
  secondaryLimit.slice(0, -1),
  JSON.stringify({ padding: "x".repeat(4096), message: "You have exceeded a secondary rate limit." }),
])("fails closed for non-rate-limit, malformed or oversized 403 bodies", async body => {
  const preflight = fixture();
  const fetch = vi.fn(async (url: any, init: any) => url.endsWith("/git/blobs")
    ? new Response(body, { status: 403 }) : preflight(url, init));
  const request = createGitHubAppRequest(env, fetch);
  const response = await request(path, { method: "POST" });
  expect(response.status).toBe(403); expect(await response.text()).toBe("{}");
  expect(response.headers.has("retry-after")).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(5);
  await expect(request(path, { method: "POST" })).rejects.toThrow(/^GitHub App authorization\/configuration denied$/);
  expect(fetch).toHaveBeenCalledTimes(6);
});
it("cancels a 403 body once the fixed byte budget is exhausted", async () => {
  const cancel = vi.fn(); let pulls = 0;
  const preflight = fixture();
  const fetch = vi.fn(async (url: any, init: any) => url.endsWith("/git/blobs")
    ? new Response(new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(4096)); }, cancel,
    }, { highWaterMark: 0 }), { status: 403 }) : preflight(url, init));
  expect((await createGitHubAppRequest(env, fetch)(path, { method: "POST" })).status).toBe(403);
  expect(pulls).toBe(1); expect(cancel).toHaveBeenCalledTimes(1);
});
it("classifies a no-header secondary limit split across body chunks", async () => {
  const bytes = new TextEncoder().encode(secondaryLimit); const preflight = fixture();
  const fetch = vi.fn(async (url: any, init: any) => url.endsWith("/git/blobs")
    ? new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes.slice(0, 25)); controller.enqueue(bytes.slice(25)); controller.close();
    } }), { status: 403 }) : preflight(url, init));
  const request = createGitHubAppRequest(env, fetch);
  expect((await request(path, { method: "POST" })).status).toBe(403);
  expect((await request(path, { method: "POST" })).status).toBe(429);
  expect(fetch).toHaveBeenCalledTimes(5);
});
it("bounds stalled 403 body classification by the existing request deadline", async () => {
  vi.useFakeTimers(); const preflight = fixture();
  const fetch = vi.fn(async (url: any, init: any) => url.endsWith("/git/blobs")
    ? new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), { status: 403 }) : preflight(url, init));
  const result = expect(createGitHubAppRequest(env, fetch)(path, { method: "POST" })).rejects.toThrow(/^GitHub App authorization\/configuration denied$/);
  await vi.advanceTimersByTimeAsync(30000); await result;
  expect(fetch).toHaveBeenCalledTimes(5);
  expect(fetch.mock.calls[4][1].signal.aborted).toBe(true);
});
