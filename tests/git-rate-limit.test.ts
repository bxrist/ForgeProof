import { afterEach, expect, it, vi } from "vitest";
import { GitHubTransport } from "../server/git-store/github-store.mjs";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const limited = (delay = "2") => new Response("private-provider-body", {
  status: 429, headers: { "retry-after": delay },
});
it("waits Retry-After then retries only immutable reads", async () => {
  vi.useFakeTimers();
  const request = vi.fn().mockResolvedValueOnce(limited())
    .mockResolvedValue(new Response('{"ok":true}'));
  const transport = new GitHubTransport({ owner: "owner", repo: "repo", request });
  const result = transport.call("/git/trees/content-address");
  await vi.advanceTimersByTimeAsync(1999);
  expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toEqual({ status: 200, json: { ok: true } });
  expect(request).toHaveBeenCalledTimes(2);
});
it.each(["POST", "PATCH"])("never retries a rate-limited %s", async method => {
  const request = vi.fn().mockResolvedValue(limited());
  const transport = new GitHubTransport({ owner: "owner", repo: "repo", request });
  await expect(transport.call("/git/blobs", method, {})).rejects.toMatchObject({ code: "GIT_RATE_LIMITED" });
  expect(request).toHaveBeenCalledTimes(1);
});
it("does not retry earlier than a long provider cooldown or mislabel it as corruption", async () => {
  const request = vi.fn().mockResolvedValue(limited("120"));
  const transport = new GitHubTransport({ owner: "owner", repo: "repo", request });
  await expect(transport.singleFile("tree", "event.json")).rejects.toMatchObject({
    code: "GIT_RATE_LIMITED", message: "Git transport rate limited",
  });
  expect(request).toHaveBeenCalledTimes(1);
});
it("bounds retries and sanitizes the exhausted error", async () => {
  vi.useFakeTimers();
  const request = vi.fn().mockImplementation(async () => limited("1"));
  const transport = new GitHubTransport({ owner: "owner", repo: "repo", request });
  const assertion = expect(transport.call("/git/commits/content-address"))
    .rejects.toMatchObject({ code: "GIT_RATE_LIMITED", message: "Git transport rate limited" });
  await vi.advanceTimersByTimeAsync(2000);
  await assertion;
  expect(request).toHaveBeenCalledTimes(3);
});
it.each(["date", "absent"])("respects %s rate-limit timing without a tight retry loop", async kind => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-12T00:00:00Z"));
  const delay = kind === "date" ? 3000 : 60000;
  const headers = kind === "date" ? { "retry-after": "Thu, 12 Nov 2026 00:00:03 GMT" } : {};
  const request = vi.fn().mockResolvedValueOnce(new Response("private", { status: 429, headers }))
    .mockResolvedValue(new Response("{}"));
  const transport = new GitHubTransport({ owner: "owner", repo: "repo", request });
  const result = transport.call("/git/blobs/content-address");
  await vi.advanceTimersByTimeAsync(delay - 1);
  expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect((await result).status).toBe(200);
  expect(request).toHaveBeenCalledTimes(2);
});
