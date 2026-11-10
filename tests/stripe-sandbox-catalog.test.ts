import { describe, it, expect, vi } from "vitest";
import { ensureForgeProofSandboxCatalog, FORGEPROOF_SANDBOX_ACCOUNT_ID } from "../server/stripeSandboxCatalog";

function fixture(account = FORGEPROOF_SANDBOX_ACCOUNT_ID, live = false) {
  const products: any[] = [];
  const prices: any[] = [];
  const stripe = {
    accounts: { retrieve: vi.fn(async () => ({ id: account })) },
    balance: { retrieve: vi.fn(async () => ({ livemode: live })) },
    products: {
      list: async function* () { yield* products; },
      create: vi.fn(async (params) => {
        const product = { ...params, id: `prod_${products.length}`, active: true, livemode: false };
        products.push(product);
        return product;
      }),
    },
    prices: {
      list: async function* ({ product }: any) { yield* prices.filter(p => p.product === product); },
      create: vi.fn(async (params) => {
        const price = { ...params, id: `price_${prices.length}`, active: true, livemode: false,
          recurring: { ...params.recurring, interval_count: 1, usage_type: "licensed" }, billing_scheme: "per_unit" };
        prices.push(price);
        return price;
      }),
    },
  };
  return { stripe, products, prices };
}

describe("ForgeProof-only sandbox catalog recreation", () => {
  it("rejects every other account before writes or catalog reads", async () => {
    const { stripe } = fixture("acct_other_project");
    await expect(ensureForgeProofSandboxCatalog(stripe as any)).rejects.toThrow("outside");
    expect(stripe.balance.retrieve).not.toHaveBeenCalled();
    expect(stripe.products.create).not.toHaveBeenCalled();
    expect(stripe.prices.create).not.toHaveBeenCalled();
  });
  it("rejects live-mode access", async () => {
    const { stripe } = fixture(undefined, true);
    await expect(ensureForgeProofSandboxCatalog(stripe as any)).rejects.toThrow("live-mode");
    expect(stripe.products.create).not.toHaveBeenCalled();
  });
  it("creates exactly the two monthly USD plans and preserves IDs on rerun", async () => {
    const { stripe, prices } = fixture();
    const first = await ensureForgeProofSandboxCatalog(stripe as any);
    expect(await ensureForgeProofSandboxCatalog(stripe as any)).toEqual(first);
    expect(stripe.products.create).toHaveBeenCalledTimes(2);
    expect(stripe.prices.create).toHaveBeenCalledTimes(2);
    expect(prices.map(p => [p.unit_amount, p.currency, p.recurring.interval])).toEqual([
      [4900, "usd", "month"], [24900, "usd", "month"],
    ]);
    expect(stripe.products.create.mock.calls[0][0].name).toBe("ForgeProof Pro");
  });
  it("resumes after product creation without duplicating the product", async () => {
    const { stripe } = fixture();
    stripe.prices.create.mockRejectedValueOnce(new Error("interrupted"));
    await expect(ensureForgeProofSandboxCatalog(stripe as any)).rejects.toThrow("interrupted");
    await ensureForgeProofSandboxCatalog(stripe as any);
    expect(stripe.products.create).toHaveBeenCalledTimes(2);
  });
  it("does not adopt or overwrite an unrecognized existing product", async () => {
    const { stripe, products } = fixture();
    products.push({ id: "prod_existing", name: "ForgeProof Pro", metadata: {}, active: true, livemode: false });
    await expect(ensureForgeProofSandboxCatalog(stripe as any)).rejects.toThrow("manual review");
    expect(stripe.products.create).not.toHaveBeenCalled();
  });
});
