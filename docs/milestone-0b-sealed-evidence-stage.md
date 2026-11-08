# Milestone 0B — Historical signed receipts and audit logs from sealed SQL source

## Owner instructions, verbatim and authoritative

> Milestone 0B: use the handoff of 0a and continue.

> Proceed until done

> Continue until done only prompt me if I’m absolutely needed

The engineering implementation below is a non-authoritative, bounded source-only contribution. ForgeProof remains a separately maintained commercial upstream product, and LifeOS remains its downstream consumer. No real source SQL records, published application, Stripe, production keys, customer content, or LifeOS source were modified.

## Purpose and exact scope

`stageSealedHistoricalGitEvidence` reuses the previously reviewed `verifySealedMigrationRelations`, `openSealedFullState`, `protectLegacyReceipt`, `protectLegacyAuditLog`, and existing `GitAppStateService` signature and predecessor enforcement. The entrypoint accepts an **already complete and authenticated** ten-table encrypted SQL source snapshot and separately provided source AES-256-GCM key, source HMAC key, independently pinned original Ed25519 receipt-signing keys/head, and a distinct 32-byte historical evidence archive key. It performs NO database queries, network calls or live application state changes.

Only original `attestation_receipts` and `audit_logs` rows are mapped. It maps **all 26 reviewed original SQL receipt fields** into the exact existing legacy receipt protocol fields without dropping private metadata, audit details or original signature/public key, and maps all 8 reviewed audit fields exactly. Original signed entry hash, signedAt, predecessor, signed public key and the complete lineage are validated; all private unstructured evidence and audit metadata are retained encrypted inside new version-3 authenticated protected envelopes. The original SQL source is canonicalized into a deterministic full application-row JSON representation before protection. These bytes are restored *exactly* from the new protected envelope. This is **NOT** a claim to preserve original HTTP serialization or PostgreSQL disk bytes; such original bytes were not present in the reviewed normalized SQL source.

Each receipt and audit is staged as a separate safe signed-Git transaction with an idempotency ID based on the **keyed source HMAC commitment**, never the raw SQL source fingerprint, private customer ID, source metadata, or an unkeyed private plaintext digest. The original signing history is never re-signed. Receipt order is numeric source ID; existing signatures and predecessor chain are independently checked and keyless verified in the eventual Git stream. Existing envelope size ceilings remain enforced; any invalid signature, untrusted signing key, missing/foreign relationship, wrong source/trust/key/scope, malformed source schema, or unsupported output size must fail closed with a generic non-disclosing error.

**Important append/retry requirement:** AES-GCM uses fresh per-row random nonces; re-running staging on the same source yields different ciphertext even with the same stable idempotency IDs. The exact generated `privateStage` must therefore be persisted durably in an authorized private encrypted staging area **before the first Git append**. Every retry uses those exact saved bytes, rather than regenerating. This requirement is a pre-existing security/integrity consequence, not a newly invented product approval gate. Any partial import needs source HMAC and per-transaction recovery reconciliation before release. This module does not implement that durable staging, distributed vault backup or rollback itself.

The return value includes `privateStage` holding encrypted original evidence records (private, not for public GitHub, Obsidian/Hindsight, logs or external connectors) and **safe aggregate-only** `summary` with counts, keyed source commitment, keyed stage digest, persistence requirement and unconditional `productionGoAllowed:false` / `fullApplicationMigrationComplete:false`.

The other application tables `sessions`, `api_keys`, `pending_emails` remain separately pending. The previously verified core five-table stage handles users/organizations/repositories/memberships/subscriptions in the same future private authority; this receipt/audit stage does not activate any live routes or make PostgreSQL non-authoritative.

## Synthetic tests and acceptance boundary

Tests use the exact reviewed ten-table synthetic SQL fixture, genuine Ed25519 legacy original receipt signature/predecessor chain, real private signed bare Git event service and a separately authenticated source snapshot. After the five core tables are staged, two historical protected receipts and one protected audit are appended as signed events, duplicate append is idempotent, private metadata is absent from event JSON, and a disconnected independent Git clone reconstructs the same signed receipt head and original protected audit metadata after authorized decrypt. Negative tests cover wrong trusted signer/head, wrong source AES/scope, invalid evidence key, missing relationships/receipt parents, damaged ciphertext, and exact canonical SQL row restoration without reissuing signatures.

This is **experimental source-only migration staging**, not the actual production export, durable migration journal, released ForgeProof API, provider/Stripe/Clerk/email integration, production cutover, or native independent Darwin GO. Milestone 0B remains NO_GO until actual ten-table state and provider continuity are verified.
