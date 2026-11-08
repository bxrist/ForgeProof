import type { Request } from "express";

export const LIFEOS_SERVICE_ACCOUNT = "lifeos-service-0a";

// Only a live, server-authenticated OIDC session can receive this read-only grant.
// No email, request parameters, API keys, or organization roles confer access.
export function canReadLifeosReceipts(req: Request): boolean {
  const subject = process.env.FORGEPROOF_LIFEOS_OWNER_SUB;
  const issuer = process.env.FORGEPROOF_LIFEOS_OWNER_ISSUER;
  const user = req.user as { claims?: { sub?: string; iss?: string }; expires_at?: number } | undefined;
  return !!subject && subject.trim() === subject && !!issuer
    && issuer === (process.env.ISSUER_URL ?? "https://replit.com/oidc")
    && req.isAuthenticated?.() === true
    && typeof user?.expires_at === "number"
    && user.expires_at > Math.floor(Date.now() / 1000)
    && user.claims?.sub === subject && user.claims?.iss === issuer;
}

export function isLifeosReceipt(receipt: { userId: string }): boolean {
  return receipt.userId === LIFEOS_SERVICE_ACCOUNT;
}

export function canReadDashboardReceipt(req: Request, receipt: { userId: string }): boolean {
  if (isLifeosReceipt(receipt)) return canReadLifeosReceipts(req);
  const user = req.user as { claims?: { sub?: string }; id?: string } | undefined;
  return receipt.userId === "forgeproof-system"
    || (!!req.isAuthenticated?.() && receipt.userId === (user?.claims?.sub || user?.id));
}

