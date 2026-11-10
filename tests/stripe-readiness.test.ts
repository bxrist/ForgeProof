import { beforeEach, describe, expect, it, vi } from "vitest";

const billingMode = vi.hoisted(() => ({ live: false, git: false }));
vi.mock("../server/storageBackend",()=>({hasApplicationStorage:()=>billingMode.git}));
vi.mock("../server/stripeConfig", async (importOriginal) => ({
  ...await importOriginal<typeof import("../server/stripeConfig")>(),
  get STRIPE_LIVE_MODE() { return billingMode.live; },
}));

const stripeState = vi.hoisted(() => ({
  stripe: {
    accounts: { retrieve: vi.fn() },
    products: { list: vi.fn() },
    prices: { list: vi.fn() },
    webhookEndpoints: {
      list: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      del: vi.fn(),
    },
  },
  sync: {
    syncSingleEntity: vi.fn(),
    getSupportedEventTypes: vi.fn(),
    upsertManagedWebhooks: vi.fn(),
  },
  credentials: vi.fn(),
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}));

vi.mock("../server/db", () => ({ pool: stripeState.pool, db: {} }));
vi.mock("../server/stripeClient", () => ({
  getUncachableStripeClient: vi.fn(async () => stripeState.stripe),
  getStripeSync: vi.fn(async () => stripeState.sync),
  getStripeCredentials: stripeState.credentials,
}));

import {
  EXPECTED_STRIPE_ACCOUNT_ID,
  EXPECTED_STRIPE_CATALOG,
  getStripeReadiness,
  reconcileStripe,
} from "../server/stripeAdmin";

const webhookEvents = ["*"];

function product(plan: keyof typeof EXPECTED_STRIPE_CATALOG) {
  const expected = EXPECTED_STRIPE_CATALOG[plan];
  return { id: expected.productId, name: expected.name, active: true };
}

function price(plan: keyof typeof EXPECTED_STRIPE_CATALOG) {
  const expected = EXPECTED_STRIPE_CATALOG[plan];
  return {
    id: expected.priceId,
    product: expected.productId,
    active: true,
    unit_amount: expected.amount,
    currency: expected.currency,
    recurring: { interval: expected.interval },
  };
}

function endpoint(id: string, url: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    object: "webhook_endpoint",
    url,
    status: "enabled",
    enabled_events: webhookEvents,
    metadata: { managed_by: "stripe-sync" },
    ...overrides,
  };
}

function configureHealthyStripe() {
  process.env.FORGEPROOF_STRIPE_PRODUCTION_URL = "https://production.example";
  process.env.FORGEPROOF_STRIPE_DEVELOPMENT_URL = "https://development.example";
  stripeState.stripe.accounts.retrieve.mockResolvedValue({
    id: EXPECTED_STRIPE_ACCOUNT_ID,
    details_submitted: true,
    charges_enabled: true,
    payouts_enabled: true,
  });
  stripeState.stripe.products.list.mockResolvedValue({
    data: [product("pro"), product("enterprise")],
    has_more: false,
  });
  stripeState.stripe.prices.list.mockResolvedValue({
    data: [price("pro"), price("enterprise")],
    has_more: false,
  });
  stripeState.stripe.webhookEndpoints.list.mockResolvedValue({
    data: [
      endpoint("we_prod", "https://production.example/api/stripe/webhook"),
      endpoint("we_dev", "https://development.example/api/stripe/webhook"),
    ],
    has_more: false,
  });
  stripeState.sync.upsertManagedWebhooks = vi.fn();
  stripeState.pool.query.mockImplementation(async (query: string) => {
    if (query.includes("stripe.products")) return { rows: [product("pro"), product("enterprise")] };
    if (query.includes("stripe.prices")) return { rows: [price("pro"), price("enterprise")] };
    if (query.includes("_forgeproof_webhook_intents")) return { rows: [] };
    return {
      rows: [
        { id: "we_prod", url: "https://production.example/api/stripe/webhook", secret: "stored-prod-secret" },
        { id: "we_dev", url: "https://development.example/api/stripe/webhook", secret: "stored-dev-secret" },
      ],
    };
  });
}

beforeEach(() => {
  billingMode.git=false;
  vi.clearAllMocks();
  billingMode.live = false;
  process.env.NODE_ENV = "development";
  delete process.env.FORGEPROOF_STRIPE_PRODUCTION_URL;
  delete process.env.FORGEPROOF_STRIPE_DEVELOPMENT_URL;
  delete process.env.REPLIT_DOMAINS;
  configureHealthyStripe();
});

