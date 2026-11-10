import { randomUUID } from "node:crypto";
import { pool } from "../server/db";
import { getUncachableStripeClient } from "../server/stripeClient";
import { getConfiguredWebhookTargets } from "../server/stripeAdmin";
import { EXPECTED_STRIPE_ACCOUNT_ID, EXPECTED_STRIPE_CATALOG } from "../server/stripeConfig";
import { FORGEPROOF_SANDBOX_ACCOUNT_ID } from "../server/stripeSandboxCatalog";

// Exercise the actual development HTTP handler without a customer or payment.
// Signing material stays in process memory and is never printed or written.
async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Development only");
  if (EXPECTED_STRIPE_ACCOUNT_ID !== FORGEPROOF_SANDBOX_ACCOUNT_ID) throw new Error("Wrong account");
  const stripe = await getUncachableStripeClient();
  if ((await stripe.balance.retrieve()).livemode !== false) throw new Error("Sandbox only");
  const target = getConfiguredWebhookTargets().currentTarget;
  if (!target || target.environment !== "development") throw new Error("No development target");
  const rows = await pool.query(
    `SELECT secret FROM stripe."_managed_webhooks" WHERE account_id = $1 AND url = $2 AND secret IS NOT NULL`,
    [EXPECTED_STRIPE_ACCOUNT_ID, target.url],
  );
  if (rows.rows.length !== 1) throw new Error("Expected exactly one signing secret");
  const product = await stripe.products.retrieve(EXPECTED_STRIPE_CATALOG.pro.productId);
  const payload = JSON.stringify({
    id: `evt_forgeproof_verification_${randomUUID().replaceAll("-", "")}`,
    object: "event", type: "product.updated", livemode: false,
    created: Math.floor(Date.now() / 1000), data: { object: product },
  });
  const sign = (timestamp?: number, body = payload) => stripe.webhooks.generateTestHeaderString({
    payload: body, secret: rows.rows[0].secret, timestamp,
  });
  const signature = sign();
  const foreignPayload = JSON.stringify({
    id: `evt_forgeproof_foreign_rejection_${randomUUID().replaceAll("-", "")}`,
    object: "event", type: "product.updated", livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: "prod_foreign_test", metadata: { product: "crowsnest" } } },
  });
  const cases = [
    { name: "missing_signature", payload, signature: undefined, expected: 400 },
    { name: "tampered_payload", payload: `${payload} `, signature, expected: 400 },
    { name: "expired_signature", payload, signature: sign(Math.floor(Date.now() / 1000) - 600), expected: 400 },
    { name: "valid_signed_product_event", payload, signature, expected: 200 },
    { name: "signed_foreign_product_ignored", payload: foreignPayload,
      signature: sign(undefined, foreignPayload), expected: 200, ignored: true },
  ];
  for (const test of cases) {
    const response = await fetch(target.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(test.signature ? { "stripe-signature": test.signature } : {}) },
      body: test.payload,
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    console.log(JSON.stringify({ test: test.name, status: response.status, passed: response.status === test.expected }));
    if (response.status !== test.expected) throw new Error("Webhook verification failed");
    if (test.ignored && (await response.json()).ignored !== true) {
      throw new Error("Foreign event was not explicitly ignored");
    }
  }
}
main().then(() => process.exit(0)).catch(() => {
  console.error("Sandbox webhook verification failed; sensitive details withheld");
  process.exit(1);
});
