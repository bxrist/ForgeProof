# LifeOS HTTP request identity correction

## Failure analysis and limits of the evidence

The POST handler called createAttestationReceipt with a fresh randomUUID and
server-generated signedAt on every HTTP call. GitStorage.mutate deduplicated
within a stable storage request, but separate HTTP attempts never shared that
identity. If Git committed and the HTTP acknowledgement was lost, another POST
could create another valid receipt. Correct CAS serialization and Ed25519
signatures do not identify two HTTP attempts as the same intended submission.

Existing atomic issuer tests exercised reuse of an explicitly supplied storage
request ID and timestamp, not their generation at the HTTP boundary. This left a
coverage gap between the handler and the durable write. An automatically retried
operation must carry stable intent from the caller through every boundary; it
cannot infer intent from matching content or retry a historical ambiguous write.
The deduplication return path also bypassed the insertion-time authorization
callback; retries now recheck the service state on each verified replay.

The earlier session's dependency installation exhausted device space before any
source changes were made (owner-supplied incident history). That was a tooling
failure separate from the protocol defect. This correction uses the checked-in
synthetic Git fixtures and Node's built-in TS transformation, without downloads.
This source review does not establish the contents or outcome of any production
submission, the exact automation decision history, or historical signer provenance.
Commit 288106ef remains ambiguous and cannot be made safe to resubmit retroactively.

## Independent review correction: proof-scoped storage

The extracted POST handler resolved Git storage before service proof. Production's
currentApplicationStorage is principal-scoped: proveLifeosControl binds that
principal using setVerifiedStoragePrincipal. A fresh authorized keyed request could
therefore receive 503 before authentication made its Git adapter available. The
status handler contained the same premature availability check.

The synthetic fixture originally exposed storage immediately, hiding this runtime
dependency. It now starts every request without a bound principal and exposes
storage only after successful proof. Both handlers resolve storage after proof;
POST also validates transport identity after proof, preserving authentication-first
ordering. The new regression checks the first keyed request, identical retry,
read-only status and unauthorized requests (including malformed identity), with
exact durable event counts. It confirms one append and no unauthorized issuance.

The declaration also used IStorage even though status requires GitStorage's replay
lookup and custody members. Its dependency now names GitStorage, with the existing
trusted storage bridge at the routes.ts injection. Body parsing uses a success
union with required typed data on success. Built-in TS transformation only checks
syntax; it does not establish semantic type correctness without dependencies.

The process lesson is to model request-local state transitions at dependency
boundaries, including state established by authentication. Adapter-level retry
coverage alone cannot validate handler ordering, and declaration contracts must
name the actual capabilities consumed by an extracted handler.

## Contract

POST /api/lifeos/attest opts in with BOTH:

- `Idempotency-Key`: 8–129 ASCII characters, first alphanumeric, then
  alphanumeric or `.`, `_`, `:`, `-`. Generate a fresh random UUID per new intent.
- JSON `signedAt`: canonical UTC ISO timestamp with milliseconds, for example
  `2026-11-11T12:00:00.000Z`. Persist it before sending; never regenerate on retry.

Missing one field, arrays/duplicate header values, or invalid formats return 400.
With neither field, the legacy behavior remains: each POST can issue a new receipt.
The timestamp is caller-selected signing input, not proof of the real event time.
No freshness window is imposed because durable retries can be delayed.

The authorized principal, existing storage operation label, and request ID scope
the existing Git event identity. The existing HMAC fingerprint binds the normalized
receipt source, including signedAt and private metadata, without publishing it.
Keyed requests use null detectedCountry/unverified compliance: changing proxy
country observations cannot change their semantic fingerprint. File-name fallback,
default origin type, null fields and enforced service metadata normalize as before.
Unknown JSON fields are ignored by the existing schema. Same normalized source
returns the original signed public receipt with 201 and no Git append or re-signing;
changed source or signedAt returns 409 with no append. GitStorage remains the only
durable authority; keyed requests cannot fall back to SQL. Keep the existing
receipt protection key stable across server restarts (it also keys fingerprints).

