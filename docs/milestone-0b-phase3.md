# Milestone 0B phase 3: coordinated private Git transport

Phase 4 adds opt-in credential custody and a verified bounded Stripe inbox; see
[implementation, private operations and remaining limits](milestone-0b-phase4.md).

This phase adds an executable remote coordinator, `server/git-store/remote.mjs`,
not production cutover or milestone completion. SQL remains the default. No live
system, GitHub remote, provider, credential, production record or external resource
was accessed. The isolated entrypoint still selects the local service; it does
not silently enable transport. `GitStorage` now accepts the structural replay /
append interface, so an explicitly configured remote coordinator can be injected.
No new dependency, scheduler, service principal or credential service is supplied.

## Coordination and trust contract

Provision one private bare clone per worker, outside source, with exclusive OS
access. Do not share a clone between coordinator instances/processes. Calls within
one coordinator serialize. Configure a separate private evidence upstream, never
ForgeProof's public source remote. `privateStore` repeats its independently reviewed
URL and tenant/repository binding; never obtain these fields from HTTP. A declaration
is not a privacy/ACL probe: operators must establish actual repository access.
Production transport permits only explicit `ssh://user@host/path` URLs, a dedicated
existing identity-file path, and independently pinned known-hosts path. SSH uses
batch mode, strict host verification, no user SSH config and identities-only.
No key discovery, inline credentials or transport stderr is exposed. Local absolute
paths require explicit `localTestOnly: true` for synthetic fixtures. Local Git config
is allowlisted before transport to reject URL rewriting, helpers and executable
injection. Clone directories, config, SSH files and signer modules are trusted
operator inputs, never tenant-controlled filesystem content.

Construction requires a non-null externally trusted checkpoint and injected
`retainCheckpoint(pin)` callback. The callback must durably retain monotonically
advancing, ancestry-checked pins in independently protected custody before resolving;
coordinate it across workers, reject regressions/divergence and retain every
acknowledged suffix. A separately controlled existing private Git trust repository
is one possible implementation. A local clone file or a no-op callback is **not** a
production implementation. No automatic durable external checkpoint custodian is
invented here. That deployment integration remains required for autoscaling.

Every read fetches to a unique temporary ref, fully verifies signed ancestry,
scope, schemas and historical receipts against the current pin, and retains the
verified checkpoint. It never trusts a remote tracking ref or a cache. Missing or
symbolic refs, missing objects and rewritten/truncated histories fail closed.
Valid but unknown later suffix completeness cannot be proved without independent
acknowledgment pins. The remote must retain objects/refs durably; this implementation
cannot make an untrusted server physically retain data.

Each write refreshes first and searches the signed history for the stable request
key before signing. The local transaction produces an atomic candidate. Publication
uses a normal non-force push with a verified ancestor check and a mandatory
private `pre-push` hook. The hook compares Git push's own advertised remote OID
against the verified expected head (not a separate ls-remote result). Receive-pack
then atomically compares/locks that exact advertised OID. The generated temporary
hook contains fixed shell code and quoted data comparisons, never shell interpolation
or eval of caller input; all other hooks are disabled. This fences remote deletion /
rewind between fetch and push, including where ordinary unchecked fast-forward push
would recreate a deleted stream. No force option is used. Configure server-side
`receive.denyNonFastForwards=true` and `receive.denyDeletes=true` as defense in depth.
The receive-pack ref lock compares the expected old object. A competitor wins
atomically; the loser refreshes, rechecks idempotency and rebuilds against verified
history (stale record versions conflict). There are at most eight attempts.

A successful push alone is insufficient: verified readback must contain the exact
request hash and stable key, and external checkpoint retention must succeed before
returning a receipt. Every rejected/ambiguous push performs readback before retry;
failed readback returns failure, never a local-only receipt. Retry exactly the
same key/payload after any failure. Keys are nonsecret permanent scope-local IDs.
A pending local candidate survives process loss and is reused if its parent and
request still match. If another event wins first, a new event envelope may need a
new signature to bind the new parent/sequence; immutable receipt bytes/signatures
are never regenerated. Simultaneous independent workers can also sign competing
envelopes before CAS, but only one same-key event can enter verified history.
Receipt creation and the subscription count remain one atomic accepted event.
This is exactly-once publication, not a claim that a signer is invoked only once
across disconnected workers. Signing side effects must themselves be safe to retry.

## Tested bootstrap, readback, backup and recovery runbook

