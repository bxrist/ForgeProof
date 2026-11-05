# Per-attestation billing foundation (non-live)

This branch is independent from the current ForgeProof Replit workspace and may diverge from GitHub. Review and reconcile the diff against the live workspace before any deployment. Applying the additive SQL migration is a separate operator action; this branch does not run it.

## Current behavior

`FORGEPROOF_BILLING_MODE` defaults to `legacy`, preserving the existing subscription quota and no-charge issuance behavior. Each newly issued HTTP or storage-backed receipt records one `attestation_usage_events` row in the same SQL transaction as its receipt. The row attributes the authenticated user, channel, entitlement class and unit count. It records no unit price and remains `unsettled`; it is usage evidence, not a charge, credit debit, or settled payment. The unique `receipt_id` makes the event idempotent. Verification endpoints are unchanged and free. Historical receipts are not backfilled. LifeOS service identity usage is labeled `delegated_entitlement` and existing subscription behavior is unchanged.

`FORGEPROOF_BILLING_MODE=per_attestation_test` requires an explicit positive integer `FORGEPROOF_ATTESTATION_PRICE_CENTS`. The pure quote function accepts explicit positive integer units and computes integer USD cents; client values cannot set price. This mode is intentionally quote-only and issuance fails closed for HTTP and MCP. It does not charge, reserve credits, or claim payment. MCP remains a separate issuance path; its receipt and usage event are atomic in storage, but no paid MCP entitlement is enabled.

## Ledger meaning and future settlement

The ledger should distinguish `legacy_free`, `delegated_entitlement`, `prepaid_credit`, and `agent_mpp`. `settlement_status` is separate from usage classification. Future card support should use a human initiated Stripe **test-mode** Checkout purchase of prepaid credits, verified only from signed Stripe webhook events with event-ID idempotency. Never infer funding from a browser redirect. Future agent payments should return a genuine HTTP 402 challenge and accept a valid payment proof through a maintained Stripe MPP SDK, validating trusted provider evidence before atomically granting credit and issuing the receipt. Do not emulate MPP or treat a quote as payment.

Both rails should fund the same credit ledger and use a reservation/debit tied transactionally to issuance. Define refund and chargeback handling as compensating ledger entries; never delete or alter signed receipts. Failed issuance must release reservations, while already issued receipts remain verifiable. Reconcile provider settlement asynchronously and retain signed webhook/payment evidence with replay protection.

Before launch, decide unit price, provider fees, taxes, refunds, and gross-margin economics; no price is selected here. Keep Stripe monthly plans and special no-charge entitlements separate unless an explicit migration changes that policy. Required follow-up includes a locked central issuer for all channels, balance/credit tables, account-level authorization, idempotency keys, signed Stripe test Checkout/webhook flow, genuine MPP 402 flow, refunds, reconciliation, and integration tests against an isolated test database. No provider SDK or live operation is added in this foundation.
