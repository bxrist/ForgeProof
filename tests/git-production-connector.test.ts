import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { connectorRequest } from "../server/git-store/githubRuntime";
import { GitHubTransport, GitHubAppStateService } from "../server/git-store/github-store.mjs";
import { IntegrityError } from "../server/git-store/store.mjs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";

const transport = () => new GitHubTransport({ owner: "o", repo: "r", request: connectorRequest });
let headers: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Synthetic identity boundary only. Actual production connectorRequest,
  // subclass hooks, SDK proxy and Git transport execute below.
  headers = vi.spyOn(ReplitConnectors.prototype as any, "buildApiHeaders")
    .mockResolvedValue({ "X-Fixture": "private-fixture-token" });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("re-enters normal SDK identity/proxy on a pre-status error and succeeds", async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error("opaque private detail"))
    .mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetch);
  expect((await transport().call("/git/blobs/private-object")).status).toBe(200);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(headers).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0][1].headers).toEqual(fetch.mock.calls[1][1].headers);
  const records = (console.info as any).mock.calls.filter((x: any[]) => x[0] === "[git-connector]")
    .map((x: any[]) => JSON.parse(x[1]));
  expect(records).toContainEqual(expect.objectContaining({ phase: "proxy_request", category: "UNKNOWN", attempt: 1 }));
  expect(records).toContainEqual(expect.objectContaining({ phase: "identity_headers", category: "success", attempt: 2 }));
  expect(JSON.stringify((console.info as any).mock.calls)).not.toMatch(/private|X-Fixture/);
  expect(JSON.stringify((console.error as any).mock.calls)).not.toMatch(/private|X-Fixture/);
  for (const record of records) expect(Object.keys(record).sort()).toEqual(["attempt", "category", "elapsedMs", "phase"]);
});

it("exhausts exactly three SDK calls and fails closed", async () => {
  vi.useFakeTimers();
  const error = new Error("opaque");
  const fetch = vi.fn().mockRejectedValue(error); vi.stubGlobal("fetch", fetch);
  const result = expect(transport().call("/git/trees/object")).rejects.toBe(error);
  await vi.runAllTimersAsync(); await result;
  expect(fetch).toHaveBeenCalledTimes(3); expect(headers).toHaveBeenCalledTimes(3);
});

it.each([401, 403])("does not let the SDK retry HTTP %s", async status => {
  const fetch = vi.fn().mockResolvedValue(new Response("{}", { status })); vi.stubGlobal("fetch", fetch);
  expect((await transport().call("/git/blobs/object")).status).toBe(status);
  expect(fetch).toHaveBeenCalledTimes(1); expect(headers).toHaveBeenCalledTimes(1);
});

