import Stripe from 'stripe';
import type { StripeSync } from 'stripe-replit-sync';
import { EXPECTED_STRIPE_ACCOUNT_ID, STRIPE_LIVE_MODE } from "./stripeConfig";

export async function getStripeCredentials(): Promise<{
  secretKey: string;
  webhookSecret?: string;
  webhookSecretUrl?: string;
  webhookSecretAccountId?: string;
}> {
  if (STRIPE_LIVE_MODE) {
    const secretKey = process.env.FORGEPROOF_LIVE_STRIPE_SECRET_KEY?.trim();
    if (!secretKey) throw new Error("Missing ForgeProof live Stripe credential");
    return {
      secretKey,
      webhookSecret: process.env.FORGEPROOF_LIVE_STRIPE_WEBHOOK_SECRET,
      webhookSecretUrl: process.env.FORGEPROOF_LIVE_STRIPE_WEBHOOK_URL,
      webhookSecretAccountId: EXPECTED_STRIPE_ACCOUNT_ID,
    };
  }
  // An explicitly supplied independent key takes precedence. Never fall back
  // to a different connector/account if that key is empty, invalid or rejected.
  if (process.env.STRIPE_SECRET_KEY !== undefined) {
    const secretKey = process.env.STRIPE_SECRET_KEY.trim();
    if (!secretKey) {
      throw new Error("STRIPE_SECRET_KEY is configured but empty");
    }
    return {
      secretKey,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
      webhookSecretUrl: process.env.FORGEPROOF_STRIPE_WEBHOOK_URL,
      webhookSecretAccountId: process.env.FORGEPROOF_STRIPE_WEBHOOK_ACCOUNT_ID,
    };
  }

  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!hostname || !xReplitToken) {
    throw new Error(
      'Missing Replit environment variables. ' +
      'Ensure the Stripe integration is connected via the Integrations tab.'
    );
  }

  const resp = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=stripe`,
    {
      headers: { Accept: "application/json", X_REPLIT_TOKEN: xReplitToken },
      signal: AbortSignal.timeout(10_000),
    }
  );

  if (!resp.ok) {
    throw new Error(`Failed to fetch Stripe credentials: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json();
  const settings = data.items?.[0]?.settings;
  const secretKey = settings?.secret_key || settings?.secret;

  if (!secretKey) {
    throw new Error(
      'Stripe integration not connected or missing secret key. ' +
      'Connect Stripe via the Integrations tab first.'
    );
  }

  return {
    secretKey,
    webhookSecret: settings.webhook_secret,
    // A connector secret is usable only when an operator explicitly binds it
    // to this deployment's exact webhook URL.  The connector does not expose
    // that ownership relationship on its own.
    webhookSecretUrl: process.env.FORGEPROOF_STRIPE_CONNECTOR_WEBHOOK_URL,
    webhookSecretAccountId: process.env.FORGEPROOF_STRIPE_CONNECTOR_WEBHOOK_ACCOUNT_ID,
  };
}

async function assertExpectedStripeAccount(stripe: Stripe): Promise<void> {
  const account = await (stripe.accounts.retrieve as any)();
  if (account.id !== EXPECTED_STRIPE_ACCOUNT_ID) {
    throw new Error("Stripe account identity mismatch");
  }
  const balance = await stripe.balance.retrieve();
  if (balance.livemode !== STRIPE_LIVE_MODE) throw new Error("Stripe mode mismatch");
}

export async function getUncachableStripeClient(options?: { skipAccountGuard?: boolean }): Promise<Stripe> {
  const { secretKey } = await getStripeCredentials();
  const stripe = new Stripe(secretKey);
  if (!options?.skipAccountGuard) {
    await assertExpectedStripeAccount(stripe);
  }
  return stripe;
}

export async function getStripeSync(): Promise<StripeSync> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  const { secretKey, webhookSecret } = await getStripeCredentials();
  const { StripeSync } = await import('stripe-replit-sync');
  const sync = new StripeSync({
    poolConfig: { connectionString: databaseUrl },
    stripeSecretKey: secretKey,
    stripeWebhookSecret: webhookSecret ?? '',
    stripeAccountId: EXPECTED_STRIPE_ACCOUNT_ID,
  });
  // StripeSync has mutating catalog/webhook methods.  Verify the provider
  // identity before returning it so a connector switch cannot write to a
  // different account.
  await assertExpectedStripeAccount(sync.stripe as Stripe);
  return sync;
}
