---
name: Hash-chain concurrency
description: How attestation inserts stay race-free and how quota enforcement must interact with the chain transaction
---

**Rule:** Every attestation insert must go through the single serialized transaction that takes `pg_advisory_xact_lock` before reading the latest `entry_hash`. Quota enforcement must also live *inside* that transaction as a conditional `UPDATE subscriptions ... WHERE attestation_count < attestation_limit RETURNING id` guard — a pre-check outside the transaction lets concurrent requests exceed the limit, and a post-commit increment can silently drift (a mid-test server restart once left counts at 0 despite committed receipts).

**Why:** Community-reported race corrupted chain linkage under parallel writes; verified fix with 15-way concurrent attests (chain fully valid, exactly one 201 at the 99/100 boundary).

**How to apply:** Any new endpoint that creates attestations must call the shared receipt-creation function, never insert receipts directly. `subscriptions.user_id` is UNIQUE; free-subscription creation uses `onConflictDoNothing` + refetch because parallel first requests once created duplicate rows.
