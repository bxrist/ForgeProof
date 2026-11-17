import { afterEach, expect, it, vi } from "vitest";
import { GitHubTransport } from "../server/git-store/github-store.mjs";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("bounds a hung ref read, aborts it once, and allows a fresh later read", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const request = vi.fn().mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValue(new Response(JSON.stringify({ ref: "refs/heads/private", object: { type: "commit", sha: "a".repeat(40) } })));
  const transport = new GitHubTransport({ owner: "private-owner", repo: "private-repo", request });
  const assertion = expect(transport.ref("refs/heads/private")).rejects.toMatchObject({ code: "GIT_READ_DEADLINE" });
  await vi.advanceTimersByTimeAsync(14999);
  expect(request.mock.calls[0][1].signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await assertion;
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][1].signal.aborted).toBe(true);
  expect(JSON.stringify(log.mock.calls)).not.toContain("private");
  expect(await transport.ref("refs/heads/private")).toBe("a".repeat(40));
  expect(request).toHaveBeenCalledTimes(2);
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
