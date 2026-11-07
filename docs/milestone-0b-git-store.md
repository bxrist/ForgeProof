# Milestone 0B: experimental Git authoritative application state

Phase 3 adds private remote coordination and a tested backup/recovery runbook; see
[phase 3 implementation and remaining deployment gates](milestone-0b-phase3.md).
The original local-only service below remains unchanged.

This contribution supplies a working, explicitly nonproduction service, migration/replay commands, and offline verification. It is **not milestone GO or a live cutover**. Phase 2 now adds a typed IStorage bridge, authenticated DB-free isolated API, restrictive historical archive and explicit snapshot CLI; see [phase 2 implementation and limits](milestone-0b-phase2.md). The limitations below describe the original low-level baseline unless superseded there. `server/storage.ts` still exports `DatabaseStorage`; routes, Replit authentication, Stripe synchronization and PostgreSQL sessions are unchanged. The new constructor refuses `NODE_ENV=production`. No production records, dedicated signing credentials, remote stores, accounts or subscriptions were accessed or created. No per-file ForgeProof API attestations were made, in accordance with the owner's prohibition on network mutations/credential reuse. Issue #2 could not be retrieved from this environment; independent acceptance must reconcile that contract.

## Architecture and trust

`server/git-store/store.mjs` exports `GitAppStateService`, a named application state API with `append(transaction)`, `replay()`, `get(class,id)` and `list(class)`. It is functional without importing the app, ORM, DB, credentials or third-party packages. TypeScript consumers have `store.d.mts`. A Git CLI supporting `core.fsync` and `reference` synchronization (Git 2.36+), Node 20+, and a local durable filesystem with working atomic ref locks/fsync are prerequisites. Objects and references request fsync; power-loss/storage-controller behavior still requires deployment testing. No replication or remote acknowledgment is implied.

Use a **separate private bare repository**, never the public source repository. Each logical tenant/repository stream lives at `refs/heads/forgeproof/<tenant>/<repository>`. The service accepts only a bare store and constrained scope identifiers. Each commit contains exactly one `event.json` blob and at most one parent, pointing to the preceding event. It uses Git plumbing (no checkout/index, hooks, shell, remote operations or new data service). Event bodies contain version, scope, sequence, prior SHA-256 event hash, configured actor and key ID, stable idempotency key, request hash, and an atomic operation array. Sorted-key, integer-only canonical JSON and Ed25519 signatures cover the **entire body**, including historical receipt text. Git commit author fields identify the event service, not a human or model.

The caller must provide trusted public event keys bound to explicit actors, original receipt public-key pins, a historical predecessor anchor (normally null), and an explicit trusted checkpoint `{commit,eventHash,sequence}`. Trust configuration contains no signing keys. A null checkpoint is **bootstrap only**; it cannot detect a correctly signed truncated/replaced history on first use. Do not repeatedly bootstrap an established store. Successful reads advance an in-memory checkpoint, but this is not durable anti-rollback protection. Retain returned checkpoints in an independently protected release/backup trust manifest and carry the most recent acknowledged checkpoint into every restart/recovery. The manifest can be in a separately controlled Git repository; verification trust cannot come solely from the untrusted clone being verified. No extra non-Git application database or index is authoritative.

Every read traverses and verifies all history, actual commit parents, exact tree shape, canonical encoding, event signatures, scope, sequence/hash links, operation versions, original receipt signatures and receipt predecessor links. Symbolic stream refs are rejected when resolved, and publication uses `--no-deref` so even dangling symbolic refs cannot redirect writes. Git replace objects are disabled; checking raw commit parents also prevents legacy grafts from hiding ancestry. A missing checkpoint, missing objects, merge, scope substitution, malformed event, unknown signer or invalid receipt fails closed. A trusted checkpoint proves continuity through that checkpoint, not completeness of an unknown later suffix. Restoring an old but valid checkpoint cannot detect later lost acknowledgments. Protect and replicate checkpoints with the same care as backups.

Refs are **logical isolation, not Git ACLs**. Anyone able to read a bare repository can read all its objects (including deleted state). Deploy physically separate private repositories and access controls for mutually untrusted tenants. A service caller must authorize the supplied tenant and repository; this internal API is not an authentication boundary or a public HTTP endpoint. Do not expose the filesystem or accept caller-selected paths from an untrusted request.

## Data and transaction contract

Version 1 schemas in `schema.mjs` cover all current application-owned classes. IDs are original numeric SQL IDs except opaque string user/session-descriptor IDs. Explicit IDs avoid resetting SQL sequences during import; future allocation must occur in the same CAS transaction, using verified read state. Relationships/uniqueness/business authorization remain the caller's responsibility pending an IStorage adapter. The service validates shapes/types, not the complete relational application contract.

