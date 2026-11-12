import type { RequestHandler } from "express";

// Port liveness must not expose application readiness while signed Git replay is
// pending. Install before proxies, body parsers, authentication, and all routes.
export function createStartupBarrier() {
  let state: "pending" | "ready" | "failed" = "pending";
  const middleware: RequestHandler = (req, res, next) => {
    if (state === "ready") return next();
    res.setHeader("Cache-Control", "no-store");
    if (state === "pending" && (req.method === "GET" || req.method === "HEAD") && req.path === "/") {
      res.status(200).type("text/plain").send("Starting\n");
      return;
    }
    res.setHeader("Retry-After", "5");
    res.status(503).type("text/plain").send("Service unavailable\n");
  };
  return {
    middleware,
    ready() { if (state === "pending") state = "ready"; },
    fail() { state = "failed"; },
  };
}
