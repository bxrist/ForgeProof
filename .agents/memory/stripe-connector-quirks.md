---
name: Stripe connector quirks
description: Non-obvious behaviors of the Replit Stripe connector and webhook handling in this project
---

- The Replit Stripe connector's connection settings expose the API key as `secret` (and `publishable`), NOT `secret_key` as the standard template assumes. The credential fetcher accepts both.
- The webhook route must return non-2xx when app-level subscription state handling fails (not just signature/sync failure), otherwise Stripe won't retry and billing state goes stale.
- Usage resets on `invoice.paid` must be gated on `billing_reason === "subscription_cycle"` — proration/adjustment invoices would otherwise grant surprise quota resets.
- Plan prices are looked up from the synced `stripe.prices`/`stripe.products` tables by product name ("ForgeProof Pro" / "ForgeProof Enterprise"); renaming products in Stripe breaks checkout.
