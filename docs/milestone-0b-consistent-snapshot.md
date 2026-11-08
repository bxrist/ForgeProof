# Milestone 0B — injected read-only PostgreSQL evidence snapshot adapter

`captureProtectedEvidence(client, source, encryptionKey)` is a **source-only, nonproduction** adapter. It receives one caller-owned PostgreSQL client, a reviewed historical source manifest and an externally supplied runtime AES-256-GCM key. It does **not** obtain a connection string, create a client, store credentials, deploy code or access any real database on its own.

After input validation, the adapter runs `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, sets a bounded SQL statement timeout, reads `attestation_receipts` and `audit_logs` in the **same transaction**, checks their current exact schema, converts PostgreSQL snake_case names to the established ForgeProof historical camelCase schema and normalizes Date values. It rejects unknown/omitted columns, duplicate mappings, invalid IDs and malformed query results. It does not query keys, active sessions, subscriptions, users, Stripe or unrelated tables.

The adapter invokes `buildProtectedHistoricalArchivePreflight` while the transaction is still active, requiring an independently reviewed original public signing-key set, original receipt head, record totals and source fingerprint. Complete historical receipt signatures, global predecessor links and sealed original SQL export bytes are preflighted before COMMIT. On any failure the adapter attempts ROLLBACK and emits only a bounded generic error: no raw SQL rows, database credentials or private encryption key are returned or logged. A successful result includes only encrypted migration stage records, a digest and aggregate evidence.

The exact restored bytes are the **serialization of the SQL fields read by this adapter**, not necessarily the original HTTP issuance response: PostgreSQL columns may not have retained the original response bytes. A caller must not claim original user/model/location attribution beyond what the original legacy signature authenticated.

## Required before real use

- Use an actual read-only, scoped, independently authenticated PostgreSQL connection **to the correct production snapshot**, with no credential or key material in source or logs. The existing Replit native read-only SQL callback does not support transaction-control statements and therefore has **not** run this adapter.
- Independently verify the reviewed manifest and trusted signer pins from a separate source; a self-declared manifest is not authority.
- Provide secure runtime key custody, durable encrypted stage output outside the public source repository, documented key recovery and a private Git evidence remote with ACLs/anti-rollback checkpoints.
- Compare returned original record counts and digests with the consistent source snapshot and run disconnected clone-only recovery and app/billing continuity tests.
- Preserve app-owned users, credentials, sessions, repositories, subscriptions, audit events, Stripe provider truth and other business state through a separate reviewed component. This adapter covers historical evidence only.

Synthetic tests inject a fake transaction client, produce real Ed25519-linked receipts and null/non-null audit metadata, verify expected query ordering and encrypted output, and exercise incorrect signer pins, unknown/missing source columns, SQL failure rollback and generic error handling. These tests establish the code pathway, **not a real production migration or Darwin GO**. Default ForgeProof production remains PostgreSQL-backed; LifeOS remains a separate consumer.
