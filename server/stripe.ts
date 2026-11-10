import { getUncachableStripeClient } from "./stripeClient";
import { assertNotLifeosBillingSubject } from "./lifeosEntitlement";
import { storage } from "./storage";
import { currentApplicationStorage } from "./storageBackend";
import type { GitStorage } from "./git-store/storage";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { PLAN_LIMITS, type PlanType } from "@shared/schema";
import {
  EXPECTED_STRIPE_ACCOUNT_ID,
  EXPECTED_STRIPE_CATALOG,
} from "./stripeConfig";
import { STRIPE_LIVE_MODE } from "./stripeConfig";
import { invoiceSubscriptionId, ownsStripeEvent, ownsSubscription, subscriptionPlan } from "./stripeOwnership";

async function assertCustomerOwnership(stripe: Awaited<ReturnType<typeof getUncachableStripeClient>>, id: string, userId: string) {
  const customer = await stripe.customers.retrieve(id);
  if (customer.deleted || customer.livemode !== STRIPE_LIVE_MODE ||
      customer.metadata.tenantId || customer.metadata.userId !== userId ||
      (customer.metadata.product !== "forgeproof" && (STRIPE_LIVE_MODE || customer.metadata.product))) {
    throw new Error("Stripe customer ownership mismatch");
  }
}

export const PLAN_PRICES: Record<string, { name: string; amount: number }> = {
  pro: { name: "ForgeProof Pro", amount: 4900 },
  enterprise: { name: "ForgeProof Enterprise", amount: 24900 },
};

export async function getPriceIdForPlan(plan: "pro" | "enterprise"): Promise<string | null> {
  const expected = EXPECTED_STRIPE_CATALOG[plan];
  if (currentApplicationStorage()) {
    const stripe=await getUncachableStripeClient();
    const [account,product,price]=await Promise.all([stripe.accounts.retrieve(null),stripe.products.retrieve(expected.productId),stripe.prices.retrieve(expected.priceId)]);
    return account.id===EXPECTED_STRIPE_ACCOUNT_ID && !product.deleted && product.active &&
      product.name===expected.name && price.active && price.livemode===STRIPE_LIVE_MODE &&
      price.product===expected.productId && price.unit_amount===expected.amount &&
      price.currency===expected.currency && price.recurring?.interval===expected.interval ? price.id : null;
  }
  const { db } = await import("./db");
  const result = await db.execute(sql`
    SELECT pr.id
    FROM stripe.products p
    JOIN stripe.prices pr ON pr.product = p.id AND pr.active = true
    WHERE p.id = ${expected.productId}
      AND pr.id = ${expected.priceId}
      AND p."_account_id" = ${EXPECTED_STRIPE_ACCOUNT_ID}
      AND pr."_account_id" = ${EXPECTED_STRIPE_ACCOUNT_ID}
      AND p.name = ${expected.name}
      AND p.active = true
      AND pr.unit_amount = ${expected.amount}
      AND pr.currency = ${expected.currency}
      AND pr.recurring->>'interval' = ${expected.interval}
    LIMIT 1
  `);
  return result.rows[0]?.id === expected.priceId ? expected.priceId : null;
}

export async function ensureStripeCustomer(userId: string, email: string | null): Promise<string> {
  assertNotLifeosBillingSubject(userId);
  const user = await storage.getUser(userId);
  const stripe = await getUncachableStripeClient();
  if (!user) throw new Error("Unknown ForgeProof user");
  if (user.stripeCustomerId) {
    await assertCustomerOwnership(stripe, user.stripeCustomerId, userId);
    return user.stripeCustomerId;
  }
  const customer = await stripe.customers.create({
    email: email || undefined,
    metadata: { userId, product: "forgeproof" },
  }, { idempotencyKey: `forgeproof-customer-${STRIPE_LIVE_MODE ? "live" : "sandbox"}-${userId}` });
  await storage.updateUser(userId, { stripeCustomerId: customer.id });
  return customer.id;
}

export async function createCheckoutSession(
  userId: string,
  email: string | null,
  plan: "pro" | "enterprise",
  baseUrl: string
): Promise<string | null> {
  assertNotLifeosBillingSubject(userId);
  const priceId = await getPriceIdForPlan(plan);
  if (!priceId) return null;

  const customerId = await ensureStripeCustomer(userId, email);
  const stripe = await getUncachableStripeClient();

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    mode: "subscription",
    success_url: `${baseUrl}/dashboard?billing=success`,
    cancel_url: `${baseUrl}/dashboard?billing=canceled`,
    metadata: { userId, plan, product: "forgeproof" },
    subscription_data: { metadata: { userId, plan, product: "forgeproof" } },
  });

  return session.url;
}

