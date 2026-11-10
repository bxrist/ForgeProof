import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(), customer: vi.fn(), subscription: vi.fn(),
}));
vi.mock("../server/storage", () => ({ storage: { getUser: mocks.getUser } }));
vi.mock("../server/stripeClient", () => ({ getUncachableStripeClient: async () => ({
  customers: { retrieve: mocks.customer }, subscriptions: { retrieve: mocks.subscription },
}) }));
vi.mock("../server/lifeosEntitlement", () => ({ assertNotLifeosBillingSubject: (id: string) => {
  if (id === "internal-service") throw new Error("Non-billable");
} }));
import { ownsStripeEvent, ownsSubscription, subscriptionPlan } from "../server/stripeOwnership";
import { EXPECTED_STRIPE_CATALOG } from "../server/stripeConfig";

function subscription() {
  const pin = EXPECTED_STRIPE_CATALOG.pro;
  return { id: "sub_forgeproof", customer: "cus_forgeproof", livemode: false,
    metadata: { userId: "fp-user", product: "forgeproof", plan: "pro" },
    items: { data: [{ quantity: 1, price: { id: pin.priceId, product: pin.productId,
      livemode: false, unit_amount: pin.amount, currency: pin.currency,
      recurring: { interval: "month", interval_count: 1 } } }] } };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ id: "fp-user", stripeCustomerId: "cus_forgeproof" });
  mocks.customer.mockResolvedValue({ id: "cus_forgeproof", livemode: false,
    metadata: { userId: "fp-user", product: "forgeproof" } });
  mocks.subscription.mockResolvedValue(subscription());
});
describe("cross-product billing isolation", () => {
  it("accepts only a correctly pinned and locally owned ForgeProof subscription", async () => {
    expect(await ownsSubscription(subscription())).toBe(true);
  });
  it.each(["crowsnest", "another-product"])("rejects %s product metadata before reading users", async product => {
    const sub = subscription(); sub.metadata.product = product;
    expect(await ownsSubscription(sub)).toBe(false);
    expect(mocks.getUser).not.toHaveBeenCalled();
  });
  it("rejects Crowsnest tenant metadata even when product metadata is forged", async () => {
    const sub = subscription(); Object.assign(sub.metadata, { tenantId: "crow-tenant" });
    expect(await ownsSubscription(sub)).toBe(false);
  });
  it("rejects a foreign price despite valid ForgeProof labels", async () => {
    const sub = subscription(); sub.items.data[0].price.id = "price_crowsnest";
    expect(subscriptionPlan(sub)).toBeNull();
  });
  it("rejects a mixed-product subscription", async () => {
    const sub = subscription(); sub.items.data.push(sub.items.data[0]);
    expect(subscriptionPlan(sub)).toBeNull();
  });
  it("rejects live events in sandbox", async () => {
    expect(await ownsStripeEvent({ type: "customer.subscription.updated", livemode: true,
      data: { object: subscription() } })).toBe(false);
  });
  it("rejects a reused Crowsnest customer", async () => {
    mocks.customer.mockResolvedValue({ livemode: false, metadata: { userId: "fp-user", product: "crowsnest" } });
    expect(await ownsSubscription(subscription())).toBe(false);
  });
  it("rejects a foreign local customer association", async () => {
    mocks.getUser.mockResolvedValue({ id: "fp-user", stripeCustomerId: "cus_other" });
    expect(await ownsSubscription(subscription())).toBe(false);
    expect(mocks.customer).not.toHaveBeenCalled();
  });
  it("rejects internal LifeOS service billing", async () => {
    const sub = subscription(); sub.metadata.userId = "internal-service";
    expect(await ownsSubscription(sub)).toBe(false);
  });
  it("accepts a renewal invoice only after resolving its pinned subscription and customer", async () => {
    expect(await ownsStripeEvent({ type: "invoice.paid", livemode: false, data: { object: {
      customer: "cus_forgeproof", parent: { subscription_details: { subscription: "sub_forgeproof" } },
    } } })).toBe(true);
    expect(await ownsStripeEvent({ type: "invoice.paid", livemode: false, data: { object: {
      customer: "cus_crowsnest", subscription: "sub_forgeproof",
    } } })).toBe(false);
  });
  it("rejects unrelated catalog events before synchronization", async () => {
    expect(await ownsStripeEvent({ type: "product.updated", livemode: false,
      data: { object: { id: "prod_crowsnest" } } })).toBe(false);
  });
});