| Class | Git-owned state | Excluded/custodied state |
| --- | --- | --- |
| users | profile/preferences, provider customer ID, opaque credential reference | GitHub/OIDC tokens, passwords, refresh credentials |
| repositories | repo identity, ownership, branch, sync timestamps | provider authorization |
| organizations / orgMembers | organization profile, ownership, role records | external identity credentials |
| receipts | immutable original JSON text, original ID, signed timestamp, public key, signature/hash and links | signing private keys; unreviewed metadata/audit details |
| apiKeys | name, permissions, active/expiry/use state, opaque credential reference | key material, prefixes, key hashes/verifiers |
| subscriptions | existing provider IDs, plan/status, periods, quota limits/counts | payment instruments, client secrets, webhook payloads/secrets |
| auditLogs | immutable action/resource/time/IP fields, opaque details reference | arbitrary metadata/content |
| sessions | opaque descriptor ID, user, expiry, custodian reference | session IDs/tokens, serialized session contents |

A session descriptor ID must be newly assigned nonsecret identity, **never the actual SQL `sid`**. `custodian:<opaque-id>` references contain no secret. A separate secure custodian/provider retains credentials and sensitive content; disaster recovery deliberately requires reauthentication or secure provider recovery for these. Git alone reconstructs nonsecret app state, not live authenticated sessions or credentials. Never place secrets in permitted text fields either: field allowlists are not a semantic DLP system. Private profile/tenant data belongs only in private stores. Arbitrary JSON metadata and raw audit details fail closed instead of being silently copied/redacted. A future reviewed encrypted/secure-custody export extension is needed for such historical records. Version 1 never re-signs or edits historical receipt bytes.

An operation is `{kind,id,action:'put',expectedVersion,record}` or `{kind,id,action:'delete',expectedVersion}`. `expectedVersion` is null only for never-seen IDs, otherwise the sequence of the last event changing the record. Deletion keeps a version tombstone. Full replacement is explicit; no implicit merge. Receipts and audit logs cannot be updated/deleted. A failed operation publishes no transaction. Transactions are capped at 1,000 operations and 8 MiB per event; record text fields are capped at 64 KiB. The version-1 canonical format rejects fractional numbers, undefined and unsupported objects.

`append({idempotencyKey,operations})` verifies the current tip, signs/writes an event, then publishes via `git update-ref REF NEW OLD`. Independent writers cannot replace an unexpected tip. A loser replays and retries up to eight times; stale record versions reject instead of overwriting a competitor. Stable-key retry returns the original event; a changed actor or payload under the same key conflicts. Local I/O/lock failures can surface to the caller; retry the unchanged request/key. A crash before CAS leaves unreachable objects, not visible state. A crash after CAS but before acknowledgment can leave a committed event: retry with the same key to discover it. Idempotency keys are scope-local and must be retained indefinitely; do not put secret request tokens in them.

The legacy v1 receipt hash is SHA-256 of `fileHash|modelName|modelProvider|countryOfOrigin|prevEntryHash-or-genesis|timestamp`. Its Ed25519 payload is `entryHash|fileHash|timestamp`, with unprefixed base64 signature/public key. `signedAt` is authoritative when present; only absent/null `signedAt` allows ISO-normalized `createdAt` fallback. ID, path, user and metadata are **not** authenticated by the historical signature. Their original export provenance must be independently reviewed; the new event authenticates their imported representation from migration onward. Self-reported receipt keys are never automatically trusted. Signature base64 must be canonical. Legacy signed fields containing a pipe separator are rejected because the historical encoding is ambiguous; they require separate review rather than an attribution claim.

## Local offline operation

These commands operate only on local paths. Provision the **private** store and signer independently; no key generation, provider calls, Git transport or credential discovery is built into the service:

```sh
git init --bare /private/forgeproof/tenant.git
node server/git-store/cli.mjs migrate /private/forgeproof/tenant.git /secure/trust.json /secure/migration-result.json /secure/reviewed-export.json /secure/signer.mjs
node server/git-store/cli.mjs verify /private/forgeproof/tenant.git /secure/pinned-trust.json /secure/verification.json
node server/git-store/cli.mjs restore /private/forgeproof/tenant.git /secure/pinned-trust.json /secure/reconstructed.json
```

All output files are exclusive-create, mode 0600. Use new output names on retries. The signer is an explicitly supplied, trusted local module exporting `{signer:{actor,keyId,sign:async(bytes)=>base64Signature}}`; it should delegate to the secure custodian. Never copy signing key material into source or the private Git store. Tests generate only disposable synthetic signing keys under temporary directories.

The public trust configuration shape is:

