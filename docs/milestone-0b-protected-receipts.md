# ForgeProof 0B — protected historical receipts (nonproduction)

This source-only feature introduces an opt-in v2 receipt record for the experimental private Git event store. It does **not** change ForgeProof's deployed PostgreSQL authority, the legacy HTTP app, Stripe, Replit authentication, or LifeOS.

## Record and trust model

The original historical receipt is supplied as raw UTF-8 bytes. The protected-receipt builder parses the original JSON, sets only `metadata` and `auditDetails` to null in its verified core, and calls the **existing Ed25519 receipt verifier** on the resulting signed fields. The exact original bytes, including whitespace, are encrypted using a fresh AES-256-GCM nonce and a runtime-injected 32-byte key. The event contains a cryptographic hash of ciphertext, a hash of original plaintext and a complete redacted receipt core; it never contains plaintext original metadata or audit details. The AES-GCM authenticated-data scope binds tenant, repository, receipt ID and entry hash. The private ledger's own event signature covers the entire protected record. Full private Git store ACLs and independent trust/checkpoint pins remain essential.

During **keyless replay**, the store validates the receipt's historical Ed25519 signature and entry hash, enforces original public-key trust pins, verifies the encrypted payload structure and ciphertext digest, and enforces the original global receipt predecessor chain and immutable original IDs. It does not silently decrypt. Authorized recovery requires the separate encryption key, validates the AES-GCM tag, verifies full receipt/core equivalence and returns the original bytes exactly.

**Important provenance limitation:** The legacy Ed25519 receipt signature binds only the historical hash fields and timestamp; it does **not** sign metadata, audit details, file path, identity, or every other field. Other core fields receive integrity protection from the new authenticated **Git event signature** and encrypted payload comparison, not from retroactive signing by the original AI/model. No historical original authorship or geographic attribution is invented.

## Evidence and boundaries

Synthetic tests generate real Ed25519 keys and valid receipt predecessor links. They exercise two chained protected receipts appended to a temporary private bare Git store; independently cloned keyless verification; exact original byte restoration with a disposable key; corrupt ciphertext, swapped scope, altered signed core and wrong-predecessor negatives; and idempotent replay without duplicate accepted attestations. Existing v1 records remain unchanged.

This is **not yet a production historical migration**. The existing read-only SQL snapshot and legacy restricted archive remain intentionally fail-closed on private/unstructured receipt metadata. A real consistent source snapshot, secure export/custodian provisioning, complete old-global-chain provenance, all commercial state including audit metadata, reliable provider reconciliation, durable independent checkpoints, disaster recovery and full PostgreSQL-free application cutover remain outstanding. The key must never enter public Git, a public repo, logs, or a deployment artifact. If the key is lost, exact private receipt recovery is impossible even if the signed redacted core can still be independently verified. Do not deploy this experimental code as the default ForgeProof production store.

**Separation:** ForgeProof owns this upstream implementation. LifeOS consumes a released versioned interface only after independent Darwin acceptance; no source files or database objects are imported into LifeOS.
