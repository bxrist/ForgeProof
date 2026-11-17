import { afterEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { GitHubTransport, GitReadUnavailableError } from "../server/git-store/github-store.mjs";
import { IntegrityError } from "../server/git-store/store.mjs";
import { initializationRecoveryEnabled, replayDuringInitialization } from "../server/git-store/initializationRecovery";
import { githubStoreSettings } from "../server/git-store/githubRuntime";
import { createStartupBarrier } from "../server/startupBarrier";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function quiet() { return vi.spyOn(console, "info").mockImplementation(() => {}); }

it("requires explicit recovery opt-in and rejects misspellings", () => {
  expect(initializationRecoveryEnabled({})).toBe(false);
  expect(initializationRecoveryEnabled({ FORGEPROOF_GIT_INIT_RECOVERY: "false" })).toBe(false);
  expect(initializationRecoveryEnabled({ FORGEPROOF_GIT_INIT_RECOVERY: "true" })).toBe(true);
  expect(() => initializationRecoveryEnabled({ FORGEPROOF_GIT_INIT_RECOVERY: "TRUE" })).toThrow();
});

it("recovers a classified read with correlated sanitized telemetry", async () => {
  vi.useFakeTimers(); const log = quiet();
  const upstream = new GitReadUnavailableError(); upstream.message = "private-token private-project";
  const replay = vi.fn().mockRejectedValueOnce(upstream).mockResolvedValue({ verified: true });
  const pending = replayDuringInitialization({ replay }, true);
  await vi.advanceTimersByTimeAsync(500);
  expect(await pending).toEqual({ verified: true });
  expect(replay).toHaveBeenCalledTimes(2);
  const records = log.mock.calls.map(c => JSON.parse(c[1]));
  expect(records.map(r => r.outcome)).toEqual(["retry_pending", "verified"]);
  expect(records[0].bootId).toBe(records[1].bootId);
  expect(records[1]).toMatchObject({ operation: "initial_replay", attempt: 2, elapsedMs: 500 });
  expect(JSON.stringify(records)).not.toMatch(/private|token|project/);
});

it("stops after three attempts and preserves the final exception", async () => {
  vi.useFakeTimers(); quiet();
  const error = new GitReadUnavailableError(); const replay = vi.fn().mockRejectedValue(error);
  const result = replayDuringInitialization({ replay }, true).catch(e => e);
  await vi.runAllTimersAsync();
  expect(await result).toBe(error); expect(replay).toHaveBeenCalledTimes(3);
});

it("does not retry a classified outage without opt-in", async () => {
  quiet(); const error = new GitReadUnavailableError();
  const replay = vi.fn().mockRejectedValue(error);
  await expect(replayDuringInitialization({ replay }, false)).rejects.toBe(error);
  expect(replay).toHaveBeenCalledTimes(1);
});

it("bounds stalled ref reads and never starts overlapping attempts", async () => {
  vi.useFakeTimers(); quiet(); let signal: AbortSignal | undefined;
  const upstream = vi.fn(async (_path, init) => {
    signal = init.signal; return new Promise<Response>(() => {});
  });
  const transport = new GitHubTransport({ owner: "o", repo: "r", request: upstream });
  const result = transport.ref("refs/heads/forgeproof/t/s").catch(e => e);
  await vi.advanceTimersByTimeAsync(30000);
  expect((await result).code).toBe("GIT_READ_DEADLINE");
  expect(signal?.aborted).toBe(true); expect(upstream).toHaveBeenCalledTimes(1);
});

it("does not admit a retry beyond the elapsed budget or orphan an active replay", async () => {
  vi.useFakeTimers(); quiet();
  const error = new GitReadUnavailableError();
  const replay = vi.fn(async () => { await new Promise(r => setTimeout(r, 60000)); throw error; });
  const result = replayDuringInitialization({ replay }, true).catch(e => e);
  await vi.advanceTimersByTimeAsync(59999); expect(replay).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(await result).toBe(error);
  expect(replay).toHaveBeenCalledTimes(1);
});

it.each([
  new IntegrityError("signature checkpoint tenant mismatch"), new SyntaxError("bad body"),
  Object.assign(new Error("auth"), { code: "GIT_APP_AUTHORIZATION" }),
  Object.assign(new Error("rate"), { code: "GIT_RATE_LIMITED" }),
  Object.assign(new Error("deadline"), { code: "GIT_READ_DEADLINE" }),
  Object.assign(new Error("spoof"), { code: "GIT_READ_UNAVAILABLE" }),
  new Error("unknown connector failure"),
])("never retries hard, unknown or code-spoofed failures: %s", async error => {
  quiet(); const replay = vi.fn().mockRejectedValue(error);
  await expect(replayDuringInitialization({ replay }, true)).rejects.toBe(error);
  expect(replay).toHaveBeenCalledTimes(1);
});

it("keeps readiness unavailable throughout recovery and exhaustion", async () => {
  vi.useFakeTimers(); quiet(); const barrier = createStartupBarrier();
  const status = () => {
    const res = { setHeader: vi.fn(), statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      type() { return this; }, send: vi.fn() };
    const next = vi.fn();
    barrier.middleware({ method: "GET", path: "/api/probe" } as Request, res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled(); return res.statusCode;
  };
  const error = new GitReadUnavailableError();
  const replay = vi.fn().mockRejectedValue(error);
  const result = replayDuringInitialization({ replay }, true).catch(e => { barrier.fail(); return e; });
  expect(status()).toBe(503);
  await vi.advanceTimersByTimeAsync(500);
  expect(replay).toHaveBeenCalledTimes(2); expect(status()).toBe(503);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toBe(error); expect(replay).toHaveBeenCalledTimes(3);
  expect(status()).toBe(503);
});

it.each([502, 503, 504, 401, 403, 404, 429])("classifies explicit ref read status %s conservatively", async status => {
  quiet(); const transport = new GitHubTransport({ owner: "o", repo: "r",
    request: async () => new Response("{}", { status }) });
  const result = await transport.ref("refs/heads/forgeproof/t/s").catch(e => e);
  if ([502, 503, 504].includes(status)) expect(result).toBeInstanceOf(GitReadUnavailableError);
  else if (status === 404) expect(result).toBeNull();
  else expect(result).not.toBeInstanceOf(GitReadUnavailableError);
});

it.each(["enabled", "", "true"])("rejects unsupported snapshot mode %s before accessing state", mode => {
  expect(() => githubStoreSettings({ FORGEPROOF_GIT_SNAPSHOT_MODE: mode })).toThrow(/snapshots are disabled/);
});
it("rejects explicit snapshot refs rather than silently downgrading", () => {
  expect(() => githubStoreSettings({ FORGEPROOF_GIT_SNAPSHOT_REF: "refs/heads/forgeproof-snapshots/t/s" })).toThrow(/snapshots are disabled/);
});
