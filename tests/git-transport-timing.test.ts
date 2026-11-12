import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-ignore Existing runtime module is JavaScript.
import { GitHubTransport } from "../server/git-store/github-store.mjs";

afterEach(() => vi.restoreAllMocks());

describe("safe Git transport timing", () => {
  it("records slow calls without private path or payload data", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(1500);
    const request = vi.fn().mockResolvedValue({ status: 201, text: async () => '{"sha":"private-response"}' });
    const transport = new GitHubTransport({ owner: "private-owner", repo: "private-repo", request });
    expect(await transport.call("/git/blobs", "POST", { content: "private-content" }))
      .toEqual({ status: 201, json: { sha: "private-response" } });
    expect(request).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("[git-store] Transport timing",
      JSON.stringify({ operation: "POST:blobs", status: 201, durationMs: 1500, retries: 0 }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
  });

  it("propagates transport failures without logging exception details or retrying writes", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = new Error("private-credential");
    const request = vi.fn().mockRejectedValue(error);
    const transport = new GitHubTransport({ owner: "owner", repo: "repo", request });
    await expect(transport.call("/git/refs/private-ref", "PATCH", {})).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][1])).toMatchObject({
      operation: "PATCH:refs", status: null, retries: 0,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
  });

  it("does not log fast successful reads", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const transport = new GitHubTransport({ owner: "owner", repo: "repo",
      request: async () => ({ status: 200, text: async () => "{}" }) });
    await transport.call("/git/commits/private-hash");
    expect(log).not.toHaveBeenCalled();
  });
});
