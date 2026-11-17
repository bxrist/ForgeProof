import { afterEach, expect, it, vi } from "vitest";
import { GitHubTransport } from "../server/git-store/github-store.mjs";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("allows a mutable ref read to complete beyond the immutable read deadline without retry", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "info").mockImplementation(() => {});
  const request = vi.fn((_path: string, _options: any) => new Promise(resolve => setTimeout(() => resolve(
    new Response(JSON.stringify({ ref: "refs/heads/private", object: { type: "commit", sha: "a".repeat(40) } }))
  ), 31000)));
  const transport = new GitHubTransport({ owner: "private-owner", repo: "private-repo", request });
  const result = transport.ref("refs/heads/private");
  await vi.advanceTimersByTimeAsync(31000);
  expect(await result).toBe("a".repeat(40));
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][1].signal).toBeUndefined();
});

it.each([401, 403, 429, 503])("does not retry a ref response with status %s", async status => {
  const request = vi.fn().mockResolvedValue(new Response("{}", { status }));
  const transport = new GitHubTransport({ owner: "owner", repo: "repo", request });
  if (status === 429) await expect(transport.call("/git/ref/heads/main")).rejects.toMatchObject({ code: "GIT_RATE_LIMITED" });
  else expect((await transport.call("/git/ref/heads/main")).status).toBe(status);
  expect(request).toHaveBeenCalledTimes(1);
});

it("does not apply the read deadline or abort signal to a ref write", async () => {
  vi.useFakeTimers();
  const request = vi.fn((_path: string, _options: any) => new Promise(resolve => setTimeout(() => resolve(new Response("{}")), 16000)));
  const transport = new GitHubTransport({ owner: "owner", repo: "repo", request });
  const result = transport.call("/git/refs/heads/main", "PATCH", { sha: "new" });
  await vi.advanceTimersByTimeAsync(16000);
  expect((await result).status).toBe(200);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][1].signal).toBeUndefined();
});
