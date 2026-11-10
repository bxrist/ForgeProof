import { getStripeSync } from './stripeClient';
import { getUncachableStripeClient } from './stripeClient';
import { hasApplicationStorage } from "./storageBackend";
import { getStripeCredentials } from './stripeClient';
import { pool } from './legacySqlPool';
import { EXPECTED_STRIPE_ACCOUNT_ID } from "./stripeConfig";
import { getConfiguredWebhookTargets } from "./stripeAdmin";
import { ownsStripeEvent } from "./stripeOwnership";

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<boolean> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        'STRIPE WEBHOOK ERROR: Payload must be a Buffer. ' +
        'Received type: ' + typeof payload + '. ' +
        'This usually means express.json() parsed the body before reaching this handler. ' +
        'FIX: Ensure webhook route is registered BEFORE app.use(express.json()).'
      );
    }

    const gitMode=hasApplicationStorage();
    const sync = gitMode ? {stripe:await getUncachableStripeClient(),processEvent:async (_event:unknown)=>{}} : await getStripeSync();
    const webhookConfiguration = getConfiguredWebhookTargets();
    const currentTarget = webhookConfiguration.currentTarget;
    if (!currentTarget) {
      throw new Error("No current-environment Stripe webhook target is configured");
    }
    const secrets = new Set<string>();

    // An environment or connector secret is usable only when an operator explicitly binds it
    // to this deployment's exact target URL and pinned account.  An unbound
    // secret is never a fallback for another environment's endpoint.
    try {
      const credentials = await getStripeCredentials();
      if (credentials.webhookSecret &&
          credentials.webhookSecretUrl === currentTarget.url &&
          credentials.webhookSecretAccountId === EXPECTED_STRIPE_ACCOUNT_ID) {
        secrets.add(credentials.webhookSecret);
      }
    } catch {
      // The managed endpoint path below remains available when connector
      // credentials do not expose an explicitly bound webhook secret.
    }

    if (!gitMode) try {
      const result = await pool.query(
        `SELECT url, secret
           FROM stripe."_managed_webhooks"
          WHERE account_id = $1
            AND url = $2
            AND secret IS NOT NULL
          ORDER BY created ASC`,
        [EXPECTED_STRIPE_ACCOUNT_ID, currentTarget.url],
      );
      for (const row of result.rows) {
        if (row.url === currentTarget.url &&
            typeof row.secret === "string" && row.secret.length > 0) {
          secrets.add(row.secret);
        }
      }
    } catch {
      // If the exact current-environment row cannot be inspected, no
      // unassociated connector secret may silently replace it.
    }

    if (secrets.size === 0) {
      throw new Error("No Stripe webhook signing secret is configured for the current environment");
    }

    let verificationError: unknown;
    for (const webhookSecret of Array.from(secrets)) {
      let event: any;
      try {
        event = await sync.stripe.webhooks.constructEventAsync(payload, signature, webhookSecret);
      } catch (error) {
        // A request signed for the other registered URL is expected to fail
        // against this candidate secret.  Do not expose candidate secrets or
        // provider error details in the eventual response.
        verificationError = error;
        continue;
      }
      // Do not try another secret after a valid signature: processing may have
      // partially persisted the event and must not be duplicated.
      if (!await ownsStripeEvent(event)) return false;
      await sync.processEvent(event);
      return true;
    }
    throw verificationError instanceof Error
      ? new Error("Stripe webhook signature verification failed")
      : new Error("Stripe webhook signature verification failed");
  }
}
