import { getUncachableStripeClient } from "./stripeClient";
import { storage } from "./storage";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { PLAN_LIMITS, type PlanType } from "@shared/schema";

export const PLAN_PRICES: Record<string, { name: string; amount: number }> = {
  pro: { name: "ForgeProof Pro", amount: 4900 },
  enterprise: { name: "ForgeProof Enterprise", amount: 24900 },
};

export async function getPriceIdForPlan(plan: "pro" | "enterprise"): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT pr.id
    FROM stripe.products p
    JOIN stripe.prices pr ON pr.product = p.id AND pr.active = true
    WHERE p.name = ${PLAN_PRICES[plan].name} AND p.active = true
    LIMIT 1
  `);
  return (result.rows[0]?.id as string) || null;
}

export async function ensureStripeCustomer(userId: string, email: string | null): Promise<string> {
  const user = await storage.getUser(userId);
  if (user?.stripeCustomerId) return user.stripeCustomerId;

  const stripe = await getUncachableStripeClient();
  const customer = await stripe.customers.create({
    email: email || undefined,
    metadata: { userId },
  });
  await storage.updateUser(userId, { stripeCustomerId: customer.id });
  return customer.id;
}

export async function createCheckoutSession(
  userId: string,
  email: string | null,
  plan: "pro" | "enterprise",
  baseUrl: string
): Promise<string | null> {
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
    metadata: { userId, plan },
    subscription_data: { metadata: { userId, plan } },
  });

  return session.url;
}

export async function createPortalSession(userId: string, baseUrl: string): Promise<string | null> {
  const user = await storage.getUser(userId);
  if (!user?.stripeCustomerId) return null;

  const stripe = await getUncachableStripeClient();
  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${baseUrl}/dashboard`,
  });
  return session.url;
}

export async function applySubscriptionUpdate(stripeSubscription: {
  id: string;
  customer: string;
  status: string;
  metadata?: Record<string, string>;
  current_period_start?: number;
  current_period_end?: number;
}): Promise<void> {
  const plan = (stripeSubscription.metadata?.plan as PlanType) || "pro";
  const userId = stripeSubscription.metadata?.userId;
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.pro;

  const isActive = ["active", "trialing"].includes(stripeSubscription.status);
  const status = isActive ? "active" : stripeSubscription.status === "past_due" ? "past_due" : "canceled";

  const existing =
    (await storage.getSubscriptionByStripeId(stripeSubscription.id)) ||
    (userId ? await storage.getSubscription(userId) : undefined) ||
    (await storage.getSubscriptionByCustomerId(stripeSubscription.customer));

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

export async function handleStripeEvent(event: { type: string; data: { object: any } }): Promise<void> {
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
      const subId = invoice.subscription;
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
      const subId = invoice.subscription;
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
