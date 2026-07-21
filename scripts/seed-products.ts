import { getUncachableStripeClient } from "../server/stripeClient";

async function createProducts() {
  const stripe = await getUncachableStripeClient();

  const plans = [
    { name: "ForgeProof Pro", description: "10,000 attestations/month, 10 API keys, team features, email support", amount: 4900, plan: "pro" },
    { name: "ForgeProof Enterprise", description: "Unlimited attestations, unlimited API keys, SSO, SLA, priority support", amount: 24900, plan: "enterprise" },
  ];

  for (const p of plans) {
    const existing = await stripe.products.search({ query: `name:'${p.name}' AND active:'true'` });
    if (existing.data.length > 0) {
      console.log(`${p.name} already exists (${existing.data[0].id})`);
      continue;
    }
    const product = await stripe.products.create({
      name: p.name,
      description: p.description,
      metadata: { plan: p.plan },
    });
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: p.amount,
      currency: "usd",
      recurring: { interval: "month" },
    });
    console.log(`Created ${p.name}: ${product.id} / ${price.id} ($${p.amount / 100}/mo)`);
  }
  console.log("Done.");
}

createProducts().catch((e) => {
  console.error(e);
  process.exit(1);
});
