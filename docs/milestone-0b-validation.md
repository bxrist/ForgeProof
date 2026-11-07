# Milestone 0B implementation validation — 2026-11-07

## macOS remote-writer compatibility follow-up

Owner-reported real private-remote validation reached a signed Genesis append,
then the Mac remote writer rejected the local bare repository configuration.
macOS `git init --bare` also records `core.ignorecase` and
`core.precomposeunicode`; Linux fixtures previously omitted both. The remote
configuration guard now permits exactly these two additional keys, with Git
boolean validation of every occurrence (including overridden duplicates).
The existing allowlist and rejection before transport remain in place.

Three deterministic Linux regressions use temporary bare Git repositories and
disposable synthetic signing keys. They verify signed replay/append and fresh
worker readback with both boolean settings true and false; reject invalid values
and overridden invalid duplicates; and reject URL rewriting, credential helpers,
SSH commands, unconditional/conditional includes, aliases, hooks paths, worktree
path traversal and Git proxy configuration before any transport invocation.

Validation: `node --import tsx --test tests/*.test.mjs` passed **78/78**, preserving
all prior 75 tests; `npm run check` and `git diff --check` passed. Runtime: Linux,
Node v22.23.2, Git 2.52.0. The final full suite used host permissions for local
Git subprocesses and loopback sockets after the sandbox terminated the initial
targeted run without individual test diagnostics. The existing router deprecation
warning remains. An initial host regression run exposed a test setup race with
bare-repository initialization; the invalid-config test now awaits initialization
before injecting invalid values, and the final full suite passed without skips.

This follow-up changes only the config guard, its tests and this note. No external
Git write, API attestation, credential insertion, production, DB, Stripe, Replit
deployment or LifeOS change occurred. No ForgeProof receipt ID is claimed. The
commit is local only: the operator must transfer the exact Git bundle, retest the
real private GitHub remote on macOS with the existing pinned SSH configuration,
and then verify upstream PR #14. Linux local transport coverage does not establish
native macOS filesystem behavior, real SSH/GitHub acceptance or production readiness.

## Original implementation validation

Scope: isolated standalone ForgeProof branch `feat/milestone-0b-git-authoritative-store-20261107`, base `7e54d7c6bacdf03d7832b55535453d66955d0d6c`. This is a reviewable nonproduction implementation, not independent Darwin acceptance. No remote push, provider POST, production extraction, production change, LifeOS change, API attestation, or reuse of signing credentials occurred. Tests use generated disposable synthetic keys only. No per-file ForgeProof receipt IDs exist for this contribution.

## Actual checks

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts` | Exit 0; 488 packages installed. Lifecycle scripts intentionally disabled. |
| `npm run check` | Exit 0; TypeScript check. The standalone `.mjs` implementation is exercised by runtime tests and syntax checks, not TypeScript's JS checking. |
| `node --check server/git-store/store.mjs` (also `schema.mjs`, `cli.mjs`) | Exit 0 for each. |
| `node --import tsx --test tests/*.test.mjs` | Final run: **51 passed, 0 failed, 0 skipped**, exit 0. Includes 16 new store tests and all 35 existing tests. |
| `git diff --check` | Exit 0. New files also checked after staging. |
| `npm audit --offline --json` | Exit 0; cached/offline report returned 0 vulnerabilities across 614 dependencies. **This is not a fresh advisory-registry audit**; no online audit POST was made. No new dependencies were added. |

Runtime was Node v22.23.2 and Git 2.52.0. The initial sandbox run denied local `listen(127.0.0.1)` used by existing HTTP/SPA tests. Its failures were not passing results. The final full suite ran with the approved sandbox override permitting local test sockets, and all tests passed. Earlier implementation/test failures were corrected before the final run; no failing tests were skipped. The existing Vite fixture emitted a Promise-like handler deprecation warning, with no test failures.

## Evidence exercised

- Genuine temporary bare Git stores, signed events, exact canonical JSON, CAS ref publication, complete verified replay and independent read models.
- A two-writer barrier forces both writers to construct candidates from the same tip, with CAS loss/replay preserving both nonconflicting writes. Concurrent updates cannot silently overwrite; same-key concurrent requests produce one event.
- Atomic transaction failure, record tombstones, stable retry conflicts, observed checkpoint monotonicity and crash-before-publication/restart behavior.
- Synthetic legacy receipt IDs 42 and 104, exact original JSON text including whitespace, signedAt distinct from createdAt, original Ed25519 signatures/hash links, trusted key pins, and no re-signing of receipt content.
- Reject mutated receipt/event fields, invalid signatures, ambiguous legacy signature fields, noncanonical signature encodings, wrong receipt ancestry, unknown signers, unknown schema/secret fields, altered trees, detached/missing ancestry, legacy grafts, rollback, deleted refs, divergent signed history and cross-tenant ref substitution.
- Symbolic-ref redirection and dangling symbolic refs cannot redirect append publication into another stream.
- Clone a store, delete its original directory, independently verify and reconstruct every supported application class, exact original receipts, original IDs, and subscription plan/quota/usage state without PostgreSQL. Execute the verifier CLI in a separate process with only PATH supplied.
- Migration preflight rejects invalid later records without partial publication; valid imports preserve bytes/IDs and stable keys allow exact rerun/resumption.

## Acceptance still required

The [architecture and migration contract](milestone-0b-git-store.md) describes the remaining IStorage/auth/Stripe integration, secure custodian, cross-tenant global historical chain proof/migration, independently protected checkpoint distribution, scale/physical durability/restore tests, actual release consumption by LifeOS, and Darwin acceptance. The service refuses production mode; SQL remains production authority. Clone-only recovery covers the nonsecret application read model, not credentials, live sessions, payment instruments or an executable production app with no DB. Logical refs do not enforce tenant filesystem ACLs. The public GitHub issue #2 could not be retrieved; no claim is made that its unseen requirements were independently reconciled.
