import { EXPECTED_STRIPE_CATALOG, STRIPE_LIVE_MODE } from "./stripeConfig";
import { storage } from "./storage";
import { getUncachableStripeClient } from "./stripeClient";
import { assertNotLifeosBillingSubject } from "./lifeosEntitlement";

const objectId = (value: any): string | undefined => typeof value === "string" ? value : value?.id;
export const invoiceSubscriptionId = (invoice: any): string | undefined =>
  objectId(invoice.subscription) || objectId(invoice.parent?.subscription_details?.subscription);

export function subscriptionPlan(sub: any): "pro" | "enterprise" | null {
  if (!sub || sub.livemode !== STRIPE_LIVE_MODE || sub.metadata?.tenantId) return null;
  // Preserve already-issued sandbox subscriptions. Live requires explicit ownership.
  if (sub.metadata?.product !== "forgeproof" &&
      (STRIPE_LIVE_MODE || sub.metadata?.product)) return null;
  const items = sub.items?.data;
  if (!Array.isArray(items) || items.length !== 1 || sub.items?.has_more) return null;
  const item = items[0];
  if (item.quantity !== 1) return null;
  const price = item.price;
  for (const plan of ["pro", "enterprise"] as const) {
    const pin = EXPECTED_STRIPE_CATALOG[plan];
    if (price?.id === pin.priceId && objectId(price.product) === pin.productId &&
        price.livemode === STRIPE_LIVE_MODE && price.unit_amount === pin.amount &&
        price.currency === pin.currency && price.recurring?.interval === pin.interval &&
        price.recurring?.interval_count === 1 &&
        sub.metadata?.plan === plan) return plan;
  }
  return null;
}

export async function ownsSubscription(sub: any): Promise<boolean> {
  if (!subscriptionPlan(sub) || !sub.metadata?.userId) return false;
  try { assertNotLifeosBillingSubject(sub.metadata.userId); } catch { return false; }
  const user = await storage.getUser(sub.metadata.userId);
  if (!user || !user.stripeCustomerId || user.stripeCustomerId !== objectId(sub.customer)) return false;
  const stripe = await getUncachableStripeClient();
  const customer = await stripe.customers.retrieve(user.stripeCustomerId);
  return !customer.deleted && customer.livemode === STRIPE_LIVE_MODE &&
    !customer.metadata.tenantId && customer.metadata.userId === user.id &&
    (customer.metadata.product === "forgeproof" || (!STRIPE_LIVE_MODE && !customer.metadata.product));
}

// Called only after signature verification, before mirroring or entitlement effects.
export async function ownsStripeEvent(event: any): Promise<boolean> {
  if (event.livemode !== STRIPE_LIVE_MODE) return false;
  const obj = event.data?.object;
  if (!obj || obj.metadata?.tenantId || (obj.metadata?.product && obj.metadata.product !== "forgeproof")) return false;
  if (event.type.startsWith("customer.subscription.")) return ownsSubscription(obj);
  if (event.type.startsWith("product.")) return Object.values(EXPECTED_STRIPE_CATALOG).some(p => p.productId === obj.id);
  if (event.type.startsWith("price.")) return Object.values(EXPECTED_STRIPE_CATALOG).some(p =>
    p.priceId === obj.id && p.productId === objectId(obj.product));
  if (event.type === "checkout.session.completed" || event.type.startsWith("invoice.")) {
    const id = event.type.startsWith("invoice.") ? invoiceSubscriptionId(obj) : objectId(obj.subscription);
    if (!id) return false;
    const stripe = await getUncachableStripeClient();
    const sub = await stripe.subscriptions.retrieve(id);
    return objectId(obj.customer) === objectId(sub.customer) && await ownsSubscription(sub);
  }
  return false;
}
