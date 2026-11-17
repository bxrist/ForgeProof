# Isolated cold-start recovery candidate — UNATTESTED

Owner's authoritative instruction (verbatim):

> One of the things that we actually must implement and verify is that both DevBot and BuildBot are using ForgeProof for code attestations for that project, for all projects that we code and develop. If a project where attestations do not exist for that project, it must be set up for that project. All code written and all code checked in, all code deployed must use ForgeProof. Make ForgeProof a rule for both DevBot and BuildBot. Draw me a plan and roadmap to show how this will be implemented in DevBot and BuildBot.

Newest owner direction (verbatim):

> Executive your recommendations use Replit as little as possible or not at all

The implementation choices below are non-authoritative engineering proposals.
This bounded source change does not implement the cross-project bot policy or
change the existing 0/2 full mandatory active-project acceptances. The source
is UNATTESTED, uncommitted and undeployed. No production evidence or credentials
were accessed to implement or test it.

## Implemented recovery

`FORGEPROOF_GIT_INIT_RECOVERY=true` explicitly enables recovery around the initial
GitHub state service's read-only `replay()`. Omitted or `false` retains one attempt;
other values fail configuration. There are at most three sequential attempts,
with 500 ms then 1000 ms backoff. A retry is admitted only if elapsed time including
its backoff is below 60 seconds. This is **not an overall replay deadline**: a full
large chain can take longer. Attempts are awaited to completion, avoiding orphan
replays that could advance checkpoints after a timeout. Existing immutable-read
retries remain bounded separately; at most nine upstream attempts for one
immutable object across three initialization attempts, absent earlier success.

Only the native `GitReadUnavailableError` produced by explicit Git read HTTP
502/503/504 responses qualifies. The underlying transport still consumes valid
JSON before classification. Malformed responses, auth and installation checks,
unknown network/connector exceptions, deadlines, rate limiting, checkpoint
retention errors, signature and integrity failures remain hard failures. Auth
preflight 503 responses in the App adapter remain hard failures: that adapter
deliberately sanitizes them as authorization/configuration errors. This
conservative boundary can leave a recoverable outage unavailable.

Git GET request and body consumption (including ref reads) have a 30-second
deadline. Ref reads are not retried inside the transport. Writes gain no retries.
Recovery never wraps append, route installation, custody operations or storage
installation and never selects Postgres or another transport on failure. The
existing startup barrier keeps application readiness at 503 throughout attempts
and terminal failure; root liveness remains the existing startup exception.

`[git-init]` records use the existing boot correlation ID, fixed operation and
category labels, attempt number, elapsed milliseconds and outcome. No exception
text, project/actor/repository IDs, hashes, bodies or credential values are emitted.
Existing transport timing records use the same boot ID.

## Snapshot acceleration deliberately blocked

There is no snapshot reader, writer, signature issuance, ref publication or
cold-restart fast path in this candidate. `FORGEPROOF_GIT_SNAPSHOT_REF` (even empty)
and any `FORGEPROOF_GIT_SNAPSHOT_MODE` other than `disabled` cause settings to fail.
The direct App adapter continues to deny snapshot GET, POST and PATCH ref paths
before token minting. Its event/vault allowlist and installation guard are intact.
No snapshot namespace is authorized prematurely. Existing unrelated Git refs are
not probed; this is not a claim to validate a present snapshot.

Enabling the requested signed snapshot protocol safely needs additional design:

1. Define an exact canonical signed envelope with domain separation, original
   event keyId/actor binding, tenant, logical stream **and physical GitHub
   repository** binding, trust-root/checkpoint binding, event tip commit/hash/
   sequence, complete validated state and canonical SHA256 digest.
2. Define durable independent snapshot anti-rollback and minimum-mode retention.
   The current runtime checkpoint is process-local (retention defaults to a
   no-op); the configured pin may be an older prefix. A valid old snapshot and
   rewritten event branch can remain consistent with that old pin. Ref deletion
   also makes 'missing allows full replay' incompatible with detecting snapshot
   downgrade unless adoption is independently retained. Signing alone does not
   solve either problem. Do not manufacture an anchor or weaken the event pin.
