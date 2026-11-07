import { csrfSync } from "csrf-sync";
import { isIP } from "node:net";
import type { Request, RequestHandler } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

// UI anonymous ingress only: trust forwarded addresses from explicit proxy IPs.
// Without configuration, anonymous UI traffic shares the transport quota (1200/15min).
// Authenticated UI traffic is keyed by user; existing API limiters use Express IP keying.
export function createTransportRateLimitKey(trustedProxyIps: string[]) {
  const normalize = (ip: string) => ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const trusted = new Set(trustedProxyIps.map(normalize).filter(ip => isIP(ip)));
  return (req: Request): string => {
    let address = normalize(req.socket.remoteAddress || "unknown");
    const forwarded = req.get("x-forwarded-for")?.split(",").map(ip => normalize(ip.trim())) || [];
    if (forwarded.every(ip => isIP(ip))) {
      for (let i = forwarded.length - 1; i >= 0 && trusted.has(address); i--) {
        address = forwarded[i];
      }
    }
    return ipKeyGenerator(address);
  };
}

export const transportRateLimitKey = createTransportRateLimitKey(
  (process.env.FORGEPROOF_TRUSTED_PROXY_IPS || "").split(",").map(ip => ip.trim()),
);

export function createUiLimiter(limit = 1200, windowMs = 15 * 60 * 1000) {
  return rateLimit({
    windowMs, limit,
    keyGenerator: (req) => {
      const user = req.user as { claims?: { sub?: string } } | undefined;
      return req.isAuthenticated?.() && user?.claims?.sub
        ? `user:${user.claims.sub}` : transportRateLimitKey(req);
    },
    standardHeaders: true, legacyHeaders: false,
    message: { message: "Too many requests, please try again later." },
  });
}

// Stateful synchronizer tokens: only a header can supply the browser token.
const { generateToken, csrfSynchronisedProtection } = csrfSync({
  size: 32,
  getTokenFromRequest: (req) => req.get("x-csrf-token"),
});

export const issueCsrfToken: RequestHandler = (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ csrfToken: generateToken(req) });
};

export const requireSessionCsrf: RequestHandler = (req, res, next) => {
  const reject = () => res.status(403).json({
    code: "CSRF_INVALID", message: "Your security token expired. Please try again.",
  });
  const origin = req.get("origin");
  const expectedOrigin = `${req.protocol}://${req.get("host")}`;
  if (req.get("sec-fetch-site") === "cross-site" ||
      (origin !== undefined && origin !== expectedOrigin)) {
    reject();
    return;
  }
  csrfSynchronisedProtection(req, res, (error) => {
    if (error) { reject(); return; }
    next();
  });
};

export const sessionCsrfProtection: RequestHandler = (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  // These routes authenticate independently of cookies. Generic attestation
  // checks CSRF only when it actually falls back to session authentication.
  const path = req.path.toLowerCase().replace(/\/+$/, "");
  if (["/api/github/webhook", "/api/stripe/webhook", "/api/mcp/tools", "/api/v1/attest",
    "/api/v1/agents/openai", "/api/v1/agents/claude", "/api/v1/agents/replit"].includes(path)) return next();
  // No authentication or token refresh here. Reject unsafe UI requests even
  // before login; authorization and its limiters remain on the UI routes.
  requireSessionCsrf(req, res, next);
};
