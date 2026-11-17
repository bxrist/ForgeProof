import type { ErrorRequestHandler } from "express";

// Only classify the explicit transport signal. Never retry a request or
// substitute stale state when authoritative storage is unavailable.
export const gitAvailabilityError: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent || err?.code !== "GIT_RATE_LIMITED") {
    return next(err);
  }
  console.warn("[git-store] Request unavailable: GIT_RATE_LIMITED");
  res.setHeader("Cache-Control", "no-store");
  return res.status(503).json({
    message: "Authoritative storage temporarily unavailable",
    code: "GIT_RATE_LIMITED",
  });
};
