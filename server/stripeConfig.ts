/**
 * Stripe identity and catalog pins are application invariants.  Keeping them
 * separate from the admin/readiness implementation lets ordinary billing
 * paths enforce the same pins without creating an import cycle.
 */
export const STRIPE_LIVE_MODE = process.env.FORGEPROOF_STRIPE_MODE === "live";
if (process.env.FORGEPROOF_STRIPE_MODE && !["sandbox", "live"].includes(process.env.FORGEPROOF_STRIPE_MODE)) {
  throw new Error("Invalid ForgeProof Stripe mode");
}
if (STRIPE_LIVE_MODE && process.env.NODE_ENV !== "production") {
  throw new Error("Live Stripe mode is restricted to production");
}
function livePin(name: string, prefix: string): string {
  const value = process.env[name];
  if (!value || !value.startsWith(prefix)) throw new Error(`Missing or invalid ${name}`);
  return value;
}
export const EXPECTED_STRIPE_ACCOUNT_ID = STRIPE_LIVE_MODE
  ? "acct_1SdMtvEa3WEFa6OF" : "acct_1UYEnEInfcuWjiUY";

export const EXPECTED_STRIPE_CATALOG = {
  pro: {
    productId: STRIPE_LIVE_MODE ? livePin("FORGEPROOF_LIVE_PRO_PRODUCT_ID", "prod_") : "prod_VZhE1gWXMlDtNp",
    priceId: STRIPE_LIVE_MODE ? livePin("FORGEPROOF_LIVE_PRO_PRICE_ID", "price_") : "price_1UYXq2InfcuWjiUYHY3UVVMe",
    name: "ForgeProof Pro",
    amount: 4900,
    currency: "usd",
    interval: "month",
  },
  enterprise: {
    productId: STRIPE_LIVE_MODE ? livePin("FORGEPROOF_LIVE_ENTERPRISE_PRODUCT_ID", "prod_") : "prod_VZhEksM2LE0MCk",
    priceId: STRIPE_LIVE_MODE ? livePin("FORGEPROOF_LIVE_ENTERPRISE_PRICE_ID", "price_") : "price_1UYXq3InfcuWjiUYpAxezBwK",
    name: "ForgeProof Enterprise",
    amount: 24900,
    currency: "usd",
    interval: "month",
  },
} as const;
