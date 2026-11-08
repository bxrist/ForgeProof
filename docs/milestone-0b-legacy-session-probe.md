# Legacy session compatibility probe — production STOP

This source-only follow-up adds `LegacySessionContinuityProbe` under
`server/git-store`. It is a read-only express-session Store compatibility probe,
not a deployable transition store. The historical snapshot STOP checker is
unchanged. Milestone 0B production session migration remains incomplete.

The injected `LegacySessionReader.readActive(scope, sid)` is the only authority
interface. Its implementation must be independently trusted, scope-bound, private,
read-only, and consult current expiry/revocation on every read. It returns detached
normalized session JSON and exact SQL expiry, or null. Snapshot/session JSON claims
cannot implement authority. No real SQL reader or durable primary is supplied.
Only genuine express-session middleware may feed this probe an SID: direct Store
calls do not authenticate callers. This probe never parses, signs, decodes or
compares cookie signatures and never selects a principal. Auth remains the original
Passport middleware's responsibility. The tests preserve Passport JSON; they do
not prove actual OIDC provider validation, revocation or production Passport parity.

Scope and reader references live in a module-private WeakMap. Returned JSON is
cloned before express-session can mutate it. Invalid data and backend failures
produce fixed errors without nested causes. SQL expiry and cookie expiry must both
be valid and future; either expiry at the boundary returns null without renewal.
Missing cookies/invalid signatures are handled by express-session itself. Repeated
reads consult authority again rather than cache revoked state. The probe performs
no Git operations, hashing, HMAC, logging, network operations or backend writes.
Its trusted reader must likewise avoid logging SIDs or JSON. No raw SID, cookie,
JSON, tokens or identity claims may appear in Git history. The no-history property
here follows from having no Git writer at all, not a demonstrated encrypted durable
session backend. Synthetic fixture credentials are test data only.

## Exact STOP

Every `set`, `touch`, `destroy` and `clear` fails with
`Session continuity STOP: durable transition not implemented` and performs no read
or write. Backend/shape uncertainty fails with
`Session continuity STOP: trusted legacy read failed`.
These failures are intentional: do not install this probe in the application.
In particular, returning a successful no-op touch or destroy would falsely promise
renewal or logout. A failed destroy does not revoke a legacy session. Normal
express-session response completion invokes touch; the successful compatibility
fixture inspects state first, explicitly verifies touch STOP, then detaches the
request session before response completion. This is a synthetic inspection harness,
not a production response path. New session save also demonstrably stops.

## Required production integration contract

Before an authorized transition, independently review and supply a secure durable
primary with private scoped original-SID lookup and encrypted session JSON. Never
substitute `GitStorage.stageOidcSession`: it creates different derived IDs. Never
silently fall back to SQL writes or an in-memory store for new sessions.

The future primary needs atomic read-through publication, authoritative tombstones
that suppress legacy fallback, create-versus-update authorization, concurrency/CAS,
revocation freshness, and durable expiry. Concurrent logout must win against a
pending import, touch or stale save; retries must not duplicate publication or
resurrect expired/revoked sessions. Preserve existing auth fields through migration;
auth changes must come only from the original trusted Passport flow. Define SQL and
cookie expiry precedence and seven-day renewal precisely, including clock skew,
provider revocation, rollback, restart and retention. An injected secret is required
for any future keyed SID index; no secretless HMAC or public SID hash index is
provided here. Reader trust and durable storage must be verified rather than accepted
as production-ready because an object implements an interface.

A separately authorized integration must retain the original cookie name, signing
secret/rotation order, domain/path, secure/sameSite settings and middleware order.
Only express-session verifies the original signature. Test actual Passport behavior
and secure cookies over authorized transport before changing production middleware.
No production integration, SQL writes, migration, deployment, commercial changes,
commit or push is part of this contribution.

## Synthetic validation

`tests/legacy-session-probe.test.mjs` uses injected synthetic readers and genuine
express-session middleware with Node IncomingMessage/ServerResponse over an in-memory
Duplex transport. It needs no loopback listener. express-session itself issues the
fixture cookie; the second middleware accepts that exact unchanged cookie and
recovers the same SID and Passport JSON. Invalid signatures and wrong secrets never
reach the legacy reader. Store tests cover SQL/cookie expiry boundaries, fresh
revocation checks, scope/missing-SID isolation, detached data, redacted errors and
mutation STOP without duplicate writes. These are contract tests, not evidence that
an actual legacy backend has trusted semantics.

No production data or secrets were accessed. No ForgeProof MCP tool is configured;
API attestation would require secret access outside this task's explicit boundary.
No receipt was submitted and no receipt ID is claimed.

Validation in this restricted worktree (2026-11-08):

- Probe suite: 4/4 passed. Historical STOP suite unchanged: 5/5 passed.
- `npx tsc --incremental false`: passed. `npm run check` initially failed because
  its incremental cache path in node_modules is read-only and the first draft used
  private identifiers incompatible with the repository's default TS target. The
  final implementation uses module-private WeakMap custody and passes the check
  without cache output; no package/tsconfig change was made.
- `node --import tsx --test tests/*.test.mjs`: 26 file suites passed, 6 failed;
  the child-process runner did not expose individual diagnostics for those files.
- Importing every `.test.mjs` in one process produced full diagnostics:
  **176/188 passed, 12 failed, zero skipped**. Nine failures were loopback
  `listen EPERM` (git-storage-bridge, six http-security cases, two spa-fallback
  cases); two were `spawnSync git EPERM` in custody/billing and private-mail raw
  Git-object inspection. The remaining failure was `Unexpected end of JSON input`
  at git-store.test.mjs:210 in the migration CLI test. Its root cause was not
  established; it is not claimed as an environment-only failure. The full suite
  is not passing in this environment. Existing tests were not weakened.
- `git diff --check`: passed. Only the probe, its synthetic tests and this document
  are added. No worktree files were staged, committed or pushed.

## Independent validation after Codex sandbox — 2026-11-08 UTC

An independent, unrestricted OCI worktree runner tested this exact source after Codex exited: `node --import tsx --test tests/*.test.mjs` **188 passed, zero failed**; `npm run check` PASS; `npm run build` PASS; `git diff --check` PASS. This establishes synthetic source regression, TypeScript, and build health only. It does not validate a deployed auth provider, durable private session index, SQL source export, real cookie transition, commercial billing, or release acceptance.