describe("Stripe readiness safety gates", () => {
  it("verifies Git-native billing without SQL or provider mutations",async()=>{
    billingMode.git=true;
    process.env.NODE_ENV="production";
    stripeState.credentials.mockResolvedValue({webhookSecret:"whsec_synthetic_fixture",
      webhookSecretAccountId:EXPECTED_STRIPE_ACCOUNT_ID,
      webhookSecretUrl:"https://production.example/api/stripe/webhook"});
    const result=await reconcileStripe();
    expect(result.ready).toBe(true);
    expect(result.success).toBe(true);
    expect(stripeState.pool.query).not.toHaveBeenCalled();
    expect(stripeState.pool.connect).not.toHaveBeenCalled();
    expect(stripeState.sync.upsertManagedWebhooks).not.toHaveBeenCalled();
    expect(stripeState.stripe.webhookEndpoints.create).not.toHaveBeenCalled();
    expect(stripeState.stripe.webhookEndpoints.update).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("whsec_synthetic_fixture");
  });
  it("does not borrow an unbound webhook secret or create a replacement endpoint",async()=>{
    billingMode.git=true;
    stripeState.credentials.mockResolvedValue({webhookSecret:"whsec_synthetic_fixture",webhookSecretUrl:"https://wrong.example"});
    const result=await reconcileStripe();
    expect(result.ready).toBe(false);
    expect(result.success).toBe(false);
    expect(stripeState.pool.query).not.toHaveBeenCalled();
    expect(stripeState.stripe.webhookEndpoints.create).not.toHaveBeenCalled();
  });
  it("does not require a development webhook in the live production account", async () => {
    billingMode.live = true;
    process.env.NODE_ENV = "production";
    stripeState.stripe.webhookEndpoints.list.mockResolvedValue({
      data: [endpoint("we_prod", "https://production.example/api/stripe/webhook")],
      has_more: false,
    });
    const report = await getStripeReadiness();
    expect(report.billingMode).toBe("live");
    expect(report.remoteStatus).toBe("not_applicable");
    expect(report.localReady).toBe(true);
    expect(report.ready).toBe(true);
    expect(report.checks.find((check) => check.key === "remote_webhook_development")?.status).toBe("ok");
    expect(stripeState.stripe.webhookEndpoints.create).not.toHaveBeenCalled();
  });

  it("still blocks live readiness when the production webhook is missing", async () => {
    billingMode.live = true;
    process.env.NODE_ENV = "production";
    stripeState.stripe.webhookEndpoints.list.mockResolvedValue({ data: [], has_more: false });
    const report = await getStripeReadiness();
    expect(report.ready).toBe(false);
    expect(report.localReady).toBe(false);
    expect(report.checks.find((check) => check.key === "webhook_production")?.status).toBe("warning");
  });

  it("synchronizes only the pinned live catalog without requiring or changing remote endpoints", async () => {
    billingMode.live = true;
    process.env.NODE_ENV = "production";
    let synced = 0;
    stripeState.sync.syncSingleEntity.mockImplementation(async () => { synced++; });
    stripeState.sync.getSupportedEventTypes.mockReturnValue(webhookEvents);
    stripeState.pool.connect.mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn(),
    });
    stripeState.stripe.webhookEndpoints.list.mockResolvedValue({
      data: [
        endpoint("we_prod", "https://production.example/api/stripe/webhook"),
        endpoint("we_other_product", "https://unrelated.example/webhook"),
      ], has_more: false,
    });
    stripeState.pool.query.mockImplementation(async (query: string) => {
      if (query.includes("stripe.products")) return { rows: synced === 4 ? [product("pro"), product("enterprise")] : [] };
      if (query.includes("stripe.prices")) return { rows: synced === 4 ? [price("pro"), price("enterprise")] : [] };
      if (query.includes("_forgeproof_webhook_intents")) return { rows: [] };
      return { rows: [{ id: "we_prod", url: "https://production.example/api/stripe/webhook", secret: "stored-prod-secret" }] };
    });
    expect((await getStripeReadiness()).ready).toBe(false);
    const report = await reconcileStripe();
    expect(report.success).toBe(true);
    expect(report.reconciliation.remoteStatus).toBe("not_applicable");
    expect(stripeState.sync.syncSingleEntity.mock.calls.map(([id]) => id)).toEqual([
      EXPECTED_STRIPE_CATALOG.pro.productId, EXPECTED_STRIPE_CATALOG.pro.priceId,
      EXPECTED_STRIPE_CATALOG.enterprise.productId, EXPECTED_STRIPE_CATALOG.enterprise.priceId,
    ]);
    expect(stripeState.stripe.webhookEndpoints.create).not.toHaveBeenCalled();
    expect(stripeState.stripe.webhookEndpoints.update).not.toHaveBeenCalled();
    expect(stripeState.stripe.webhookEndpoints.del).not.toHaveBeenCalled();
  });

  it("reports a mismatched account without allowing provider writes", async () => {
    stripeState.stripe.accounts.retrieve.mockResolvedValue({
      id: "acct_wrong",
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
    });

    const report = await getStripeReadiness();

    expect(report.account?.id).toBe("acct_wrong");
    expect(report.ready).toBe(false);
    expect(report.canReconcile).toBe(false);
    expect(stripeState.stripe.webhookEndpoints.create).not.toHaveBeenCalled();
    expect(stripeState.stripe.webhookEndpoints.update).not.toHaveBeenCalled();
  });

  it("rejects identical production and development webhook origins", async () => {
    process.env.FORGEPROOF_STRIPE_DEVELOPMENT_URL = "https://production.example";

    const report = await getStripeReadiness();

    expect(report.canReconcile).toBe(false);
    expect(report.checks.find((check) => check.key === "webhook_url_distinct")?.status).toBe("error");
  });

  it("blocks an empty provider catalog and preserves the pinned IDs", async () => {
    stripeState.stripe.products.list.mockResolvedValue({ data: [], has_more: false });
    stripeState.stripe.prices.list.mockResolvedValue({ data: [], has_more: false });

    const report = await getStripeReadiness();

    expect(report.canReconcile).toBe(false);
    expect(report.checks.find((check) => check.key === "stripe_catalog_pro_product")?.status).toBe("error");
    expect(EXPECTED_STRIPE_CATALOG.pro.productId).toBe("prod_VZhE1gWXMlDtNp");
    expect(EXPECTED_STRIPE_CATALOG.enterprise.priceId).toBe("price_1UYXq3InfcuWjiUYpAxezBwK");
  });

  it("reports sandbox setup flags without treating them as claim-preservation proof or a reconcile gate", async () => {
    stripeState.stripe.accounts.retrieve.mockResolvedValue({
      id: EXPECTED_STRIPE_ACCOUNT_ID,
      details_submitted: true,
      charges_enabled: false,
      payouts_enabled: false,
    });

    const report = await getStripeReadiness();

    expect(report.account).toMatchObject({
      detailsSubmitted: true,
      chargesEnabled: false,
      payoutsEnabled: false,
    });
    expect(report.localReady).toBe(true);
    expect(report.remoteStatus).toBe("unverified");
    expect(report.ready).toBe(false);
    expect(report.canReconcile).toBe(true);
    expect(report.checks.find((check) => check.key === "account_setup")?.status).toBe("warning");
  });

  it("repairs an empty synchronized database with only the pinned provider IDs", async () => {
    let synchronized = false;
    const synchronizedIds: string[] = [];
    stripeState.sync.syncSingleEntity.mockImplementation(async (id: string) => {
      synchronizedIds.push(id);
      if (synchronizedIds.length === 4) synchronized = true;
    });
    stripeState.sync.getSupportedEventTypes.mockReturnValue(webhookEvents);
    stripeState.pool.query.mockImplementation(async (query: string) => {
      if (query.includes("stripe.products")) {
        return { rows: synchronized ? [product("pro"), product("enterprise")] : [] };
      }
      if (query.includes("stripe.prices")) {
        return { rows: synchronized ? [price("pro"), price("enterprise")] : [] };
      }
      if (query.includes("_forgeproof_webhook_intents")) return { rows: [] };
      return {
        rows: [
          { id: "we_prod", url: "https://production.example/api/stripe/webhook", secret: "stored-prod-secret" },
          { id: "we_dev", url: "https://development.example/api/stripe/webhook", secret: "stored-dev-secret" },
        ],
      };
    });
    stripeState.pool.connect.mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });

    const report = await reconcileStripe();

    expect(synchronizedIds).toEqual([
      EXPECTED_STRIPE_CATALOG.pro.productId,
      EXPECTED_STRIPE_CATALOG.pro.priceId,
      EXPECTED_STRIPE_CATALOG.enterprise.productId,
      EXPECTED_STRIPE_CATALOG.enterprise.priceId,
    ]);
    expect(report.reconciliation.localSuccess).toBe(true);
    expect(report.success).toBe(false);
    expect(report.reconciliation.remoteStatus).toBe("unverified");
  });

  it("does not report success when catalog sync fails or final readiness drifts", async () => {
    stripeState.sync.syncSingleEntity.mockRejectedValue(new Error("sync failed"));
    stripeState.sync.getSupportedEventTypes.mockReturnValue(webhookEvents);
    stripeState.pool.connect.mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });

    const syncFailure = await reconcileStripe();
    expect(syncFailure.success).toBe(false);
    expect(syncFailure.reconciliation.localSuccess).toBe(false);
    expect(syncFailure.reconciliation.operations.some((operation) =>
      operation.key === `catalog_${EXPECTED_STRIPE_CATALOG.pro.productId}` &&
      operation.status === "error",
    )).toBe(true);

    vi.clearAllMocks();
    configureHealthyStripe();
    stripeState.sync.syncSingleEntity.mockResolvedValue({});
    stripeState.sync.getSupportedEventTypes.mockReturnValue(webhookEvents);
    let endpointListCall = 0;
    stripeState.stripe.webhookEndpoints.list.mockImplementation(async () => {
      endpointListCall += 1;
      if (endpointListCall === 3) {
        return {
          data: [
            endpoint("we_prod", "https://production.example/api/stripe/webhook"),
            endpoint("we_dev", "https://development.example/api/stripe/webhook", {
              status: "disabled",
              enabled_events: [],
            }),
          ],
          has_more: false,
        };
      }
      return {
        data: [
          endpoint("we_prod", "https://production.example/api/stripe/webhook"),
          endpoint("we_dev", "https://development.example/api/stripe/webhook"),
        ],
        has_more: false,
      };
    });
    stripeState.pool.connect.mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });

    const finalDrift = await reconcileStripe();
    expect(finalDrift.success).toBe(false);
    expect(finalDrift.reconciliation.localSuccess).toBe(false);
    expect(finalDrift.reconciliation.status).toBe("partial");
  });

  it("reports missing managed secrets as manual recovery, not a rotation opportunity", async () => {
    stripeState.pool.query.mockImplementation(async (query: string) => {
      if (query.includes("stripe.products")) return { rows: [product("pro"), product("enterprise")] };
      if (query.includes("stripe.prices")) return { rows: [price("pro"), price("enterprise")] };
      return { rows: [{ id: "we_prod", secret: null }, { id: "we_dev", secret: null }] };
    });

    const report = await getStripeReadiness();

    expect(report.canReconcile).toBe(false);
    expect(report.checks.some((check) =>
      check.key === "webhook_development_secret" &&
      check.status === "error" &&
      check.detail.includes("manual"),
    )).toBe(true);
    expect(report.checks.every((check) => !check.detail.includes("stored-prod-secret"))).toBe(true);
  });

  it("creates missing webhook URLs with a stable idempotency key and never duplicates on retry", async () => {
    process.env.NODE_ENV = "production";
    const createdEndpoints: any[] = [];
    const managedRows: any[] = [];
    let firstProductionAttempt = true;
    stripeState.stripe.webhookEndpoints.list.mockImplementation(async () => ({
      data: createdEndpoints,
      has_more: false,
    }));
    stripeState.stripe.webhookEndpoints.create.mockImplementation(async (params: any, options: any) => {
      if (params.url.includes("production") && firstProductionAttempt) {
        firstProductionAttempt = false;
        throw new Error("transient provider error");
      }
      const created = endpoint(`we_created_${createdEndpoints.length + 1}`, params.url, {
        enabled_events: params.enabled_events,
        secret: `secret-${createdEndpoints.length + 1}`,
      });
      createdEndpoints.push(created);
      return created;
    });
    stripeState.sync.getSupportedEventTypes.mockReturnValue(webhookEvents);
    stripeState.sync.syncSingleEntity.mockResolvedValue({});
    stripeState.sync.upsertManagedWebhooks.mockImplementation(async (entries: any[]) => {
      for (const entry of entries) {
        managedRows.push({ id: entry.id, url: entry.url, secret: entry.secret });
      }
    });
    stripeState.pool.query.mockImplementation(async (query: string) => {
      if (query.includes("stripe.products")) return { rows: [product("pro"), product("enterprise")] };
      if (query.includes("stripe.prices")) return { rows: [price("pro"), price("enterprise")] };
      return { rows: managedRows };
    });
    stripeState.pool.connect.mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });

    const first = await reconcileStripe();
    const second = await reconcileStripe();

    expect(first.success).toBe(false);
    expect(first.reconciliation.localSuccess).toBe(false);
    expect(second.success).toBe(false);
    expect(second.reconciliation.localSuccess).toBe(true);
    expect(second.reconciliation.remoteStatus).toBe("missing");
    expect(stripeState.stripe.webhookEndpoints.create).toHaveBeenCalledTimes(2);
    const firstProductionKey = stripeState.stripe.webhookEndpoints.create.mock.calls[0][1].idempotencyKey;
    const retryProductionKey = stripeState.stripe.webhookEndpoints.create.mock.calls[1][1].idempotencyKey;
    expect(firstProductionKey).toBe(retryProductionKey);
    expect(createdEndpoints).toHaveLength(1);
    expect(new Set(createdEndpoints.map((item) => item.url)).size).toBe(1);
  });

  it("replays the same idempotent create after secret persistence fails, but blocks without persistence", async () => {
    process.env.NODE_ENV = "production";
    let intent: any = null;
    let createdEndpoint: any = null;
    let upsertAttempts = 0;
    stripeState.stripe.webhookEndpoints.list.mockImplementation(async () => ({
      data: createdEndpoint ? [createdEndpoint] : [],
      has_more: false,
    }));
    stripeState.stripe.webhookEndpoints.create.mockImplementation(async (params: any) => {
      if (!createdEndpoint) {
        createdEndpoint = endpoint("we_recovered", params.url, {
          enabled_events: params.enabled_events,
          secret: "replayed-secret",
        });
      }
      return createdEndpoint;
    });
    stripeState.sync.getSupportedEventTypes.mockReturnValue(webhookEvents);
    stripeState.sync.syncSingleEntity.mockResolvedValue({});
    stripeState.sync.upsertManagedWebhooks.mockImplementation(async (entries: any[]) => {
      upsertAttempts += 1;
      if (upsertAttempts === 1) throw new Error("database unavailable");
      managedRows.push({ id: entries[0].id, url: entries[0].url, secret: entries[0].secret });
    });
    const managedRows: any[] = [];
    stripeState.pool.query.mockImplementation(async (query: string, values?: any[]) => {
      if (query.includes("stripe.products")) return { rows: [product("pro"), product("enterprise")] };
      if (query.includes("stripe.prices")) return { rows: [price("pro"), price("enterprise")] };
      if (query.includes("_forgeproof_webhook_intents")) {
        if (query.trimStart().startsWith("SELECT")) return { rows: intent ? [intent] : [] };
        if (query.trimStart().startsWith("INSERT")) {
          intent = {
            account_id: values?.[0],
            environment: values?.[1],
            url: values?.[2],
            idempotency_key: values?.[3],
            request_params: JSON.parse(values?.[4]),
            status: "pending",
            created_at: new Date(),
          };
          return { rows: [] };
        }
        if (query.trimStart().startsWith("UPDATE")) {
          intent = { ...intent, status: "completed", stripe_endpoint_id: values?.[3], secret_stored: true };
          return { rows: [] };
        }
      }
      return { rows: managedRows };
    });
    stripeState.pool.connect.mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });

    const first = await reconcileStripe();
    const second = await reconcileStripe();

    expect(first.success).toBe(false);
    expect(first.reconciliation.localSuccess).toBe(false);
    expect(second.reconciliation.localSuccess).toBe(true);
    expect(stripeState.stripe.webhookEndpoints.create).toHaveBeenCalledTimes(2);
    expect(stripeState.stripe.webhookEndpoints.create.mock.calls[0][1].idempotencyKey)
      .toBe(stripeState.stripe.webhookEndpoints.create.mock.calls[1][1].idempotencyKey);
    expect(intent.status).toBe("completed");

    vi.clearAllMocks();
    stripeState.sync.upsertManagedWebhooks.mockImplementation(async () => undefined);
    stripeState.stripe.webhookEndpoints.create.mockResolvedValue(createdEndpoint);
    stripeState.stripe.webhookEndpoints.list.mockResolvedValue({
      data: [createdEndpoint],
      has_more: false,
    });
    intent = {
      ...intent,
      status: "pending",
      created_at: new Date(Date.now() - 25 * 60 * 60 * 1000),
    };
    managedRows.length = 0;
    createdEndpoint = null;
    const stale = await reconcileStripe();
    expect(stale.success).toBe(false);
    expect(stale.reconciliation.localSuccess).toBe(false);
    expect(stripeState.stripe.webhookEndpoints.create).not.toHaveBeenCalled();

    vi.clearAllMocks();
    managedRows.length = 0;
    createdEndpoint = null;
    stripeState.sync.upsertManagedWebhooks = undefined as any;
    stripeState.stripe.webhookEndpoints.list.mockResolvedValue({ data: [], has_more: false });
    const unavailablePersistence = await reconcileStripe();
    expect(unavailablePersistence.success).toBe(false);
    expect(unavailablePersistence.reconciliation.operations.some((operation) =>
      operation.status === "blocked" && operation.detail.includes("persistence"),
    )).toBe(true);
    expect(stripeState.stripe.webhookEndpoints.create).not.toHaveBeenCalled();
    expect(stripeState.stripe.webhookEndpoints.update).not.toHaveBeenCalled();
  });

  it("updates a stale endpoint in place and never creates a duplicate URL", async () => {
    process.env.NODE_ENV = "production";
    const stale = endpoint("we_prod", "https://production.example/api/stripe/webhook", {
      status: "disabled",
      enabled_events: [],
    });
    const duplicate = endpoint("we_prod_duplicate", "https://production.example/api/stripe/webhook");
    stripeState.stripe.webhookEndpoints.list
      .mockResolvedValueOnce({ data: [stale, duplicate, endpoint("we_dev", "https://development.example/api/stripe/webhook")], has_more: false })
      .mockResolvedValue({ data: [stale, duplicate, endpoint("we_dev", "https://development.example/api/stripe/webhook")], has_more: false });
    stripeState.stripe.webhookEndpoints.update.mockResolvedValue({
      ...stale,
      status: "enabled",
      enabled_events: webhookEvents,
    });
    stripeState.sync.getSupportedEventTypes.mockReturnValue(webhookEvents);
    stripeState.sync.syncSingleEntity.mockResolvedValue({});
    stripeState.pool.connect.mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });

    const report = await reconcileStripe();

    expect(report.reconciliation.status).toBe("partial");
    expect(report.success).toBe(false);
    expect(stripeState.stripe.webhookEndpoints.update).toHaveBeenCalledWith(
      "we_prod",
      expect.objectContaining({ disabled: false, enabled_events: webhookEvents }),
    );
    expect(stripeState.stripe.webhookEndpoints.create).not.toHaveBeenCalled();
    expect(stripeState.stripe.webhookEndpoints.del).not.toHaveBeenCalled();
  });

  it("mutates only the current environment endpoint", async () => {
    const staleEndpoints = [
      endpoint("we_prod", "https://production.example/api/stripe/webhook", {
        status: "disabled",
        enabled_events: [],
      }),
      endpoint("we_dev", "https://development.example/api/stripe/webhook", {
        status: "disabled",
        enabled_events: [],
      }),
    ];
    stripeState.stripe.webhookEndpoints.list.mockResolvedValue({
      data: staleEndpoints,
      has_more: false,
    });
    stripeState.stripe.webhookEndpoints.update.mockImplementation(async (id: string) => ({
      ...staleEndpoints.find((item) => item.id === id),
      status: "enabled",
      enabled_events: webhookEvents,
    }));
    stripeState.sync.getSupportedEventTypes.mockReturnValue(webhookEvents);
    stripeState.sync.syncSingleEntity.mockResolvedValue({});
    stripeState.pool.connect.mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });

    process.env.NODE_ENV = "development";
    await reconcileStripe();
    expect(stripeState.stripe.webhookEndpoints.update).toHaveBeenCalledTimes(1);
    expect(stripeState.stripe.webhookEndpoints.update).toHaveBeenCalledWith(
      "we_dev",
      expect.any(Object),
    );
    expect(stripeState.stripe.webhookEndpoints.update).not.toHaveBeenCalledWith(
      "we_prod",
      expect.any(Object),
    );

    vi.clearAllMocks();
    process.env.NODE_ENV = "production";
    await reconcileStripe();
    expect(stripeState.stripe.webhookEndpoints.update).toHaveBeenCalledTimes(1);
    expect(stripeState.stripe.webhookEndpoints.update).toHaveBeenCalledWith(
      "we_prod",
      expect.any(Object),
    );
    expect(stripeState.stripe.webhookEndpoints.update).not.toHaveBeenCalledWith(
      "we_dev",
      expect.any(Object),
    );
  });
});
