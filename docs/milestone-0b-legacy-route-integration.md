# Milestone 0B: bounded legacy route integration

Base: `6efe4baa4b691413795cc09816aae5ed90bdd8b0`.

`server/repositoryRoutes.ts` now contains the original GET `/api/repositories`
and DELETE `/api/repositories/:id` handlers. The normal `registerRoutes(server,
app)` registers these at their original positions, with the singleton
DatabaseStorage, original limiter and Passport `isAuthenticated` middleware.
Handler bodies are unchanged. The default registrar's remaining source bytes
are checked against the base SHA after reversing this extraction. Separate
baseline hashes protect index/startup, sessions/OIDC, storage, Stripe, webhook
and email sources. These are source preservation checks, not live commerce tests.

For an explicit staging integration, `registerRoutes(server, app, options)`
terminates registration after the bounded handlers. Because routes.ts still
imports the legacy SQL-dependent modules, a database-free harness must instead
import `createStagingRepositoryApp` from `server/stagingRepositoryRoutes.ts`.
Both paths call the same staging registrar and the same extracted real handlers.
Use a fresh Express app. There is no executable staging listener or automatic
selection in server/index.ts: it continues to boot the original application.
No package scripts were changed.

The options are `{ storage: IStorage, principals: Record<string, string> }`, with
pinned Ed25519 PUBLIC keys. Both `NODE_ENV=staging` and
`FORGEPROOF_STORAGE=legacy-route-staging` are required. Production, development,
test, missing selection, missing methods, empty principals and invalid key types
fail before route registration. No request can select a store or add a principal.
The test fixture supplies every IStorage method, implements the four exercised
operations in memory and fails with the precise method name on any unexpected
call. It does not claim to implement unused commercial semantics.

Staging signatures bind the domain `forgeproof-legacy-route-staging-v1`,
principal, HTTP method, original URL, timestamp, nonce and SHA-256 of raw body
bytes as a JSON array, signed with Ed25519. Timestamp skew is limited to 60
seconds. Nonces are consumed once per principal, with bounded process-local
replay storage. The test keys are generated in memory and discarded. This is
an independent staging authentication protocol, not a Passport bypass or a
production session migration. Multi-process durable replay protection is not
provided; this harness must stay isolated from deployment.

Exact exercised legacy operations:

| Route | IStorage methods | Authorization |
| --- | --- | --- |
| GET /api/repositories | getRepositories(principal) | verified pinned principal |
| DELETE /api/repositories/:id | getRepository(id), deleteRepository(id), createAuditLog(log) | verified principal plus existing owner check |

Malformed IDs return 400, absent repositories 404, other owners 403, successful
deletes preserve the original audit fields and response. Creation, sync,
attestation, signup, OAuth, subscription and Stripe webhook routes are absent
from staging and return 404. No provider is imported by the harness. Normal
Passport and session CSRF middleware remains unchanged in the full application.

## Diagnostics and remaining incompatibilities

`validateLegacyStorage` reports every missing callable method in interface order,
for example `Missing legacy IStorage methods: createAuditLog,
resetAttestationCount`. Its 46-method contract is checked against IStorage by a
test. Callable shape is explicitly NOT proof of semantic completeness.
GitStorage has all 46 methods; no missing method names can honestly be reported
for that adapter. Nevertheless it is not selected by this harness or production:

- `clearAllAttestations` always rejects immutable-history deletion.
- `incrementAttestationCount` rejects separate quota updates; it requires atomic
  `createAttestationAndCount`, unlike the legacy SQL receipt transaction.
- `resetAttestationCount` rejects legacy resets without reviewed billing-period
  reconciliation. `updateSubscription` also rejects usage/ownership changes and
  unsafe billing periods; the legacy Stripe path has not been adapted.
- `getUser`/`updateUser`, API-key methods and OIDC session methods need independently
  configured credential custody. Git session methods do not replace the current
  PostgreSQL Passport session store or implement provider refresh integration.
- `createAuditLog` needs private audit encryption; receipt issuance/annotations
  need protected receipt integration; private email requires encryption and a
  durable queue. Shape checks cannot establish those capabilities.
- Full route helpers still use singleton storage and direct SQL advisory locks
  and receipt transactions. MCP, Stripe, auth storage and startup seeding remain
  separate SQL consumers. Injecting a store into every commercial route is not
  implemented or authorized by this bounded seam.

A Git-backed delete plus audit is not proven atomic through this legacy handler;
only the synthetic fixture is used here. No GitStorage or commercial migration
readiness claim follows from these tests. Production remains disabled for this
experimental option.

## Validation

The new tests drive the real Express request/response middleware stack in process
using IncomingMessage/ServerResponse and a memory Duplex transport. They cover
list/delete response parity, ownership denial before mutation, audit parity,
unsigned/tampered/stale/unpinned/replayed requests, request-body binding,
principal configuration mutation, fail-closed configuration, missing-method
names and baseline source preservation. This is not socket-level acceptance:
the managed sandbox denies loopback listeners with EPERM.

No production SQL, Stripe, Replit, secrets, real records or credential exports
were accessed. No commits, pushes or deployment were performed. No ForgeProof
API attestation was made: no credential was accessed and no ForgeProof MCP tool
is available. There are no receipt IDs for these changes.

Recorded checks in this managed workspace:

- `node --import tsx tests/legacy-route-integration.test.mjs`: 5 tests passed,
  none failed or skipped (individual test reporting).
- Focused test-runner regression across integration, security hardening, chain
  integrity and dependency compatibility: all 4 test files passed.
- `npx tsc --incremental false`: passed. The unmodified `npm run check` cannot
  write its incremental cache into the read-only linked node_modules directory.
- Full `node --import tsx --test tests/*.test.mjs`: 29 test files passed,
  6 failed (35 files total). The failed files are git-custody-billing,
  git-private-mail, git-storage-bridge, git-store, http-security and spa-fallback.
  Direct diagnostics include denied Git subprocess operations and loopback
  listeners (EPERM), and an existing Git CLI fixture's empty JSON output.
  This is a failing full-suite result, not a 205/205 acceptance claim.
- `npm run build`: blocked by tsx's IPC listener (EPERM). Direct invocation
  `node --import tsx script/build.ts` progressed to Vite and failed writing
  node_modules/.vite-temp (EROFS). No build success is claimed.
- `git diff --check`: passed.

The environment's security controls were not changed or bypassed. Socket-level
regression and a complete build still require a workspace permitting the existing
local test/build operations. This source step does not finish production
migration or milestone-wide operational acceptance.

A sequential direct execution of all 35 test files provided individual diagnostics:
**210 tests total, 198 passed, 12 failed, 0 cancelled, 0 skipped**. Eight
failures were loopback listener EPERM, two were Git subprocess EPERM, one was
Git CLI fixture JSON parsing and one was the bridge listener EPERM (nine listener
failures in total). The preexisting 205-test count plus five new tests accounts
for the 210 total. No failing test was skipped or edited.

## Independent source acceptance — 2026-11-08

After Codex exited its restricted sandbox, an independent OCI invocation on the exact development worktree passed `node --import tsx --test tests/*.test.mjs` **210/210 tests**, `npm run check` PASS, `npm run build` PASS, and `git diff --check` PASS. These resolve Codex-sandbox EPERM/EROFS test limitations but prove synthetic source health only. The staging route path is deliberately disabled under production NODE_ENV, and the normal Passport, SQL, signup, Stripe and email services are unchanged. This contribution must not be deployed as a replacement for the commercial app without real service-level parity and explicit Darwin acceptance.