export async function createPortalSession(userId: string, baseUrl: string): Promise<string | null> {
  assertNotLifeosBillingSubject(userId);
  const user = await storage.getUser(userId);
  if (!user?.stripeCustomerId) return null;

  const stripe = await getUncachableStripeClient();
  await assertCustomerOwnership(stripe, user.stripeCustomerId, userId);
  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${baseUrl}/dashboard`,
  });
  return session.url;
}

export async function applySubscriptionUpdate(stripeSubscription: any): Promise<void> {
  if (!await ownsSubscription(stripeSubscription)) return;
  const plan = subscriptionPlan(stripeSubscription)!;
  const userId = stripeSubscription.metadata?.userId;

  const isActive = ["active", "trialing"].includes(stripeSubscription.status);
  const status = isActive ? "active" : stripeSubscription.status === "past_due" ? "past_due" : "canceled";

  const existing =
    (await storage.getSubscriptionByStripeId(stripeSubscription.id)) ||
    (userId ? await storage.getSubscription(userId) : undefined);
  if (existing && (existing.userId !== userId ||
      (existing.stripeCustomerId && existing.stripeCustomerId !== stripeSubscription.customer) ||
      (existing.stripeSubscriptionId && existing.stripeSubscriptionId !== stripeSubscription.id))) {
    throw new Error("Stripe subscription ownership mismatch");
  }

  const periodStart = stripeSubscription.current_period_start
    ? new Date(stripeSubscription.current_period_start * 1000)
    : new Date();
  const periodEnd = stripeSubscription.current_period_end
    ? new Date(stripeSubscription.current_period_end * 1000)
    : undefined;

  const effectivePlan: PlanType = isActive ? plan : "free";
  const effectiveLimits = PLAN_LIMITS[effectivePlan];

  if (existing) {
    const periodRenewed =
      existing.currentPeriodStart && periodStart.getTime() > new Date(existing.currentPeriodStart).getTime();

    await storage.updateSubscription(existing.id, {
      stripeCustomerId: stripeSubscription.customer,
      stripeSubscriptionId: isActive ? stripeSubscription.id : null,
      plan: effectivePlan,
      status: isActive ? "active" : status,
      attestationLimit: effectiveLimits.attestationLimit,
      apiKeyLimit: effectiveLimits.apiKeyLimit,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      ...(periodRenewed ? { attestationCount: 0 } : {}),
    });
  } else if (userId) {
    await storage.createSubscription({
      userId,
      stripeCustomerId: stripeSubscription.customer,
      stripeSubscriptionId: isActive ? stripeSubscription.id : null,
      plan: effectivePlan,
      status: isActive ? "active" : status,
      attestationLimit: effectiveLimits.attestationLimit,
      attestationCount: 0,
      apiKeyLimit: effectiveLimits.apiKeyLimit,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
    });
  }
}

export async function handleStripeEvent(event: { id?: string; created?: number; type: string; data: { object: any } }): Promise<void> {
  if (!await ownsStripeEvent(event)) return;
  const git=currentApplicationStorage() as GitStorage | undefined;
  if (git) {
    if (!event.id || !/^evt_[A-Za-z0-9]+$/.test(event.id) || !Number.isSafeInteger(event.created))
      throw new Error("Stripe event identity required");
    let sub=event.type.startsWith("customer.subscription.") ? event.data.object : null;
    if (event.type==="checkout.session.completed" && event.data.object.mode==="subscription") {
      const stripe=await getUncachableStripeClient();
      sub=await stripe.subscriptions.retrieve(event.data.object.subscription);
    } else if (event.type==="invoice.paid" || event.type==="invoice.payment_failed") {
      const id=invoiceSubscriptionId(event.data.object);
      if (!id) return;
      const stripe=await getUncachableStripeClient();
      sub=await stripe.subscriptions.retrieve(id);
    }
    if (!sub || !await ownsSubscription(sub)) return;
    const active=["active","trialing"].includes(sub.status);
    const plan: PlanType=active ? subscriptionPlan(sub)! : "free";
    await git.applyStripeSubscription(event.id,event.created!,
      createHash("sha256").update(JSON.stringify(event)).digest("hex"), {
        userId:sub.metadata.userId, stripeCustomerId:sub.customer,
        stripeSubscriptionId:active ? sub.id : null, plan,
        status:active ? "active" : sub.status==="past_due" ? "past_due" : "canceled",
        attestationLimit:PLAN_LIMITS[plan].attestationLimit,apiKeyLimit:PLAN_LIMITS[plan].apiKeyLimit,
        currentPeriodStart:sub.current_period_start || sub.items?.data?.[0]?.current_period_start
          ? new Date((sub.current_period_start || sub.items.data[0].current_period_start)*1000) : undefined,
        currentPeriodEnd:sub.current_period_end || sub.items?.data?.[0]?.current_period_end
          ? new Date((sub.current_period_end || sub.items.data[0].current_period_end)*1000) : undefined,
      });
    return;
  }
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await applySubscriptionUpdate(event.data.object);
      break;
    case "checkout.session.completed": {
      const session = event.data.object;
      if (session.mode === "subscription" && session.subscription) {
        const stripe = await getUncachableStripeClient();
        const sub = await stripe.subscriptions.retrieve(session.subscription as string);
        await applySubscriptionUpdate(sub as any);
      }
      break;
    }
    case "invoice.paid": {
      const invoice = event.data.object;
      const subId = invoiceSubscriptionId(invoice);
      if (subId && invoice.billing_reason === "subscription_cycle") {
        const existing = await storage.getSubscriptionByStripeId(subId as string);
        if (existing) {
          await storage.resetAttestationCount(existing.id);
          await storage.updateSubscription(existing.id, { status: "active" });
        }
      }
      break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object;
      const subId = invoiceSubscriptionId(invoice);
      if (subId) {
        const existing = await storage.getSubscriptionByStripeId(subId as string);
        if (existing) {
          await storage.updateSubscription(existing.id, { status: "past_due" });
        }
      }
      break;
    }
  }
}
