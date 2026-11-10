import { beforeEach, describe, expect, it, vi } from "vitest";

const webhookState = vi.hoisted(() => ({
  constructEventAsync: vi.fn(),
  processEvent: vi.fn(),
  getStripeSync: vi.fn(),
  getStripeCredentials: vi.fn(),
  poolQuery: vi.fn(),
}));

vi.mock("../server/stripeClient", () => ({
  getStripeSync: webhookState.getStripeSync,
  getStripeCredentials: webhookState.getStripeCredentials,
}));
vi.mock("../server/db", () => ({
  pool: { query: webhookState.poolQuery },
  db: {},
}));
vi.mock("../server/stripeOwnership", () => ({
  ownsStripeEvent: vi.fn(async () => true),
}));

import { WebhookHandlers } from "../server/webhookHandlers";
import { ownsStripeEvent } from "../server/stripeOwnership";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ownsStripeEvent).mockResolvedValue(true);
  process.env.NODE_ENV = "development";
  process.env.FORGEPROOF_STRIPE_PRODUCTION_URL = "https://production.example";
  process.env.FORGEPROOF_STRIPE_DEVELOPMENT_URL = "https://development.example";
  webhookState.getStripeCredentials.mockResolvedValue({ webhookSecret: "connector-secret" });
  webhookState.poolQuery.mockResolvedValue({
    rows: [
      { url: "https://development.example/api/stripe/webhook", secret: "development-secret" },
      { url: "https://production.example/api/stripe/webhook", secret: "production-secret" },
    ],
  });
  webhookState.getStripeSync.mockResolvedValue({
    stripe: {
      webhooks: {
        constructEventAsync: webhookState.constructEventAsync,
      },
    },
    processEvent: webhookState.processEvent,
  });
  webhookState.constructEventAsync.mockImplementation(async (
    _payload: Buffer,
    _signature: string,
    secret: string,
  ) => {
    if (secret !== "development-secret") throw new Error("invalid signature");
    return { id: "evt_test", type: "invoice.paid", data: { object: {} } };
  });
  webhookState.processEvent.mockResolvedValue(undefined);
});

describe("managed webhook signing-secret verification", () => {
  it("acknowledges signed foreign events without mirroring them", async () => {
    vi.mocked(ownsStripeEvent).mockResolvedValue(false);
    expect(await WebhookHandlers.processWebhook(Buffer.from("{}"), "sig")).toBe(false);
    expect(webhookState.processEvent).not.toHaveBeenCalled();
  });
  it("tries all registered secrets so development and production endpoints both work", async () => {
    await WebhookHandlers.processWebhook(Buffer.from("{}"), "sig");

    expect(webhookState.constructEventAsync).toHaveBeenCalledTimes(1);
    expect(webhookState.constructEventAsync.mock.calls.map((call) => call[2])).toEqual([
      "development-secret",
    ]);
    expect(webhookState.processEvent).toHaveBeenCalledTimes(1);
  });

  it("does not swallow processing failure or retry a valid event with another secret", async () => {
    webhookState.processEvent.mockRejectedValue(new Error("database unavailable"));

    await expect(
      WebhookHandlers.processWebhook(Buffer.from("{}"), "sig"),
    ).rejects.toThrow("database unavailable");
    expect(webhookState.constructEventAsync).toHaveBeenCalledTimes(1);
    expect(webhookState.processEvent).toHaveBeenCalledTimes(1);
  });

  it("rejects a remote environment secret even when it is returned by a bad row", async () => {
    webhookState.poolQuery.mockResolvedValue({
      rows: [{ url: "https://production.example/api/stripe/webhook", secret: "production-secret" }],
    });

    await expect(
      WebhookHandlers.processWebhook(Buffer.from("{}"), "sig"),
    ).rejects.toThrow("No Stripe webhook signing secret");
    expect(webhookState.constructEventAsync).not.toHaveBeenCalled();
    expect(webhookState.processEvent).not.toHaveBeenCalled();
  });

  it("allows connector fallback only with an explicit URL and pinned account binding", async () => {
    webhookState.poolQuery.mockResolvedValue({ rows: [] });
    webhookState.getStripeCredentials.mockResolvedValue({
      webhookSecret: "connector-secret",
      webhookSecretUrl: "https://development.example/api/stripe/webhook",
      webhookSecretAccountId: "acct_1UYEnEInfcuWjiUY",
    });
    webhookState.constructEventAsync.mockImplementation(async (
      _payload: Buffer,
      _signature: string,
      secret: string,
    ) => {
      if (secret !== "connector-secret") throw new Error("invalid signature");
      return { id: "evt_connector", type: "invoice.paid", data: { object: {} } };
    });

    await WebhookHandlers.processWebhook(Buffer.from("{}"), "sig");

    expect(webhookState.processEvent).toHaveBeenCalledTimes(1);
  });
});
