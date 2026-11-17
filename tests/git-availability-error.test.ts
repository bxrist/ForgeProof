import { afterEach, expect, it, vi } from "vitest";
import { gitAvailabilityError } from "../server/middlewares/gitAvailabilityError";
import { GitHubTransport } from "../server/git-store/github-store.mjs";

afterEach(() => vi.restoreAllMocks());

it("maps a real exhausted Git ref rate limit to sanitized noncached 503 without retry", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  const upstream = vi.fn().mockResolvedValue(new Response("private provider data", { status: 429 }));
  const transport = new GitHubTransport({ owner: "private-owner", repo: "private-repo", request: upstream });
  // Exercise the actual transport exception and middleware without opening a
  // listening socket (the isolated source sandbox forbids socket creation).
  const error = await transport.call("/git/ref/heads/main").catch(error => error);
  const res = { headersSent: false, setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  const next = vi.fn();
  gitAvailabilityError(error, {} as any, res as any, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(503);
  expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  expect(res.json).toHaveBeenCalledWith({
    message: "Authoritative storage temporarily unavailable", code: "GIT_RATE_LIMITED",
  });
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls).toEqual([["[git-store] Request unavailable: GIT_RATE_LIMITED"]]);
});

it("never exposes arbitrary error details for the recognized code", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const res = { headersSent: false, setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  gitAvailabilityError({ code: "GIT_RATE_LIMITED", message: "secret", stack: "private", token: "credential" },
    {} as any, res as any, vi.fn());
  expect(JSON.stringify([warn.mock.calls, res.json.mock.calls])).not.toMatch(/secret|private|credential/);
});

it.each([
  { status: 401 }, { status: 403 }, { code: "INTEGRITY_ERROR" },
  new Error("Git transport rate limited"), { code: "ECONNRESET" },
])("leaves other errors unchanged", error => {
  const next = vi.fn();
  const res = { headersSent: false, status: vi.fn() };
  gitAvailabilityError(error, {} as any, res as any, next);
  expect(next).toHaveBeenCalledWith(error);
  expect(res.status).not.toHaveBeenCalled();
});

it("delegates errors after headers were sent", () => {
  const error = { code: "GIT_RATE_LIMITED" };
  const next = vi.fn();
  gitAvailabilityError(error, {} as any, { headersSent: true } as any, next);
  expect(next).toHaveBeenCalledWith(error);
});