it.each([
  new Error("tenant mismatch"), new Error("insufficient scope"), new Error("owner binding denied"),
  new Error("invalid body"), new Error("signature invalid"), new IntegrityError("bad evidence"),
  Object.assign(new Error("opaque"), { status: 403 }),
])("does not retry denied or invalid exceptions", async error => {
  const fetch = vi.fn().mockRejectedValue(error); vi.stubGlobal("fetch", fetch);
  await expect(transport().call("/git/blobs/object")).rejects.toBe(error);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("distinguishes identity construction failure without calling it invalid credentials", async () => {
  headers.mockRejectedValue(new Error("deployment identity unavailable"));
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(transport().call("/git/blobs/object")).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled(); expect(headers).toHaveBeenCalledTimes(1);
  expect((console.info as any).mock.calls).toContainEqual(["[git-connector]", expect.stringContaining('"phase":"identity_headers","category":"UNKNOWN"')]);
});

it.each(["POST", "PATCH"])("never repeats %s even for SDK unauthorized refresh", async method => {
  const fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 401 })); vi.stubGlobal("fetch", fetch);
  expect((await transport().call("/git/refs/heads/app", method, {})).status).toBe(401);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("rejects malformed successful JSON without retry", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response("not-json")); vi.stubGlobal("fetch", fetch);
  await expect(transport().call("/git/blobs/object")).rejects.toBeInstanceOf(SyntaxError);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("uses one wall-clock deadline across attempts and backoff", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(() => new Promise((_, reject) => setTimeout(() => reject(new Error("opaque")), 14000)));
  vi.stubGlobal("fetch", fetch);
  const result = expect(transport().call("/git/blobs/object")).rejects.toMatchObject({ code: "GIT_READ_DEADLINE" });
  await vi.advanceTimersByTimeAsync(30000); await result;
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("does not wait past the total deadline for Retry-After", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response("", { status: 429, headers: { "Retry-After": "60" } }));
  vi.stubGlobal("fetch", fetch);
  await expect(transport().call("/git/blobs/object")).rejects.toMatchObject({ code: "GIT_RATE_LIMITED" });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("bounds stalled body consumption without retrying invalid/incomplete evidence", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValue({ status: 200, ok: true, text: () => new Promise(() => {}) });
  vi.stubGlobal("fetch", fetch);
  const result = expect(transport().call("/git/blobs/object")).rejects.toMatchObject({ code: "GIT_READ_DEADLINE" });
  await vi.advanceTimersByTimeAsync(30000); await result;
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("replays real signed events after one blob failure without writes or altered bytes", async () => {
  const keys = generateKeyPairSync("ed25519");
  const { canonical, hash } = await import("../server/git-store/schema.mjs");
  const objects = new Map<string, any>(); const refs: string[] = [];
  let previous: string | null = null, previousHash: string | null = null;
  const rawEvents: string[] = [];
  for (let sequence = 1; sequence <= 3; sequence++) {
    const body = { version: 1, tenant: "t", repository: "s", sequence, previous: previousHash,
      actor: "app", keyId: "k", idempotencyKey: `event-${sequence}`,
      operations: [{ kind: "users", id: `u${sequence}`, action: "put", expectedVersion: null, record: { id: `u${sequence}` } }],
      requestHash: "" };
    body.requestHash = hash(canonical({ actor: body.actor, operations: body.operations }));
    const raw = canonical({ body, signature: sign(null, Buffer.from(canonical(body)), keys.privateKey).toString("base64") });
    rawEvents.push(raw);
    const blob = createHash("sha1").update(`blob ${Buffer.byteLength(raw)}\0`).update(raw).digest("hex");
    const commit = String(sequence).repeat(40), tree = String(sequence + 3).repeat(40);
    objects.set(`/git/commits/${commit}`, { sha: commit, tree: { sha: tree }, parents: previous ? [{ sha: previous }] : [] });
    objects.set(`/git/trees/${tree}`, { tree: [{ path: "event.json", mode: "100644", type: "blob", sha: blob }] });
    objects.set(`/git/blobs/${blob}`, { encoding: "base64", content: Buffer.from(raw).toString("base64") });
    previous = commit; previousHash = hash(raw);
  }
  const before = JSON.stringify([...objects]);
  let injected = false;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.method).toBe("GET");
    const path = new URL(url).pathname.split("/repos/o/r")[1];
    if (path.startsWith("/git/ref/")) { refs.push(path); return new Response(JSON.stringify({ ref: "refs/heads/forgeproof/t/s", object: { type: "commit", sha: previous } })); }
    if (!injected && path.startsWith("/git/blobs/")) { injected = true; throw new Error("opaque"); }
    return new Response(JSON.stringify(objects.get(path)));
  });
  vi.stubGlobal("fetch", fetch);
  const service = new GitHubAppStateService({ transport: transport(), tenant: "t", repository: "s",
    checkpoint: null, trust: { eventKeys: { k: { actor: "app", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }) } }, receiptKeys: [] } });
  const state = await service.replay();
  expect(state.events.map((e: any) => canonical(e))).toEqual(rawEvents);
  expect(state.checkpoint.sequence).toBe(3);
  expect(Object.keys(state.records.users)).toHaveLength(3);
  expect(fetch).toHaveBeenCalledTimes(11); // ref + 3 objects/event + one failed GET
  expect(JSON.stringify([...objects])).toBe(before);
  expect((await service.replay()).events).toHaveLength(3);
}, 10000);
