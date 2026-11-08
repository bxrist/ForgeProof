# Milestone 0B — Sealed production-source relationship reconciliation

## Original owner directions — authoritative, verbatim

> Milestone 0B: use the handoff of 0a and continue.

> Proceed until done

> Continue until done only prompt me if I’m absolutely needed

The following is technical implementation evidence, not permission to alter commercial behavior, begin an unverified production migration, or add approval gates. ForgeProof is an independent upstream product from LifeOS.

## Scope

The opt-in `verifySealedMigrationRelations` module takes an already authenticated and AES-256-GCM-sealed complete **ten-table PostgreSQL source snapshot** and decrypts it only inside the caller's authorized, protected runtime. It reuses the existing strict `openSealedFullState` schema and source-HMAC verification. No connection details, DB queries, key material, source row contents, files, Git writes, customer identifiers or raw plaintext leave the function.

The source is the reviewed exact original PostgreSQL schema: `users`, `sessions`, `repositories`, `attestation_receipts`, `api_keys`, `organizations`, `org_members`, `subscriptions`, `pending_emails`, and `audit_logs`. This is **not** the camelCase GitStorage record schema. Check every relevant SQL foreign relationship to users, organizations, repositories and receipt parents using the actual snake_case columns. The opaque `sessions.sess` JSON is not interpreted as an authenticated user identity. Stripe-managed provider/webhook records are not claimed to be part of these ten application tables.

Original receipts are mapped field-for-field from exactly 26 original snake_case SQL columns to the exact 26 reviewed ForgeProof `receiptFields` fields. The verification uses the original legacy Ed25519 hash/signature protocol and the original timestamp, but replaces unsigned private metadata and audit details with null **only in an ephemeral verification copy**. The actual original rows in the sealed snapshot are never modified or re-signed. Independently pinned original signer public keys, ordered predecessor hashes and the expected historical source head must all agree before an import can be described as relationally coherent.

The return value consists only of ten table counts, per-type missing-reference counts, historical signature/trust/chain mismatch counts, numeric counts of source rows needing external secret custody, the already authenticated keyed whole-source HMAC, and explicit `productionGoAllowed:false`. `importEligible` means **only** that these synthetic relationship, trust and continuity checks found no mismatch. It does not establish commercial, authorization, vault, mail-provider or real-production readiness.

Any malformed encrypted envelope, wrong keys, unsupported reviewed manifest, or source type confusion returns the same generic error without exposing data. No source record identifiers, customer emails, session values, API key hashes, signing public keys, or metadata appear in the report.

## Synthetic verification

Tests create a real Ed25519 original receipt chain and a complete ten-table synthetic SQL dataset inside a fake injected read-only transaction. Negative tests cover untrusted signer, missing user/org/repo/parent references, incorrect independently pinned historical head, signed predecessor mismatch, wrong archive key/source, malformed ciphertext and complete empty receipt history. Every test checks that reports remain aggregate-only. No real customer, production database, Stripe, Clerk or deployed ForgeProof runtime has been accessed.

This is a nonproduction, source-only step toward a reviewed full-state migration, not the actual migration. The remaining production closure work is a consistent privileged-but-read-only approved source export, safe external credential custody, real Git application-state mapping, provider/Stripe/Clerk/mail parity, deployment and rollback, upstream ForgeProof release, LifeOS consumption and independent Darwin GO.
