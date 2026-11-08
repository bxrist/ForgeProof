# ForgeProof Milestone 0B — private Git application parity (source only)

## Original owner authority, verbatim

> Milestone 0B: use the handoff of 0a and continue.
>
> Proceed until done
>
> Continue until done only prompt me if I’m absolutely needed

These directions remain authoritative. The changes in this source branch are non-authoritative engineering implementations and tests, not permission to bypass production/commercial controls.

## Added, independently tested source capabilities

1. **Encrypted pending email records.** A private tenant/repository Git event contains only delivery state, a keyed HMAC message digest and AES-256-GCM authenticated ciphertext. Mail recipients, subjects and bodies are never included as plaintext in immutable Git events or request fingerprints. Only an explicitly injected runtime 32-byte key can recover the message for authorized delivery. Signed keyless replay verifies ciphertext envelope structure; missing key/corrupt evidence fails closed. New records start pending with zero attempts; encrypted content is immutable and sent/failed statuses cannot be reopened. This is not a tested production SMTP lease/claim implementation or exactly-once sending guarantee.
2. **Immutable receipt GitHub export annotations.** Signed Git events bind a GitHub commit URL to the numeric receipt ID and independently verified original Ed25519 receipt entry hash, without rewriting, re-signing or changing historical original receipt bytes. Authorized owner-only GitStorage projections display the annotation; conflicting updates, deletion, missing receipt, unsafe URL and redirect/credential/token URLs are rejected. Case-variant hexadecimal SHAs are accepted and normalized.
3. **Encrypted new runtime audit metadata.** The GitStorage adapter encrypts otherwise unsupported free-form metadata on new audit records using an independently injected runtime key and existing protected audit envelope, without placing the metadata in signed Git records or operation fingerprints. Legacy null-metadata audit records remain supported. Default read views keep metadata redacted. A request key is generated randomly rather than derived from private metadata. This does not promise exactly-once audit event creation: the existing IStorage createAuditLog contract offers no caller-supplied idempotency key and the existing SQL path likewise creates one new row per call.

The source-only capabilities use the existing signed private Git event-store, original key pin/checkpoint rules and atomic ref update mechanism. These are not changes to the default server's PostgreSQL, Clerk, Stripe, payment, mail or HTTP request routes. No live data or secrets were copied or deployed. Test keys and customer identities are synthetic.

The user-private Replit history contains unpublished application changes and differs from the public GitHub product branch. Only self-contained new Git-store source modules and synthetic tests were selectively ported here. No raw file from the Replit working tree, private source escrow, production database or customer artifacts was copied into this public repository. A static high-confidence secret-literal scan of the changed files reported zero matches.

## Verification

On isolated OCI public-upstream branch based on source commit `3da56a2d77db7bcfab79bfdc3ea6f4ca6c77470d`, the following independently executed successfully before source publication:

- TypeScript: `npm run check` — PASS.
- Signed Git store and synthetic integration regressions: `node --import tsx --test tests/*.test.mjs` — **106/106 PASS**.
- Application build: `npm run build` — PASS.
- `git diff --check` — PASS.
- Independent Codex source review: no actionable issues found, opinion not an independent Darwin release signoff.

The separately reconciled current Replit development application had 87/87 Git-store Node and 215/215 Replit server Vitest synthetic tests, TypeScript and full client/server build PASS before this selective public port. Different source trees and test counts must not be conflated.

## Unfinished, genuine 0B acceptance work

Production application source and deployed commit remain unreconciled with the 72 unpublished Replit commits; all production business/auth/billing routes still require their reviewed SQL ownership and persistence. The native production database read-replica tool supports read-only aggregate verification but lacks transaction control and PGP encryption functions for safe full private row export, so a separately authorized consistent, privately protected production snapshot is required. Prior aggregate checks established 17 historic receipts and 14 audit events; do not substitute development's 24 receipts and zero audit events.

Independent runtime key custody, hosted private Git authority and backup, complete durable SMTP retry/leasing and session lifecycle, Stripe subscription/event commercial continuity, real production import, restart/replay/rollback, approved upstream ForgeProof release, separately integrated LifeOS consumer and independent Darwin GO are still outstanding. Keep issue #2 and draft PR #14 open until actual acceptance.

No production deployment, live Stripe operation, customer migration, new scheduler, release signoff or model-authorship provenance attestation occurred as part of this source-only change.

## New attestation issuance — explicit protected receipt custody (source only)

