# Milestone 0B phase 2: executable isolated Git application slice

This continues local baseline `31905e27715873fb8bf7d11ddc0e723996147836`.
It is **not production cutover or milestone GO**. The legacy application still
uses PostgreSQL by default. No production service, remote Git repository, provider,
LifeOS source or account was changed or queried. Source/event signatures attest
integrity and the configured signing identity; they do not prove AI authorship.

## Executable application path

`server/git-store/storage.ts` implements the existing `IStorage` contract, with
explicitly unsupported credential and immutable-history operations. It imports
that contract as a type, so importing the bridge never initializes `server/db.ts`.
The adapter reconstructs and validates Git state on every read and mutation.
Its mandatory independent member allowlist limits all rows to one tenant.
As with legacy IStorage, this is an internal tenant interface; endpoint callers
must also authorize the acting user and organization role. It is not safe to
expose arbitrary IStorage calls as RPC methods.

Relations, organization memberships, receipt parents, repository ownership,
unique emails/slugs/provider IDs, per-user GitHub repository IDs and membership
pairs are validated before publication and again on reads. Deleted IDs remain
reserved through version tombstones. Every mutation also touches the configured
existing tenant guard user, so independent writers cannot race across different
records to violate an index or allocate the same ID. Version conflicts cause a
bounded rebuild/retry, never overwrite. An immutable audit record records each
accepted command. Every mutation of one bridge instance is limited to its tenant;
shared-tenant reads retain the internal IStorage semantics.

Receipt creation plus quota increment is one event, with a stable caller request
key via `createAttestationAndCount`. Invalid receipts and over-quota requests
publish neither change. Reusing a key with a different payload fails; retry returns
the original result. Standalone counter increment/reset deliberately fail to avoid
legacy double counting. Billing reconciliation takes an already authenticated
provider event ID, preserves usage on cancellation and provider identities, rejects
usage/owner replacement and older periods, and resets usage only when an explicit
period start advances. Same-period events do not reset usage. This is not a
provider webhook integration: ordering within a period and commercial mapping
still require a reviewed inbox/provider reconciliation protocol before cutover.

API-key CRUD/lookup, GitHub credentials, receipt annotations and deletion of
immutable history fail explicitly. No secret verifier, token or fake payment
implementation is stored in Git. Audit metadata and receipt metadata/details
requiring custody are rejected. Legacy `createAttestation` already charges quota
in this adapter, so legacy routes must not be wired to it without changing their
separate increment calls.

Use the separate entrypoint, not `npm run dev`:

```sh
FORGEPROOF_GIT_CONFIG=/private/config.json npm run dev:git-isolated
```

It binds loopback (port 5001 by default). `DATABASE_URL` is unnecessary. The config
file must have no group/other permissions; its shape is:

```json
{
  "directory": "/private/tenant.git",
  "tenant": "tenant-a",
  "repository": "app",
  "checkpoint": {"commit":"<40 hex>","eventHash":"<64 hex>","sequence":1},
  "trust": {
    "eventKeys": {"event-key":{"actor":"local-writer","publicKey":"<Ed25519 PEM>"}},
    "receiptKeys":["<independently pinned historical key>"],
    "receiptPredecessor":null
  },
  "members":["alice"],
  "guardUserId":"alice",
  "requestKeys":{"alice":"<independently authorized Ed25519 PEM>"},
  "signerModule":"/private/signer.mjs"
}
```

The separate bare tenant directory must have no group/other permissions and must
be outside the source tree. Bootstrap the reviewed tenant users with the existing
migration service, independently pin the resulting checkpoint, then boot the API.
Unlike the low-level bootstrap CLI, the isolated app rejects null checkpoints.
Missing trust, signer mismatch, unauthorized principals, unsafe permissions and
production mode fail startup. The signer module exports the existing external
signer interface; its credentials are never copied into the store. A startup
challenge verifies the signer against its configured pin without appending data.
Checkpoints returned by `/api/verify` still need independent durable retention.

This is real pinned-key request authentication for isolated machine clients,
not Replit/OIDC session impersonation. Every request supplies
`x-forgeproof-user`, `x-forgeproof-time` (epoch milliseconds),
`x-forgeproof-request` (stable nonsecret request ID), and
`x-forgeproof-signature` (canonical base64 Ed25519 signature). Sign UTF-8
`JSON.stringify(["forgeproof-isolated-v1",tenant,repository,user,method,originalUrl,time,requestId,sha256HexOfExactBody])`.
The clock window is 60 seconds; renewed signatures can retry the same command ID.
State-changing retries are deduplicated durably in Git. Read requests have no
side effects. Supported endpoints are GET/POST `/api/repositories`, GET
`/api/subscription`, GET `/api/verify`. Repository ownership comes from the
verified principal; conflicting body user IDs are denied. Unknown paths,
including payment/auth/webhook paths, return 404 after authentication. No browser
sessions, tokens, provider calls or billing bypasses are supplied.

## Historical global receipt chain

`archive.mjs` and `archive-cli.mjs` implement the complete restrictive archive
option. Original JSON text, IDs, signatures and original receipt key pins are
preserved. All receipts stay in global chain order in a dedicated, physically
restricted bare archive. Tenant views never partition the predecessor chain.
The manifest is `{version:1,total:N,memberships:[{id,tenant,userId},...]}`. Its
canonical SHA-256 digest is pinned independently after reviewing unsigned legacy
ownership/provenance; a receipt signature alone does not authenticate tenant IDs.
A reviewed export is `{version:1,manifest,receipts:[{id,original},...]}`.

