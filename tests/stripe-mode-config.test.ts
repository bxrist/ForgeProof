import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
describe("explicit billing environment selection", () => {
  it("does not enable live mode merely because live secrets exist", async () => {
    vi.resetModules();
    vi.stubEnv("FORGEPROOF_STRIPE_MODE", undefined);
    vi.stubEnv("FORGEPROOF_LIVE_STRIPE_SECRET_KEY", "dummy-live-key");
    const config = await import("../server/stripeConfig");
    expect(config.STRIPE_LIVE_MODE).toBe(false);
    expect(config.EXPECTED_STRIPE_ACCOUNT_ID).toBe("acct_1UYEnEInfcuWjiUY");
  });
  it("refuses live mode in development", async () => {
    vi.resetModules(); vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("FORGEPROOF_STRIPE_MODE", "live");
    await expect(import("../server/stripeConfig")).rejects.toThrow("restricted to production");
  });
  it("refuses live mode without live catalog pins", async () => {
    vi.resetModules(); vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("FORGEPROOF_STRIPE_MODE", "live");
    vi.stubEnv("FORGEPROOF_LIVE_PRO_PRODUCT_ID", undefined);
    await expect(import("../server/stripeConfig")).rejects.toThrow("FORGEPROOF_LIVE_PRO_PRODUCT_ID");
  });
  it("selects the verified live account and dedicated live credential without fallback", async () => {
    vi.resetModules(); vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("FORGEPROOF_STRIPE_MODE", "live");
    for (const plan of ["PRO", "ENTERPRISE"]) {
      vi.stubEnv(`FORGEPROOF_LIVE_${plan}_PRODUCT_ID`, `prod_${plan}`);
      vi.stubEnv(`FORGEPROOF_LIVE_${plan}_PRICE_ID`, `price_${plan}`);
    }
    vi.stubEnv("FORGEPROOF_LIVE_STRIPE_SECRET_KEY", "dummy-live-key");
    const config = await import("../server/stripeConfig");
    expect(config.EXPECTED_STRIPE_ACCOUNT_ID).toBe("acct_1SdMtvEa3WEFa6OF");
    const { getStripeCredentials } = await import("../server/stripeClient");
    expect((await getStripeCredentials()).secretKey).toBe("dummy-live-key");
    vi.stubEnv("FORGEPROOF_LIVE_STRIPE_SECRET_KEY", undefined);
    await expect(getStripeCredentials()).rejects.toThrow("Missing ForgeProof live");
  });
});