The experimental GitStorage.createAttestationAndCount has been corrected to require an explicitly provisioned runtime 32-byte private receipt encryption key, a cryptographically valid original Ed25519 source signature, and the EXACT signedAt timestamp. It does not re-sign historical or new records, guess the signing instant, infer model/author/location, or put private metadata/auditDetails in signed Git or the idempotency fingerprint. Original 26-field v1 source receipts are encrypted under tenant/repository-bound AES-256-GCM, with a genuine Ed25519-verified redacted core for keyless replay. The request fingerprint is an HMAC keyed by the external runtime receipt key rather than a dictionary-searchable unkeyed SHA. The original signature and global predecessor sequence must validate before a Git CAS can append the source receipt and increment subscription usage atomically; repeat requests with identical idempotency key do not charge again. Inputs cannot forge GitHub export provenance; links are added only via separate signed annotation after actual export.

Two independent source-signing MCP callsites had omitted signedAt, even though they signed exactly that timestamp. Both now pass through the already computed original timestamp, without altering the signature, signer or other app logic. This fixes a source issue that cannot safely be repaired by substituting SQL createdAt.

Independent isolated OCI public-source verification: **107/107 Node tests**, TypeScript and full client/server build PASS, and authentic signed two-receipt private Git synthetic test including null/redacted metadata and ciphertext restore. Separately reconciled private Replit source: **88/88 Node + 215/215 Vitest**, TypeScript and full build PASS. The public-source tests verify absence of plaintext private sentinel in signed events, stable replay, external-key requirements, parent/global chain and idempotent quota handling.

Independent Codex reviewer flagged the new optional key as a potential backward compatibility issue. This is deliberately fail-closed: the *standalone experimental* GitStorage class cannot safely write encrypted private receipt metadata without a runtime key; the isolated source-only HTTP application currently exposes repository/subscription/verify endpoints only, **not** an attestation creation endpoint; and default live ForgeProof SQL/Clerk/Stripe routes are not wired to this experimental adapter. Production mode is explicitly rejected by isolated.ts. Key provisioning and eventual authenticated issuance API are still work to do before actual release; never bypass the missing-key check or treat a 409 as live commercial continuity.

No production PostgreSQL, webhook, Stripe, Replit deployed code, secrets or customer rows were modified, and the source remains a draft, not a live 0B GO.

## Reviewed nonsecret user-state compatibility

The current separately maintained Replit application schema has three safe persisted user preferences missing from earlier signed Git records: `notifyOnGitFailure`, `detailRepoId` and `lastActiveTab`. The experimental signed Git user class now validates and persists those values without weakening the ban on plaintext GitHub OAuth tokens. Legacy users lacking the preferences resolve to the actual SQL defaults (`true`, `null`, `null`); explicit `false` is never overwritten by a default. `GitStorage.updateUser` requires the exact authenticated owner principal even when the target user belongs to the same tenant, preventing one tenant member from changing another member's user preferences. Existing encrypted OAuth custody remains owner-scoped.

Isolated synthetic tests verify signed Git write, subsequent profile edit, independent Git clone and keyless replay, strict boolean/string validation, failed cross-owner mutation and rejection of raw OAuth token insertion. No live Replit, Clerk, Stripe, SQL, customer account or deployment changes occurred. This closes a source compatibility gap; it is not a full migration or production release.

## Opt-in atomic signed-Git receipt issuance

The existing ForgeProof PostgreSQL issuance code protects both predecessor-chain continuity and metering quota inside one transaction. This private signed-Git implementation adds an independent, source-only issuer for the same core cryptographic guarantees without introducing a second SQL authority. A trusted external Ed25519 receipt signer is supplied explicitly. The GitStorage adapter replays the authenticated latest Git head and current user subscription, derives the legacy signed receipt hash with an explicit stable signedAt timestamp, obtains a signature over the exact legacy wire format, encrypts original private metadata, and conditionally appends both the receipt and the incremented subscription count in one signed Git event.

Distinct concurrent requests that race on the predecessor get re-evaluated and re-signed from the newly verified predecessor after a CAS conflict. Repeated identical request IDs return the original accepted receipt without re-signing or charging quota. Reuse of an ID with different source content is rejected through an HMAC-keyed private request commitment; private payloads are not placed in event IDs or audit fingerprints. The receipt signer must be pinned by the independently configured Git trust. The original existing pre-signed receipt storage path and production HTTP handler remain unchanged.

Synthetic-only signed private bare-Git tests verify two parallel receipts in exact Ed25519 predecessor order, quota 2/2, failed third request, duplicate/replayed request, wrong user, bad signer/key/receipt version/timestamp, encrypted original metadata and clean disconnected clone replay. This does **not** establish live ForgeProof issuance readiness: the published Replit routing/Clerk service/Stripe/LifeOS service approval are not wired to this method, nor have provider-owned live signing keys or production records been used.

Private isolated source tests 125/125 Node + 215/215 existing Replit Vitest, TypeScript, build, independent source review PASS; public selective port must be separately validated.
