import { afterEach, expect, it, vi } from "vitest";
import { GitHubTransport } from "../server/git-store/github-store.mjs";
import { IntegrityError } from "../server/git-store/store.mjs";
import { bootId } from "../server/bootIdentity.mjs";
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const make = (request: any) => new GitHubTransport({ owner: "private-owner", repo: "private-repo", request });
it("shares the three-attempt budget across HTTP and thrown failures", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const request = vi.fn().mockRejectedValueOnce(new Error("private transport"))
    .mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValue(new Response("{}"));
  const result = make(request).call("/git/commits/private-hash");
  await vi.runAllTimersAsync();
  expect((await result).status).toBe(200);
  expect(request).toHaveBeenCalledTimes(3);
  expect(JSON.parse(log.mock.calls[0][1])).toMatchObject({ retries: 2, bootId });
  expect(JSON.stringify(log.mock.calls)).not.toContain("private");
});
it("handles thrown errors on later attempts without multiplying budget", async () => {
  vi.useFakeTimers();
  const error = new Error("opaque");
  const request = vi.fn().mockResolvedValueOnce(new Response("", { status: 502 })).mockRejectedValue(error);
  const assertion = expect(make(request).call("/git/trees/hash")).rejects.toBe(error);
  await vi.runAllTimersAsync(); await assertion;
  expect(request).toHaveBeenCalledTimes(3);
});
it.each([
  new IntegrityError("bad"), Object.assign(new Error("denial"), { status: 403 }),
  Object.assign(new Error("denial"), { status: 401 }), new Error("credential unavailable"),
  new Error("invalid configuration"), new Error("signature mismatch"),
  new Error("owner binding denied"), new Error("token unavailable"),
  Object.assign(new Error("opaque"), { code: "EACCES" }),
  new Error("deployment identity unavailable"),
])("does not retry known denied failures", async error => {
  const request = vi.fn().mockRejectedValue(error);
  await expect(make(request).call("/git/blobs/hash")).rejects.toBe(error);
  expect(request).toHaveBeenCalledTimes(1);
});
it("caps aggregate connector time even across generic failures", async () => {
  vi.useFakeTimers();
  const request = vi.fn(() => new Promise((_, reject) => setTimeout(() => reject(new Error("opaque")), 14000)));
  const assertion = expect(make(request).call("/git/trees/hash")).rejects.toMatchObject({ code: "GIT_READ_DEADLINE" });
  await vi.advanceTimersByTimeAsync(31500); await assertion;
  expect(request).toHaveBeenCalledTimes(3);
});
it.each(["POST", "PATCH"])("does not retry %s exceptions", async method => {
  const request = vi.fn().mockRejectedValue(new Error("opaque"));
  await expect(make(request).call("/git/blobs", method)).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});
it("aborts a hung immutable read and never overlaps a retry after deadline", async () => {
  vi.useFakeTimers();
  const request = vi.fn(() => new Promise(() => {}));
  const assertion = expect(make(request).call("/git/trees/hash")).rejects.toMatchObject({ code: "GIT_READ_DEADLINE" });
  await vi.advanceTimersByTimeAsync(15000); await assertion;
  expect(request).toHaveBeenCalledTimes(1);
});
