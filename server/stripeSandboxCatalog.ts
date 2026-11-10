import type Stripe from "stripe";

// Explicit owner-approved sandbox. Never infer the destination from a key.
export const FORGEPROOF_SANDBOX_ACCOUNT_ID = "acct_1UYEnEInfcuWjiUY";
const plans = [
  { plan: "pro", name: "ForgeProof Pro", amount: 4900 },
  { plan: "enterprise", name: "ForgeProof Enterprise", amount: 24900 },
] as const;

export async function ensureForgeProofSandboxCatalog(stripe: Stripe) {
  const account = await stripe.accounts.retrieve(null);
  if (account.id !== FORGEPROOF_SANDBOX_ACCOUNT_ID) {
    throw new Error("Refusing catalog writes outside the approved ForgeProof sandbox");
  }
  const balance = await stripe.balance.retrieve();
  if (balance.livemode !== false) {
    throw new Error("Refusing catalog writes with live-mode credentials");
  }
  const products = [];
  for await (const product of stripe.products.list({ limit: 100 })) products.push(product);
  const result = [];
  for (const plan of plans) {
    const candidates = products.filter(p => p.name === plan.name || p.metadata.forgeproof_plan === plan.plan);
    if (candidates.length > 1) throw new Error("Ambiguous sandbox catalog; no duplicate will be created");
    let product = candidates[0];
    if (product && (!product.active || product.livemode ||
        product.metadata.forgeproof_plan !== plan.plan || product.name !== plan.name)) {
      throw new Error("Existing product requires manual review");
    }
    if (!product) {
      product = await stripe.products.create({
        name: plan.name,
        metadata: { forgeproof_plan: plan.plan },
      }, { idempotencyKey: `forgeproof-sandbox-catalog-v1-${plan.plan}-product` });
    }
    const prices = [];
    for await (const price of stripe.prices.list({ product: product.id, limit: 100 })) prices.push(price);
    const matches = prices.filter(p => p.active && !p.livemode &&
      p.unit_amount === plan.amount && p.currency === "usd" &&
      p.recurring?.interval === "month" && p.recurring.interval_count === 1 &&
      p.recurring.usage_type === "licensed" && p.billing_scheme === "per_unit");
    if (matches.length > 1) throw new Error("Ambiguous sandbox prices; no duplicate will be created");
    let price = matches[0];
    if (!price) {
      if (prices.length) throw new Error("Existing prices require manual review");
      price = await stripe.prices.create({
        product: product.id,
        unit_amount: plan.amount,
        currency: "usd",
        recurring: { interval: "month" },
      }, { idempotencyKey: `forgeproof-sandbox-catalog-v1-${plan.plan}-price` });
    }
    result.push({ plan: plan.plan, productId: product.id, priceId: price.id, amount: plan.amount });
  }
  return result;
}