```json
{
  "tenant": "tenant-a",
  "repository": "repo-a",
  "checkpoint": null,
  "trust": {
    "eventKeys": { "migration-key": { "actor": "authorized-migrator", "publicKey": "<trusted Ed25519 PEM>" } },
    "receiptKeys": ["<trusted original base64 SPKI key>"],
    "receiptPredecessor": null
  }
}
```

Replace null checkpoint with the independently retained checkpoint for established stores. `migrate` and `verify` output include `checkpoint`; `restore` additionally writes all classes, versions and receipt head, preserving original receipt JSON text. Restore is a disposable read model, not a new authority or a SQL loader. The `.mjs` verifier modules and Git suffice on a disconnected recovery host; no npm installation, app or PostgreSQL is needed. Mirror clone/bundle every tenant ref and all reachable objects using your separately authorized backup process. A default single-branch clone is insufficient for multiple streams. Keep the public trust manifest/checkpoints and verifier release available independently.

Migration input is `{version:1,transactions:[...]}`; transactions use the exact service contract. For receipts, `record` is `{id:42,original:"<exact original JSON text>"}`. Preflight verifies the complete input against existing verified state before publishing anything; each transaction then has its own atomic CAS, so a crash or competing writer can stop an import midway. Retry the same export/keys to resume. The CLI never queries SQL or loads environment secrets.

## Migration, commercial continuity, and remaining acceptance gates

1. In a separately authorized environment, freeze writes or capture a consistent transaction snapshot of **all** application tables plus the original receipt export bytes and signing-key provenance. This implementation deliberately has no production extraction command. Preserve IDs, original signed timestamps, provider customer/subscription IDs, plan/status/periods, limits, usage counts and membership/ownership associations. Do not recreate subscriptions or reset usage. Review every text value for secrets before import. Sessions/credentials go through the secure custodian, not the export.
2. The current SQL receipt chain is **global across tenants**. Per-tenant filtering alone breaks predecessor continuity. Import a complete authorized historical chain into a separately restricted archive, or produce independently reviewed predecessor anchors/proofs for contiguous chain segments. This version permits a single externally trusted initial predecessor per stream and **rejects missing/interleaved links**. It does not invent intermediate receipts, copy other tenants' data into a tenant store, or claim to solve cross-tenant disclosure. A privacy-preserving global-chain migration/proof format remains an acceptance gate.
3. Establish trust pins/checkpoint from an independent export review, then run preflight/migration. Reconcile all record counts/IDs, receipt bytes/signatures/links and commercial values. Investigate rejected unstructured records rather than dropping them. No migration is complete while any required record remains outside the approved contract.
4. Recover from a mirror onto a fresh disconnected host with the independently pinned manifest. Run `verify` and `restore`, reconcile every record with the reviewed export, test auth reentry/custodian availability and billing event replay without provider side effects. The synthetic suite covers clone-only recovery, not a production export/restore or power-loss certification.
5. Build the IStorage compatibility/query adapter and auth/Stripe migration with explicit uniqueness/foreign-key semantics, transaction boundaries, event inbox/outbox and stable provider-event idempotency; integrate the secure custodian, external identity and billing catalog caches. Existing `server/stripe.ts` queries provider-sync SQL tables directly; Replit auth accesses SQL outside IStorage. This version does **not** replace those paths or claim an executable DB-free production app. Do not enable dual writes as authoritative without a recovery protocol.
6. Independently test scale (replay currently reads full history per operation; correctness prioritized over throughput), concurrent processes, checkpoint advancement across workers, tenant ACLs, fsync/power loss, backup retention, key rotation/revocation policy, retention/legal deletion, restore and commercial continuity. Historical public event keys must remain available; trust-policy changes need separate authorization. Git retains old data even after logical deletion. Do not garbage-collect trusted ancestry.
7. Publish/review a release through separately authorized tools, record the release actually consumed by LifeOS without altering LifeOS during this work, and run independent Darwin checks. Release adoption, production cutover, and milestone GO remain unaccepted. SQL remains the production compatibility implementation until those gates pass.

## Verification

Run `npm ci --ignore-scripts`, `npm run check`, `node tests/git-store.test.mjs`, and `node --import tsx --test tests/*.test.mjs`. The Git store adds no dependency. Tests use synthetic records and temporary local bare repos only; no production provider requests or credentials. The new test suite exercises real CAS contention with a barrier, lost-update conflicts, retries, atomic failures, crash/restart, historical receipt bytes/IDs/signatures, all application classes and quota recovery, tenant/ref mixups, rollback/deletion/rewrites, malformed trees and event/receipt tampering. See the work report for actual commands/outcomes; these instructions alone are not evidence of passing checks.