```sh
node server/git-store/archive-cli.mjs migrate /private/archive.git /private/archive-trust.json /private/checkpoint-out.json /private/reviewed-archive.json PINNED_MANIFEST_SHA256 /private/signer.mjs
node server/git-store/archive-cli.mjs read-tenant /private/archive.git /private/pinned-archive-trust.json /private/tenant-view.json /private/manifest.json PINNED_MANIFEST_SHA256 tenant-a
```

Migration preflights the entire original chain before any publication. Individual
receipt events are resumable, so an interrupted import is not exposed as complete:
reads require exact manifest totals and memberships. Unknown receipt versions,
invalid signatures, wrong parents, duplicate IDs, modified membership maps and
missing rows fail. Every tenant view first verifies the **complete** chain and
manifest, then returns only that tenant's original records. The offline operator
must authorize the requested tenant; neither this internal helper nor raw Git is
a public authorization boundary. Never give tenant clients filesystem access to
this global archive, its raw replay, or its membership manifest. This complete
archive intentionally contains all authorized tenants' history in restricted
custody. Hosting/access-policy approval and production export review remain gates.

## Explicit read-only snapshot CLI

```sh
# Only after authorization in an isolated environment; never invoked at app startup.
node server/git-store/snapshot.mjs /private/snapshot.json --authorized-isolated-read-only
node server/git-store/cli.mjs migrate-reviewed /private/tenant.git /private/trust.json /private/checkpoint-out.json /private/reviewed-snapshot.json /private/signer.mjs
```

The first command reads only `DATABASE_URL`, opens one REPEATABLE READ READ ONLY
transaction, and selects all rows from all nine known application-owned tables.
It performs no schema changes or writes, uses a statement timeout, ends the
connection, and exclusively creates mode-0600 output only after validation.
Output has version, exact per-class totals and deterministically ordered records.
Unknown fields, duplicate IDs, unsupported versions, missing tables, raw
credentials/API verifiers, active session rows, and unstructured sensitive data
are rejected rather than omitted. Null excluded fields contain no data and are
removed explicitly. Semantic secrets in otherwise allowed text still require
human export review; this is no general DLP claim.

The current SQL schema does not store original receipt JSON bytes. Snapshot
extraction therefore defines the initial export representation from SQL column
values and retains it unchanged thereafter; it cannot recover any earlier HTTP
serialization. If original receipt bytes are separately available, use that
reviewed original archive input instead. Signatures and pinned predecessor links
are checked by migration preflight. Interleaved global receipts go through the
restrictive archive, not a filtered tenant `migrate-reviewed` input. The snapshot
CLI deliberately refuses credentials or sessions it cannot safely custody, so a
real populated export can fail until a secure custody extension is reviewed.
No production extraction was attempted. Live PostgreSQL snapshot isolation was
not exercised here; conversion, rejection and migration tests use synthetic data.

## Verification and remaining gates

Tests use disposable keys and actual temporary bare Git repositories. Coverage
includes concurrent allocation/index races, tenant/ownership denial, explicit
unsupported operations, atomic quota/idempotency, cancellation/period recovery,
interleaved receipt archive filtering, bad signatures and signed wrong parents,
missing snapshot totals/secrets/unknown fields, resumable reviewed CLI migration,
unsigned/forged API requests, private-store/checkpoint startup rejection and
restart from a pinned checkpoint in a separate DB-free process.

Direct SQL review: `routes.ts` imports the pool and has admin reset SQL;
Replit auth storage and connect-pg-simple sessions require SQL; `stripe.ts` reads
provider catalog tables; `stripeClient.ts` initializes SQL sync; webhook handlers
use that sync; seed and commit-health-check code use SQL. `index.ts` initializes
these paths. All remain unchanged and unreachable from the isolated entrypoint.
The default `DatabaseStorage` export is unchanged. This is a functional narrow
vertical slice, not full DB-free boot of the legacy UI/server.

Required before production cutover: secure credential/session reentry custody;
complete authenticated route adapter integration and per-user role review;
immutable receipt annotation design; verified billing event inbox/outbox and
provider catalog reconciliation; separately authorized complete export/custody
and archive review; real snapshot/restore reconciliation; durable independent
checkpoints across workers; deployment filesystem/scale/power-loss tests;
independent recovery and release acceptance. No GO is asserted.

The source-only API attestation instructions were not executed: the owner's
standing prohibition on external mutations and credential reuse takes precedence.
No receipt ID is claimed. No remote resources, payments or private client records
were used. A local commit will identify the reviewed changes; it is not an
AI-authorship attestation.

Local verification on 2026-11-07: `npm run check` passed;
`node --import tsx --test tests/*.test.mjs` passed **58/58** (51 baseline plus
7 new tests); `git diff --check` passed. Source imports and all listed direct SQL
consumers were reviewed. The sandbox initially denied loopback listening with
EPERM; rerunning the synthetic tests with approved host socket access passed.
The existing router Promise-like-handler deprecation warning remains. Tests did
not contact PostgreSQL, Stripe, GitHub, Replit or ForgeProof attestation services.
