import Stripe from 'stripe';
import { StripeSync } from 'stripe-replit-sync';
import { assertStripeAccount, getDirectStripeCredentials, selectStripeCredentialMode, type StripeCredentialEnv } from './stripeCredentialConfig';

function stripeCredentialEnv(): StripeCredentialEnv {
  return {
    STRIPE_CREDENTIAL_MODE: process.env.STRIPE_CREDENTIAL_MODE,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    EXPECTED_STRIPE_ACCOUNT_ID: process.env.EXPECTED_STRIPE_ACCOUNT_ID,
    NODE_ENV: process.env.NODE_ENV,
  };
}

async function getStripeCredentials(): Promise<{ secretKey: string; webhookSecret?: string }> {
  if (selectStripeCredentialMode(stripeCredentialEnv()) === 'direct') {
    const credentials = getDirectStripeCredentials(stripeCredentialEnv());
    // Verify the key's account before it can be used for checkout or webhook processing.
    // The account ID is never inferred from the key and a mismatch fails closed.
    const stripe = new Stripe(credentials.secretKey);
    const account = await stripe.accounts.retrieve(null);
    assertStripeAccount(credentials.expectedAccountId!, account.id);
    return { secretKey: credentials.secretKey, webhookSecret: credentials.webhookSecret };
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
  };
}

export async function getUncachableStripeClient(): Promise<Stripe> {
  const { secretKey } = await getStripeCredentials();
  return new Stripe(secretKey);
}

export async function getStripeSync(): Promise<StripeSync> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  const { secretKey, webhookSecret } = await getStripeCredentials();
  return new StripeSync({
    poolConfig: { connectionString: databaseUrl },
    stripeSecretKey: secretKey,
    stripeWebhookSecret: webhookSecret ?? '',
  });
}
