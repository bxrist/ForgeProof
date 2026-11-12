import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  retrieve: vi.fn(),
  balance: vi.fn(),
  stripe: vi.fn(),
  sync: vi.fn(),
}));
vi.mock("stripe", () => ({
  default: class {
    accounts = { retrieve: state.retrieve };
    balance = { retrieve: state.balance };
    constructor(key: string) { state.stripe(key); }
  },
}));
vi.mock("stripe-replit-sync", () => ({
  StripeSync: class {
    stripe = { accounts: { retrieve: state.retrieve }, balance: { retrieve: state.balance } };
    constructor(options: unknown) { state.sync(options); }
  },
}));

import { getStripeCredentials, getStripeSync, getUncachableStripeClient, withStripeRequestClient } from "../server/stripeClient";
import { EXPECTED_STRIPE_ACCOUNT_ID } from "../server/stripeConfig";

beforeEach(() => {
  vi.clearAllMocks();
  for (const name of [
    "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "FORGEPROOF_STRIPE_WEBHOOK_URL",
    "FORGEPROOF_STRIPE_WEBHOOK_ACCOUNT_ID",
  ]) vi.stubEnv(name, undefined);
  vi.stubEnv("REPLIT_CONNECTORS_HOSTNAME", "connector.example");
  vi.stubEnv("REPL_IDENTITY", "test-identity");
  vi.stubEnv("DATABASE_URL", "postgresql://test.invalid/test");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ items: [{ settings: { secret: "dummy-connector-key" } }] }),
  }));
  state.retrieve.mockResolvedValue({ id: EXPECTED_STRIPE_ACCOUNT_ID });
  state.balance.mockResolvedValue({ livemode: false });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("independent Stripe credentials", () => {
  it("shares one fully guarded client across sequential and concurrent request reads", async () => {
    await withStripeRequestClient(async () => {
      const [a, b] = await Promise.all([getUncachableStripeClient(), getUncachableStripeClient()]);
      expect(a).toBe(b);
      expect(await getUncachableStripeClient()).toBe(a);
    });
    expect(state.retrieve).toHaveBeenCalledTimes(1);
    expect(state.balance).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("isolates concurrent requests and leaves calls outside a request uncached", async () => {
    const clients = await Promise.all([1, 2].map(() => withStripeRequestClient(async () => {
      const first = await getUncachableStripeClient();
      await Promise.resolve();
      expect(await getUncachableStripeClient()).toBe(first);
      return first;
    })));
    expect(clients[0]).not.toBe(clients[1]);
    await getUncachableStripeClient();
    await getUncachableStripeClient();
    expect(state.retrieve).toHaveBeenCalledTimes(4);
    expect(state.balance).toHaveBeenCalledTimes(4);
  });

  it("never treats an unguarded client as verified", async () => {
    await withStripeRequestClient(async () => {
      const unguarded = await getUncachableStripeClient({ skipAccountGuard: true });
      const guarded = await getUncachableStripeClient();
      expect(unguarded).not.toBe(guarded);
      expect(await getUncachableStripeClient()).toBe(guarded);
    });
    expect(state.retrieve).toHaveBeenCalledTimes(1);
    expect(state.balance).toHaveBeenCalledTimes(1);
  });

  it.each(["account", "mode"])("keeps a failed %s check rejected within a request and rechecks next request", async (failure) => {
    if (failure === "account") state.retrieve.mockResolvedValue({ id: "acct_wrong" });
    else state.balance.mockResolvedValue({ livemode: true });
    await withStripeRequestClient(async () => {
      await expect(getUncachableStripeClient()).rejects.toThrow("mismatch");
      await expect(getUncachableStripeClient()).rejects.toThrow("mismatch");
    });
    expect(state.retrieve).toHaveBeenCalledTimes(1);
    state.retrieve.mockResolvedValue({ id: EXPECTED_STRIPE_ACCOUNT_ID });
    state.balance.mockResolvedValue({ livemode: false });
    await withStripeRequestClient(() => getUncachableStripeClient());
    expect(state.retrieve).toHaveBeenCalledTimes(2);
  });
  it("rejects live credentials in sandbox even when the account ID matches", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "dummy-independent-key");
    state.balance.mockResolvedValue({ livemode: true });
    await expect(getUncachableStripeClient()).rejects.toThrow("mode mismatch");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses the saved key without requesting connector credentials", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "dummy-independent-key");
    await getUncachableStripeClient();
    expect(state.stripe).toHaveBeenCalledWith("dummy-independent-key");
    expect(state.retrieve).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves the connector path when no independent key is configured", async () => {
    expect((await getStripeCredentials()).secretKey).toBe("dummy-connector-key");
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("fails closed for an empty independent key rather than switching accounts", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", " ");
    await expect(getStripeCredentials()).rejects.toThrow("configured but empty");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects account mismatch without connector fallback", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "dummy-independent-key");
    state.retrieve.mockResolvedValue({ id: "acct_wrong" });
    await expect(getUncachableStripeClient()).rejects.toThrow("identity mismatch");
    await expect(getStripeSync()).rejects.toThrow("identity mismatch");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not switch credentials after provider rejection", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "dummy-independent-key");
    state.retrieve.mockRejectedValue(new Error("authentication failed"));
    await expect(getUncachableStripeClient()).rejects.toThrow("authentication failed");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses the same key and pinned account for synchronization", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "dummy-independent-key");
    await getStripeSync();
    expect(state.sync).toHaveBeenCalledWith(expect.objectContaining({
      stripeSecretKey: "dummy-independent-key",
      stripeAccountId: EXPECTED_STRIPE_ACCOUNT_ID,
    }));
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not inherit connector webhook bindings in independent mode", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "dummy-independent-key");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "dummy-signing-secret");
    vi.stubEnv("FORGEPROOF_STRIPE_CONNECTOR_WEBHOOK_URL", "https://other.example/api/stripe/webhook");
    vi.stubEnv("FORGEPROOF_STRIPE_CONNECTOR_WEBHOOK_ACCOUNT_ID", EXPECTED_STRIPE_ACCOUNT_ID);
    const credentials = await getStripeCredentials();
    expect(credentials.webhookSecretUrl).toBeUndefined();
    expect(credentials.webhookSecretAccountId).toBeUndefined();
  });
  it("passes explicit independent webhook bindings without changing them", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "dummy-independent-key");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "dummy-signing-secret");
    vi.stubEnv("FORGEPROOF_STRIPE_WEBHOOK_URL", "https://app.example/api/stripe/webhook");
    vi.stubEnv("FORGEPROOF_STRIPE_WEBHOOK_ACCOUNT_ID", EXPECTED_STRIPE_ACCOUNT_ID);
    expect(await getStripeCredentials()).toMatchObject({
      webhookSecret: "dummy-signing-secret",
      webhookSecretUrl: "https://app.example/api/stripe/webhook",
      webhookSecretAccountId: EXPECTED_STRIPE_ACCOUNT_ID,
    });
  });
});
