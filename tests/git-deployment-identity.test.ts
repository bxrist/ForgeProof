import { afterEach, describe, expect, it, vi } from "vitest";
import { DeploymentIdentityBroker, isReplitDeployment, localMint } from "../server/git-store/deploymentIdentity";

const futureJwt = (exp: number) => [
  Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ iss: "mock", exp })).toString("base64url"),
  "fixture-signature",
].join(".");
const env = { REPLIT_DEPLOYMENT_ID: "deployment-fixture", REPLIT_CONNECTORS_AUDIENCE: "connectors.replit.com" };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("bounded Replit deployment identity broker", () => {
  it("recognizes deployment and leaves Replit editor/conrun behavior unchanged", () => {
    expect(isReplitDeployment({ REPL_IDENTITY: "mock" })).toBe(false);
    expect(isReplitDeployment({ REPLIT_DEPLOYMENT_ID: "d" })).toBe(true);
    expect(isReplitDeployment({ REPLIT_DEPLOYMENT_ID: "d", REPLIT_CONRUN: "1" })).toBe(false);
  });
  it("reuses a JWT only within expiry bounds and refreshes after its short lease", async () => {
    let now = 1_800_000_000_000;
    const cli = vi.fn().mockResolvedValueOnce(futureJwt(now / 1000 + 360))
      .mockResolvedValueOnce(futureJwt(now / 1000 + 400));
    const local = vi.fn();
    const report = vi.fn();
    const broker = new DeploymentIdentityBroker({ cli, local }, () => now, report);
    const initial = await broker.headers(env);
    for (let n = 0; n < 120; n++) expect(await broker.headers(env)).toEqual(initial);
    expect(cli).toHaveBeenCalledTimes(1);
    expect(local).not.toHaveBeenCalled();
    now += 20_001;
    expect(await broker.headers(env)).not.toEqual(initial);
    expect(cli).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ stage: "broker", outcome: "cache_hit" }));
    expect(JSON.stringify(report.mock.calls)).not.toContain("fixture-signature");
  });
  it("does not cache opaque or near-expiry tokens", async () => {
    let now = 1_800_000_000_000;
    const cli = vi.fn().mockResolvedValueOnce("opaque").mockResolvedValueOnce("opaque-2")
      .mockResolvedValueOnce(futureJwt(now / 1000 + 5));
    const broker = new DeploymentIdentityBroker({ cli, local: vi.fn() }, () => now, vi.fn());
    expect(await broker.headers(env)).toEqual({ "X-Replit-Token": "depl opaque" });
    expect(await broker.headers(env)).toEqual({ "X-Replit-Token": "depl opaque-2" });
    expect(await broker.headers(env)).toHaveProperty("X-Replit-Token");
    expect(cli).toHaveBeenCalledTimes(3);
  });
  it("coalesces concurrent identity acquisition and scopes audiences", async () => {
    let complete: ((t: string) => void) | undefined;
    const cli = vi.fn(() => new Promise<string>(resolve => { complete = resolve; }));
    const broker = new DeploymentIdentityBroker({ cli, local: vi.fn() }, Date.now, vi.fn());
    const first = Promise.all(Array.from({ length: 40 }, () => broker.headers(env)));
    expect(cli).toHaveBeenCalledTimes(1);
    complete!("opaque");
    const responses = await first;
    expect(responses).toHaveLength(40);
    expect(responses.every(r => r["X-Replit-Token"] === "depl opaque")).toBe(true);
    const next = broker.headers({ ...env, REPLIT_CONNECTORS_AUDIENCE: "other.example" });
    expect(cli).toHaveBeenCalledTimes(2);
    complete!("other");
    expect((await next)["X-Replit-Token"]).toBe("depl other");
  });
  it("gives fallback its own full 5000 ms budget after CLI timeout", async () => {
    const cli = vi.fn().mockRejectedValue(Object.assign(new Error("private timeout"), { killed: true }));
    const local = vi.fn().mockResolvedValue("local-opaque");
    const records: any[] = [];
    const broker = new DeploymentIdentityBroker({ cli, local }, Date.now, e => records.push(e));
    expect(await broker.headers(env)).toEqual({ "X-Replit-Token": "depl local-opaque" });
    expect(local).toHaveBeenCalledWith("https://connectors.replit.com", 5000);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "cli", outcome: "timeout", budgetMs: 5000 }),
      expect.objectContaining({ stage: "local", outcome: "success", budgetMs: 5000 }),
    ]));
    expect(JSON.stringify(records)).not.toMatch(/private timeout|local-opaque/);
  });
  it("fails closed on both unavailable identity paths and clears failed shared work", async () => {
    const cli = vi.fn().mockRejectedValue(new Error("private"));
    const local = vi.fn().mockRejectedValueOnce(new Error("failed")).mockResolvedValue("recovered");
    const report = vi.fn();
    const broker = new DeploymentIdentityBroker({ cli, local }, Date.now, report);
    await expect(broker.headers(env)).rejects.toThrow("Deployment identity unavailable");
    expect((await broker.headers(env))["X-Replit-Token"]).toBe("depl recovered");
    expect(local).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(report.mock.calls)).not.toContain("private");
  });
  it("invalidates on authorization denial without replaying writes", async () => {
    const cli = vi.fn().mockResolvedValue(futureJwt(Date.now() / 1000 + 600));
    const broker = new DeploymentIdentityBroker({ cli, local: vi.fn() }, Date.now, vi.fn());
    await broker.headers(env);
    await broker.headers(env);
    expect(cli).toHaveBeenCalledTimes(1);
    broker.invalidate();
    await broker.headers(env);
    expect(cli).toHaveBeenCalledTimes(2);
  });
  it("never shares a cache across deployment identity contexts", async () => {
    const cli = vi.fn().mockResolvedValue(futureJwt(Date.now() / 1000 + 600));
    const broker = new DeploymentIdentityBroker({ cli, local: vi.fn() }, Date.now, vi.fn());
    await broker.headers(env);
    await broker.headers({ ...env, REPLIT_DEPLOYMENT_ID: "another-deployment" });
    expect(cli).toHaveBeenCalledTimes(2);
  });
  it("local endpoint rejects HTTP 401 without retry or fallback to unauthenticated content", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("private", { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    await expect(localMint("https://connectors.replit.com", 200)).rejects.toThrow("Deployment identity unavailable");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("local endpoint retries HTTP 503 with bounded budget", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ identityToken: "opaque-fixture" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    expect(await localMint("https://connectors.replit.com", 900)).toBe("opaque-fixture");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

import { connectorRequest } from "../server/git-store/githubRuntime";
import { deploymentIdentityBroker } from "../server/git-store/deploymentIdentity";
it("uses the per-process broker for deployed SDK requests and invalidates on denial without replay", async () => {
  vi.stubEnv("REPLIT_DEPLOYMENT_ID", "test-deployment");
  const acquire = vi.spyOn(deploymentIdentityBroker, "headers")
    .mockResolvedValue({ "X-Replit-Token": "depl private-test-token" });
  const clear = vi.spyOn(deploymentIdentityBroker, "invalidate").mockImplementation(() => {});
  const fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
  vi.stubGlobal("fetch", fetch);
  const response = await connectorRequest("/repos/o/r/git/blobs", { method: "POST", body: "{}" });
  expect(response.status).toBe(401);
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(clear).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("never writes identity values into sanitized diagnostics", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const sensitive = futureJwt(Date.now() / 1000 + 300);
  const broker = new DeploymentIdentityBroker({ cli: vi.fn().mockResolvedValue(sensitive), local: vi.fn() });
  await broker.headers(env);
  await broker.headers(env);
  expect(JSON.stringify(log.mock.calls)).not.toContain(sensitive);
  expect(JSON.stringify(log.mock.calls)).not.toContain("X-Replit-Token");
  expect(JSON.stringify(log.mock.calls)).not.toContain("deployment-fixture");
});
