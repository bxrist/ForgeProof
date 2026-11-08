# Milestone 0B historical session continuity — STOP

Inspected baseline: `d5547032b30021a8d12d58826c3a4aa931647077`.
This is a source-only boundary assessment, not a completed session migration.
The independently supplied aggregate observation of 12 SQL sessions, 11 active,
and 2 enabled API keys is context only. No actual session contents or owner
mappings were supplied or accessed. Those counts are not synthetic fixtures or
evidence of migration eligibility. Existing sessions must continue to work.

## Exact interface findings

- Full-state inventory and sealed capture retain normalized SQL session fields
  `sid`, `sess`, `expire` in authenticated encrypted tables. They do not establish
  the principal behind any SID. Relation verification counts sessions but cannot
  authenticate their ownership. A valid sealed source is not an auth assertion.
- `server/storage.ts` has no historical SQL-session continuity methods. The SQL
  session middleware is in `server/replit_integrations/auth/replitAuth.ts`, using
  `connect-pg-simple` and `express-session`. It is not integrated with private Git
  session recovery.
- `git-store/schema.mjs` permits session metadata `id`, `userId`, `expiresAt`,
  `custodianRef`, and optional common timestamps. It excludes SID mapping fields
  and session JSON. IDs have a restricted character set and length; arbitrary
  SQL SIDs cannot safely be copied there, and would disclose bearer material.
- `GitStorage.stageOidcSession` issues an ID derived from principal and request
  ID. It stages new material and only accepts future expiry. It has no original
  SID parameter. Calling it would issue a different session, not prove continuity.
  `recoverOidcSession` requires the Git ID and an already selected principal;
  its expiry and principal checks do not implement cookie-to-principal discovery.
  Revocation changes Git expiry and destroys custody material.
- `CredentialCustodian` supports encrypted opaque `oidc-session` material up to
  65,536 string characters, stable scoped staging requests, and recovery by an
  existing custody reference. AES-GCM authenticates scope. It has no independently
  reviewed SID lookup/index contract, authenticated provider principal resolver,
  or cookie validation interface. Its ability to hold a string does not establish
  a historical-session wire format or continuity behavior. No production durable
  vault implementation is selected automatically.
- Core, email and API-key stages establish useful source verification and private
  replay patterns; none proves historical session cookie compatibility.

## Implemented safe boundary

`assessSealedSessionContinuity` validates the sealed snapshot and existing relation
trust before inspecting sessions, rejects malformed session JSON shapes, duplicate
SIDs and invalid expiry, and reports only fixed status/reasons and aggregate counts.
Its explicit normalized UTC review instant classifies expiry at `expire <= now`;
classification never filters, refreshes, revokes or mutates a row. Original exact
expiry and normalized JSON remain solely in the existing sealed source. This does
not promise preservation of original SQL text formatting, pre-normalization numeric
precision, or sub-millisecond clock classification beyond JavaScript Date precision.

Every nonempty source returns `STOP`, zero staged sessions and no transaction or
private stage artifact. Both active and expired rows remain unstaged. Empty input
returns `EMPTY_SOURCE`; it proves only that there are no rows in that verified
snapshot. `productionGoAllowed` and `fullApplicationMigrationComplete` are always
false. Additional arguments, including caller-asserted mapping/approval objects,
are rejected; there is no mapping verification capability to invoke yet. Errors
have a fixed message and no nested source error. No source values, SID hashes,
identities, tokens, or custody keys appear in the assessment.

No custody or Git service is accepted by the assessment; it cannot accidentally
issue, overwrite, destroy, append or reauthorize anything. Repeated assessments
of the same source and instant are deterministic and side-effect free. It does
not pretend to test successful historical staging, revoked-provider handling or
session recovery: these remain blocked integration proofs.

## Required independent production integration proof

Before any session staging, an authorized auth provider must supply independently
authenticated principal bindings for every SID, bound to reviewed source, tenant,
repository, exact normalized session content and expiry, with freshness, issuer
trust, revocation and missing/duplicate/conflicting-principal rules. Session JSON
claims, even those matching existing user IDs, cannot supply that proof.

A separately reviewable contract and implementation must demonstrate original
cookie/SID validation and secure lookup before principal selection; encrypted
mapping through trusted external custody; domain separation and cross-scope denial;
lossless normalized JSON and exact expiry recovery; size/serialization handling;
atomic or safely journaled Git/custody publication; deterministic retry/conflict
behavior; and expiry, provider revocation, concurrent renewal/logout and rollback
semantics. Existing active cookies must work without rewriting or reissuing them.
Cookie signing/rotation compatibility must be proved through authorized provider
facilities without placing signing material in Git. Public Git must contain no
session data; private Git may contain only reviewed safe metadata and opaque refs.
Independent signed replay and recovery must verify those guarantees with synthetic
fixtures before any authorized production exercise. Do not create an app-owned
secret SQL store or claim success by dropping existing sessions.

## Local validation and boundaries

Synthetic tests cover empty/nonempty snapshots, active/expired/boundary expiry,
invalid JSON shapes, duplicates, untrusted/matching/missing/revoked mapping claims,
scope/key/trust/tamper denial, redacted output/errors, repeat assessment, existing
custody cross-scope denial, and independent signed local Git replay with no
historical session insertion or private session data. Temporary test Git commits
are synthetic store events only; no worktree commit is made.

Validation results: `node --import tsx tests/sealed-session-continuity.test.mjs`
passed all 5 tests; `npm run check` passed. A combined in-process Node test run
of full-state inventory/sealed, migration relations, core/email/API-key/evidence
stages, OAuth custody, custody/billing and this continuity suite passed 71 of 72
tests. The existing custody/billing test at line 112 failed with `spawnSync git
EPERM` while invoking `git cat-file --batch-all-objects --batch`; an isolated rerun
confirmed the same subprocess restriction (6 of 7 passed). That raw Git-object
inspection remains unverified here; no existing code or test was changed to bypass
it. The new signed replay tests passed. The runtime does not support
`--test-isolation=none`; tests were imported in-process to obtain full diagnostics.
`git diff --check` passed.

No production database, Replit application, Stripe, remote Git, secrets or network
is used. No main application, production paths, dependencies or package files are
changed. ForgeProof receipt submission is deliberately omitted because this task's
explicit no-network/no-secrets boundary overrides AGENTS.md API attestation steps;
there is no receipt ID to report. Milestone 0B and production integration stay open.

## Independent all-source validation — 2026-11-08 UTC

With existing dependencies available in the separate development worktree, an independent OCI invocation passed `node --import tsx --test tests/*.test.mjs` **184/184, zero failures**, `npm run check` PASS, and `npm run build` PASS. This supersedes the isolated Codex sandbox subprocess `EPERM` result as a source-suite acceptance check; it does not validate a real principal resolver or live session migration. The eleven active production sessions remain a strict deployment parity constraint.
