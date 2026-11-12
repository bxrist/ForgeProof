import { afterEach, expect, it, vi } from "vitest";
import { IntegrityError } from "../server/git-store/store.mjs";
import { diagnosticPhase, reportStartupDiagnostic } from "../server/startupDiagnostics";

afterEach(() => vi.restoreAllMocks());
it("uses native integrity identity even though its name is Error", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const error = new IntegrityError("private evidence");
  expect(error.name).toBe("Error");
  reportStartupDiagnostic("storage", error);
  expect(JSON.parse(log.mock.calls[0][1])).toMatchObject({ category: "git_integrity", errorClass: "IntegrityError" });
  const spoof = new Error("private"); spoof.name = "IntegrityError";
  reportStartupDiagnostic("storage", spoof);
  expect(JSON.parse(log.mock.calls[1][1]).category).toBe("initialization_error");
});
it("correlates connector and startup failures, preserves exception, logs only safe fields", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const cause = Object.assign(new Error("private-token"), { code: "ECONNRESET" });
  const error = Object.assign(new TypeError("https://private-url", { cause }), {
    code: "private-code", headers: "private-header", body: "private-body",
  });
  await expect(diagnosticPhase("connector_proxy", async () => { throw error; })).rejects.toBe(error);
  reportStartupDiagnostic("storage", error);
  const records = log.mock.calls.map(c => JSON.parse(c[1]));
  expect(records[0]).toMatchObject({ phase: "connector_proxy", code: null, causeCode: "ECONNRESET", errorClass: "TypeError" });
  expect(records[0].bootId).toBe(records[1].bootId);
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|https:|stack/);
  expect(Object.keys(records[0]).sort()).toEqual(["bootId", "phase", "outcome", "category", "errorClass", "code", "causeCode"].sort());
});
it("does not log successful connector operations or arbitrary thrown objects", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await diagnosticPhase("connector_setup", async () => 42)).toBe(42);
  expect(log).not.toHaveBeenCalled();
  reportStartupDiagnostic("storage", { secret: "private", name: "IntegrityError", code: "ECONNRESET" });
  expect(JSON.parse(log.mock.calls[0][1])).toMatchObject({ errorClass: "Unknown", code: null });
  expect(JSON.stringify(log.mock.calls)).not.toContain("private");
});
