# Milestone 0B — Five-table private Git staging from authenticated sealed SQL source

## Owner authority (verbatim)

> Milestone 0B: use the handoff of 0a and continue.

> Proceed until done

> Continue until done only prompt me if I’m absolutely needed

The implementation and limits below are non-authoritative engineering outcomes, not new owner requirements. ForgeProof is a separately maintained commercial upstream application; LifeOS is the downstream API consumer. The original 0A closure is not reopened.

## Exactly what this source module does

The experimental `stageSealedCoreGitState` module accepts a previously captured **complete ten-table AES-256-GCM encrypted SQL snapshot**, two separate 32-byte externally provisioned encryption/HMAC keys, reviewed source manifest, exact Git tenant/repository scope and independently pinned original Ed25519 receipt signer/head trust.

It first calls the full ten-table `verifySealedMigrationRelations` preflight. Missing references, untrusted historical receipts, invalid signatures, a divergent historical predecessor, an incorrect reviewed source or damaged ciphertext all fail closed. Only after that may it decode and validate the source inside the caller's protected runtime.

The module converts **only five application-state classes** using explicit 1-to-1 exact mappings of every reviewed original SQL column to permitted private Git record fields: users, organizations, repositories, org_members and subscriptions. Unknown, missing or retyped source fields are rejected, not silently ignored. Values such as existing explicit `false` notification preferences, nullable repository selections and original commercial subscription plan/usage/status are preserved exactly. Unsupported billing status or plan is **rejected rather than rewritten**. Every projected record is checked by existing signed Git record validation. The five classes are sorted deterministically and returned as **one private transaction** with expectedVersion null and a stable HMAC-keyed source identity. The method never directly appends, changes an application server, or claims Git is already production authoritative.

A non-null SQL user `github_token` is staged through the **existing independently encrypted CredentialCustodian** with credential kind `github-oauth`, exact authenticated tenant plus hashed user namespace, and a stable HMAC-derived custodian request. The returned private Git record contains ONLY an opaque `githubTokenRef` pointer, not a raw token or token fingerprint. Repeated staging of the same sealed source with the same durable external vault reuses the same pointer and produces identical signed Git input; loss of vault custody must fail closed, not silently disconnect GitHub.

The remaining original SQL tables — sessions, attestation_receipts, api_keys, pending_emails and audit_logs — remain **explicitly unmigrated**. They still exist in the separately retained encrypted full-state source; this code does not pretend to preserve them as usable Git application records. The private transaction **does contain customer profile/contact fields** from the private SQL source and must never be logged, sent to public GitHub, Obsidian/Hindsight, third-party agents, or untrusted interfaces. It is suitable only for an authenticated, access-controlled, private signed Git authority. The returned summary is aggregate-only and always states `productionGoAllowed:false` and `fullApplicationMigrationComplete:false`.

The current signed Git backend requires at most 1000 operations and an approximately 8 MiB signed event budget. This bounded stage fails closed above either budget. Segmented multi-event imports, distributed vault/ledger failure reconciliation, preservation of existing sessions and API keys, full original receipt/audit/email migration, source export consistency and live commercial cutover are separate unfinished work; no automatic retry scheduler or gate is invented. The original sealed snapshot must remain durably retained to prevent information loss.

## Acceptance evidence boundary

All code and tests here use generated synthetic SQL rows, Ed25519 Git event signing, exact reviewed source-table fixtures and a separately encrypted in-memory test vault. Tests must prove source schema mapping and a real independently restored signed Git private ledger, absence of OAuth/session/API/email/audit secrets from transaction/event JSON, correct external vault recovery, idempotent retry, wrong key/source/tenant failure, malformed commercial state refusal and size limits.

Neither passing tests nor this module establishes a real production SQL export, deployed private Git authority, live Clerk/Stripe/webhook/email behavior, approved upstream ForgeProof release, downstream LifeOS adoption, or independent Darwin GO. **Milestone 0B stays NO_GO** until actual data migration and production recovery are verified.