The commands below use existing Git primitives and the existing offline CLI.
Use operator-selected private paths, restrictive permissions and an existing
separately authorized private upstream. Do not apply these instructions to live
services during this work. Remote server admins must disable deletion/non-fast-forward
updates and configure existing private ACLs, SSH host identity and backup retention.
No new bot/principal or approval workflow is required by this design.

1. Initialize the empty **separate** private bare upstream with `git init --bare
   /private/evidence.git`, restrict directory access, then run `git --git-dir=/private/evidence.git
   config receive.denyNonFastForwards true` and `git --git-dir=/private/evidence.git
   config receive.denyDeletes true`. On that host, run the existing reviewed migration
   CLI with the external ForgeProof signer. Independently review/retain its resulting
   checkpoint and public trust keys. Null checkpoints are only for this one-time
   bootstrap, never normal remote startup. The coordinator intentionally cannot
   create a missing upstream stream. No signer keys go into Git.
2. Initialize each empty worker bare directory with `git init --bare /private/worker.git`
   and private permissions. Inject `RemoteGitAppStateService` with the pinned trust,
   scoped private URL, SSH paths, signer and real durable retention callback. Use
   `replay()` for authenticated non-force readback. Do not configure a source remote
   or enable the legacy server with this incomplete adapter. A failed readback is
   an operational failure, never permission to repin to a shorter history.
3. On an existing authorized backup host, mirror all streams with `git clone --mirror
   --no-local PRIVATE_UPSTREAM /private/mirror.git`. Use the same pinned SSH policy
   for transport. Independently verify every scoped stream using its own external
   config: `node server/git-store/cli.mjs verify /private/mirror.git /secure/trust.json
   /secure/verified-new.json`. No single-branch clone or `git fsck` substitutes for
   signed verification. For subsequent backups use new mirror directories, avoiding
   blind pruning of older acknowledged history. Keep previously verified backups.
4. Create a portable backup with `git --git-dir=/private/mirror.git bundle create
   /private/backup.bundle --all`, then `git --git-dir=/private/mirror.git bundle verify
   /private/backup.bundle`. Retain the bundle, verifier release, independent pins and
   public keys separately. A bundle is private evidence, not a public source artifact.
5. On a disconnected recovery host, `git clone --mirror /private/backup.bundle
   /private/recovered.git`, then run the offline `verify` and `restore` CLI with
   independent trust config. Reconcile every class/version, receipt original bytes,
   signatures, predecessor chain and commercial counters. Wrong pins, receipt keys,
   missing objects and incomplete backup history must stop recovery. No SQL or npm
   installation is needed for this CLI. Restore output is derived disposable state.
6. Failover must start with the latest externally retained acknowledgment checkpoint.
   If the backup cannot prove it, stop; do not reset trust to make verification pass.
   For separately authorized repair, restore the complete verified refs/objects to
   the existing private endpoint and read back with the same pins before accepting
   writes. An older pin cannot detect a lost later acknowledgment. Reauthentication /
   secure provider recovery remains necessary for credentials excluded from Git.

The synthetic suite executes initialization, server protection settings, real
multi-clone transport, mirror/bundle creation, bundle verification, deletion of the
upstream, disconnected rebuild and wrong-anchor rejection. It also verifies an
offline mirrored signed receipt and subscription count. No internet is used.

## Remaining acceptance

This is material distributed coordination code, but not certification of Replit
production failover. SSH/host-key/ACL deployment, server durability, shared external
checkpoint retention, cross-host failure tests, power-loss behavior, backup policy
and operational repair authorization still require deployment validation. Full
legacy auth/billing/UI integration, production historical export/custody and
reconciliation, billing inbox/outbox, credential/session custody interfaces,
independent release/adoption and milestone GO remain outstanding. Optional phase-3
custody and billing-inbox extensions were deferred to keep this change bounded.
No production boot or complete Git-only legacy app is claimed.

External ForgeProof API attestations were not created: the explicit prohibition
on external mutations/credential reuse remains in force. No attestation ID is
claimed. The local source commit identifies these changes only.

Validation on 2026-11-07: `npm run check` passed; `node
--import tsx --test tests/*.test.mjs` passed **68/68** on the authorized host
runner (58 prior tests plus 10 remote coordination/recovery tests);
`node tests/git-remote.test.mjs` passed **10/10**, and `git diff --check` passed.
The initial sandbox suite could not bind loopback and its subprocess CLI test
returned empty output; both passed on the host rerun. The existing router
Promise-like-handler deprecation warning remains. No external endpoint was used.