3. Resolve state completeness: replay uses `state.events` for sequence checks,
   request deduplication and append acknowledgments, alongside records, versions
   and receiptHead. Specify and validate all prefix-dependent state, including
   every deduplication entry and receipt invariant, before replacing event replay.
   A signed arbitrary state digest does not prove equality to the event prefix.
4. Permit creation only inside a successful **full** replay path. Caller-supplied
   materialized state and a warm replay result must not qualify. Verify snapshot
   signature, digest, scope, trust and prefix evidence before hydrating any state.
   Walk the current event branch to the authenticated snapshot tip and verify
   every signed incremental event, rejecting nonlinear ancestry or ref rewrite.
5. Define snapshot parentage and concurrent publication. GitHub's non-forced ref
   PATCH is a fast-forward condition, not an expected-old-SHA equality API.
   Do not assume the existing `compareAndSwap` method's name supplies a strict
   CAS guarantee for arbitrary snapshot ancestry. Specify exact acceptable
   concurrency behavior and readback before authorizing explicit snapshot refs.
6. Add offline synthetic signer/Git tests for accelerated cold restart, bad
   signature, project/key/actor mismatch, stale snapshot, missing checkpoint,
   corrupt state, prefix mismatch, event and snapshot ref rollback/deletion,
   concurrent publication and valid incremental replay. Every present invalid
   snapshot must fail closed. These snapshot tests are **not implemented or
   claimed passing** in this bounded recovery slice.

Existing events remain immutable and Git remains the sole authoritative
application state. Cold restart still validates the full signed history; a
checkpoint alone never skips its prefix. Existing warm verified-head acceleration
is retained. The synthetic regression checks include this cold-read count,
scope/signer/checkpoint rejection, corruption and ref rewinds.

## Proposed rollout roadmap (not acceptance)

First review and attest this source through the authorized ForgeProof path.
Resolve the snapshot blockers and review the protocol before any opt-in fast path.
Separately provision authorized signer custody and a dedicated project GitHub App
identity on OCI through the owner-authorized process. Neither currently exists
there; this source session cannot substitute a personal token or copy Replit
secrets. Explicit `github-app` selection then avoids the Replit connector with
no transport fallback. Exercise cold startup, readiness and recovery in an
authorized isolated runtime before considering deployment.

For each active project, inventory enrollment and trust anchors; enroll any
missing project through ForgeProof. Gate DevBot source completion/check-in on
verified source attestations tied to the exact project and source digest. Gate
BuildBot artifact production and deployment on verified source plus build/artifact
attestations, preserving signer identity and digest linkage. Fail unavailable
verification closed. Measure each project's complete mandatory acceptance using
authentic signed evidence before reporting policy enforcement. Work on those
bot gates and production acceptance is outside this isolated ForgeProof slice.

## Local verification, 2026-11-17

- PASS: 181 Vitest tests across `git-initialization-recovery`, `git-app-request`,
  `startup-diagnostics`, `startup-barrier`, `git-transport-timing`,
  `git-ref-deadline`, `git-rate-limit`, `git-production-connector`,
  `git-connector-retry`, and `git-availability-error`.
- PASS: six offline synthetic signer/Git tests via
  `node tests/git-github-store.test.mjs`; no skipped tests.
- PASS: `npm run check` and `git diff --check`.
- PASS: client and server production build via
  `node --import tsx script/build.ts`. Existing PostCSS and bundle-size warnings
  remain. The normal `npm run build` wrapper was attempted and failed because
  its tsx CLI tries to create an IPC socket forbidden by this sandbox; the
  import-loader invocation executes the same build script without that socket.

The expanded checks initially caught the old test expectation that ref reads
could exceed the deadline; that test now requires abort at the deadline. The
rate-limit middleware test now directly consumes the actual transport exception
without binding a socket. These repairs preserve the asserted security behavior;
they do not skip failures. No live runtime, production signer, GitHub service
identity or project acceptance was tested.