GET /api/lifeos/attest/status/:requestId requires the same existing approved service
Bearer credential, without adding attest:read or any other privilege. It uses
proveLifeosControl and rechecks service/key state against the verified Git replay,
then resolves only the authenticated principal's original storage event. It does
not update lastUsedAt or append events. 200 returns the original signed public
receipt; 404 means not found or unverified, 403 denies service proof, 400 rejects
invalid IDs, and 503 means verification/storage unavailable. Responses do not
expose another principal's event, fingerprint, receipt ID, or metadata. Private
metadata remains protected under the existing public receipt projection.

## Rollout order (documentation only; no deployment performed)

1. Review and validate this ForgeProof source with the full dependency-equipped CI
   suite, including existing entitlement tests, typecheck and Express integration.
2. Release ForgeProof first using its existing Git-authoritative backend, pinned
   signer, custody and protection keys. Confirm keyed POST and authenticated status
   in an authorized synthetic environment. Do not enable keyed clients on SQL.
3. Separately update the future LifeOS client: atomically persist request ID,
   canonical signedAt and complete semantic payload BEFORE its first submission.
   Keep them stable across process restarts, lost responses, delays and retries.
   Store and verify the returned signed receipt using existing trusted keys.
4. On ambiguous acknowledgement for a NEW keyed submission, query status first.
   200 resolves the original receipt; 404 alone does not prove a pending write
   failed. Only the identical keyed request is safe to retry. Keep 503/unverified
   unresolved; treat 409 as a payload/identity error requiring reconciliation.
5. Keep all historical unkeyed UNKNOWN submissions, including 288106ef, in manual
   evidence reconciliation. Never generate a new key and auto-resubmit them.

Rollback must preserve unresolved keyed client records. An older server may ignore
Idempotency-Key and signedAt, so disable keyed client sending before server
rollback; never silently fall back to an unkeyed POST.

## Local validation

Run without installing anything (Node 22.23.2):

```
node --experimental-transform-types --loader ./tests/support/typescript-resolver.mjs tests/git-atomic-issuer.test.mjs
node --test tests/git-store.test.mjs tests/protected-receipt.test.mjs
```

Six atomic issuer/route tests cover original issuance security plus lost response,
concurrent first and repeated requests, restart/status recovery, changed payload
and timestamp, unauthorized/cross-principal status, revocation, unverified replay,
invalid key/time and unavailable Git. Routes are invoked with synthetic Express
request/response adapters and the actual GitStorage fixture; service proof/custody
and schema parsing are injected synthetic dependencies, not a real approved key.
The existing real entitlement tests and full Express runtime still require the
repository dependencies. Their execution is not claimed by these fixture tests.

Recorded results for this source correction:

- Atomic issuer/route fixtures: 6 passed, 0 failed.
- Protected receipt fixtures: 5 passed, 0 failed.
- Initial broader git-store execution failed 1 of 21 tests in the migration
  CLI subprocess with empty stdout while OCI disk exhaustion was being remediated.
  Independent later repeats of the original unmodified baseline and this changed
  worktree each passed 21/21 tests. The transient failure did not reproduce after
  freeing only disposable dependency/cache files; its exact mechanism is not proven.
  The full dependency-based CI suite is still unverified.
- JavaScript syntax, built-in TypeScript parse/transform, and git diff whitespace
  checks pass. Full TypeScript typecheck, dependency-based entitlement tests and
  full Express integration were not run because dependencies are absent.

Independent isolated review (2026-11-11): Node 22 TS-loader atomic issuer/HTTP route tests 6/6 PASS; protected-receipt tests 5/5 PASS; legacy Git-store tests 21/21 PASS on modified branch and 21/21 on unmodified baseline. Source JS syntax and git whitespace checks PASS. OCI installed source is NOT changed; no production acceptance claimed.
