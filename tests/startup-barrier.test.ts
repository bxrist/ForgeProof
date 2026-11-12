import { readFileSync } from "node:fs";
import type { Request, Response, NextFunction } from "express";
import { describe, expect, it, vi } from "vitest";
import { createStartupBarrier } from "../server/startupBarrier";

function fixture() {
  const barrier = createStartupBarrier();
  const downstream = vi.fn();
  const parsed = vi.fn();
  function dispatch(method: string, path: string) {
    const req = { method: method.toUpperCase(), path } as Request;
    // Accessing a body before the barrier releases is a test failure, including
    // failed startup. No socket binding is needed for these synthetic checks.
    Object.defineProperty(req, "body", { get() { parsed(); return "synthetic-secret"; } });
    const res = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      text: "",
      setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; },
      status(code: number) { this.statusCode = code; return this; },
      type: vi.fn().mockReturnThis(),
      send(body: string) { this.text = body; return this; },
    };
    const next = vi.fn(() => { downstream(req.body); });
    barrier.middleware(req, res as unknown as Response, next as NextFunction);
    return { ...res, status: res.statusCode, next };
  }
  return { dispatch, barrier, downstream, parsed };
}

describe("startup liveness without application readiness", () => {
  it.each(["get", "head"] as const)("allows only %s root liveness with no-store", async method => {
    const { dispatch, downstream, parsed } = fixture();
    const res = dispatch(method, "/");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text).toBe("Starting\n");
    expect(downstream).not.toHaveBeenCalled();
    expect(parsed).not.toHaveBeenCalled();
  });
  it.each([
    ["get", "/api/lifeos/status"], ["post", "/api/lifeos/attest"],
    ["get", "/dashboard"], ["post", "/api/stripe/webhook"],
    ["post", "/webhooks/test"], ["get", "/api/__clerk/v1/client"],
    ["post", "/api/__clerk/v1/client"], ["post", "/"],
    ["options", "/"], ["head", "/api/verify/chain"], ["get", "/unknown"],
  ] as const)("blocks %s %s before parsers and proxy handlers", async (method, path) => {
    const { dispatch, downstream, parsed } = fixture();
    const res = dispatch(method, path);
    expect(res.status).toBe(503);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text ?? "").not.toContain("synthetic");
    expect(parsed).not.toHaveBeenCalled();
    expect(downstream).not.toHaveBeenCalled();
  });
  it("calls next only after initialization is complete", async () => {
    const { dispatch, barrier, downstream, parsed } = fixture();
    barrier.ready();
    expect(dispatch("post", "/api/stripe/webhook").next).toHaveBeenCalledOnce();
    expect(parsed).toHaveBeenCalledOnce();
    expect(downstream).toHaveBeenCalledOnce();
  });
  it("failure closes even root liveness and cannot subsequently become ready", async () => {
    const { dispatch, barrier, downstream } = fixture();
    barrier.fail();
    barrier.ready();
    for (const path of ["/", "/dashboard", "/api/lifeos/status"]) {
      const res = dispatch("get", path);
      expect(res.status).toBe(503);
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    expect(downstream).not.toHaveBeenCalled();
  });
  it("commercial entrypoint binds before replay and releases only after route/static setup", () => {
    // Regression for the 2026-11-12 Replit deadline: signed replay formerly
    // preceded listen(). Root 200 is liveness only; real platform proof still
    // requires a later deployment, which this source-only test cannot establish.
    const source = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
    const position = (text: string) => { const n = source.indexOf(text); expect(n).toBeGreaterThan(-1); return n; };
    const barrier = position("app.use(startupBarrier.middleware)");
    for (const handler of ["app.use(CLERK_PROXY_PATH", "app.post(", "express.raw(", "express.json(", "clerkMiddleware((req)"]) {
      expect(barrier).toBeLessThan(position(handler));
    }
    expect(position("httpServer.listen(")).toBeLessThan(position("await initializeApplicationStorage()"));
    const ready = position("startupBarrier.ready()");
    for (const setup of ["await initializeApplicationStorage()", "await registerRoutes(", "serveStatic(app)", "await setupVite("]) {
      expect(position(setup)).toBeLessThan(ready);
    }
    for (const worker of ["startReceiptOutboxWorker();", "await runCommitHealthCheck()", "flushEmailQueue().catch", "await runMigrations("]) {
      expect(position(worker)).toBeGreaterThan(ready);
    }
    expect(source).toContain('FORGEPROOF_ISOLATED_STAGING === "true" ? "127.0.0.1" : "0.0.0.0"');
    expect(source).toContain("})().catch(failStartup)");
    expect(source).toContain("startupBarrier.fail();");
    expect(source).toContain("process.exit(1)");
  });
});
