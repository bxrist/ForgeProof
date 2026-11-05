# Independent Stripe credential mode

The default remains the existing Replit managed Stripe connector. To opt into an independently managed Stripe account, set `STRIPE_CREDENTIAL_MODE=direct` and configure all of:

- `STRIPE_SECRET_KEY`: secret key for the independently managed Stripe account.
- `STRIPE_WEBHOOK_SECRET`: signing secret for the webhook endpoint configured for this deployment.
- `EXPECTED_STRIPE_ACCOUNT_ID`: pinned Stripe account ID (`acct_...`) expected from that key.

Direct mode fails closed if any value is missing, if Stripe reports a different account, or if an `sk_test_` key is used with `NODE_ENV=production`. The account is checked using Stripe's account retrieval API before the application client or StripeSync is constructed. The key therefore needs permission to retrieve the account. The key, webhook secret, and signing secret are never logged. Do not put credentials in source, tests, or documentation.

`STRIPE_CREDENTIAL_MODE` accepts only `managed` or `direct`; unset and `managed` preserve the connector path. Direct mode never falls back to the connector and requires a preexisting webhook endpoint configured for this deployment and signing secret. Startup validates the direct credentials but does not register, replace, reconcile, or backfill provider webhooks or Stripe data; those actions require separate provider reconciliation approval. A test key can be used in non-production environments for offline/staging validation only; use a separate Stripe test account and matching test webhook secret. This source change does not change products, prices, subscriptions, customer data, authorization, entitlements, or checkout behavior.

## Replit release preconditions and sequence

This GitHub checkout is not assumed to match the existing Replit workspace. Before any deployment:

1. Reconcile this reviewed source change with the current Replit workspace and inspect the complete resulting diff. Preserve the workspace's newer Stripe adapter, account pin, and readiness guards; do not overwrite it with this checkout.
2. Confirm an independently managed Stripe account is authorized for the service and its live secret is stored in Replit's secret store. Confirm and pin its `acct_...` ID in `EXPECTED_STRIPE_ACCOUNT_ID`.
3. Configure `STRIPE_CREDENTIAL_MODE=direct`, the live `STRIPE_SECRET_KEY`, and that account's `STRIPE_WEBHOOK_SECRET`. Ensure `NODE_ENV=production`; direct mode rejects a test key in this environment.
4. Configure the Stripe webhook endpoint to the final deployment URL plus `/api/stripe/webhook`, with the required event types, and use the signing secret for that exact endpoint. Confirm the deployment's public URL and endpoint are correct before enabling traffic.
5. In a separate non-production deployment/account, gather safe evidence for account pin success and mismatch rejection, checkout session creation, signed webhook acceptance/rejection, and customer portal behavior. Use test credentials and test customer data only. Confirm no live payments or production data were touched.
6. Only after these checks, disconnect the managed sandbox connector and publish the reconciled workspace. Verify live checkout, webhook delivery/signature handling, and portal behavior using an approved low-risk verification procedure, without creating an unapproved pricing plan.
7. Keep a rollback ready before publishing: restore the prior known-good workspace revision and its prior credential mode/secrets, re-enable the managed connector only if its sandbox limitations are acceptable, and confirm webhook routing and billing readiness. Do not switch live users to a sandbox key as rollback.

This document records release prerequisites only. It does not authorize deployment, connector changes, secret-store changes, external Stripe changes, or production verification.
