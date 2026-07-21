# Memory Index

- [Hash-chain concurrency](hash-chain-concurrency.md) — all attestation inserts must serialize via the advisory-lock transaction; quota checks must live inside that same transaction.
- [Stripe connector quirks](stripe-connector-quirks.md) — Replit Stripe connector exposes `secret` (not `secret_key`); webhook 200 only after app-level event handling succeeds.
