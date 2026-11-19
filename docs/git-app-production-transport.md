# Isolated GitHub App transport candidate — UNATTESTED

This source candidate adds an opt-in HTTP adapter to the existing GitHubTransport
and GitHubAppStateService. It has not been accepted, deployed, or attested. It does
not implement the wider DevBot/BuildBot rollout or close issue 439.

Unchanged installations use the Replit connector. Set
`FORGEPROOF_GIT_TRANSPORT=github-app` explicitly to select this adapter; `replit`
selects the original adapter. Unknown modes fail. Neither adapter falls back to
the other. No personal token or CLI identity is read.

Required explicit project configuration:

- `FORGEPROOF_GIT_APP_ID`: numeric App ID.
- `FORGEPROOF_GIT_APP_INSTALLATION_ID`: numeric installation ID.
- `FORGEPROOF_GIT_APP_REPOSITORY_ID`: numeric private evidence repository ID.
- `FORGEPROOF_GIT_GITHUB_REPOSITORY`: exact, case-sensitive owner/repository.
- `FORGEPROOF_GIT_TENANT` and `FORGEPROOF_GIT_STREAM`: explicit existing scope.
- Exactly one key source: `FORGEPROOF_GIT_APP_PRIVATE_KEY` containing the
  project-specific RSA PEM, or `FORGEPROOF_GIT_APP_KEY_CREDENTIAL` naming an
  existing systemd LoadCredential entry in `CREDENTIALS_DIRECTORY`. The latter
  accepts a simple entry name, never an arbitrary path. No credentials are
  provisioned by this change. RSA keys must be at least 2048 bits.

All existing signer, public-key pin, checkpoint, receipt trust and guard account
requirements still apply. The App PEM authenticates HTTP only; it cannot replace
the ForgeProof event signer. No signer/custody or canonical ledger code changes.

Before first data access and each refresh, the adapter checks repository-to-App
installation binding, requests only the configured repository ID and Contents
write permission, validates the token response permissions/repository/expiry,
and independently checks the installation-token repository listing and target
private repository identity. Metadata read is the only additional accepted
permission. Missing repository lists or ambiguous responses fail closed.
This follows GitHub's [installation token API](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app).

Tokens are cached in memory, capped locally at one hour from acquisition start,
and refreshed with a 60-second margin. Authentication HTTP calls are never
retried by the adapter. Data HTTP statuses retain the existing transport's read
retry, missing-ref, and CAS conflict behavior; writes are never replayed. Network,
JSON, configuration and authentication exceptions fail closed with fixed text.
Every HTTP exchange, including body consumption, has a 30-second bound. The
complete shared authentication acquisition also has one 30-second deadline,
propagated through all four exchanges. Pre-aborted requests perform no network
access. A caller cancellation immediately ends its wait; authentication is
cancelled when its last waiting caller leaves. Other overlapping callers retain
the shared mint and its successful cache entry. Cancelled callers never proceed
to Git Data access, even if an HTTP implementation completes late. The existing
transport retains its overall immutable-read deadline.

Primary rate limits (403 with zero X-RateLimit-Remaining), secondary limits (403
with Retry-After), and 429 responses preserve only numeric Retry-After and
X-RateLimit limit/remaining/reset headers. They retain a valid cached token and
establish a shared cooldown until the later of Retry-After, an exhausted primary
limit's reset, or a conservative 60-second minimum. Calls during cooldown return
a sanitized 429 without network access, including token acquisition. Rate limits
encountered during authentication fail that acquisition and establish the same
cooldown. Ordinary 401/403 authorization denials remain failures and invalidate
the cached token; the adapter never retries them or any write. Error bodies and
other headers are discarded. Only HTTPS api.github.com and fixed Git Data/auth
paths are used; redirects are rejected. No adapter logging contains credentials
or raw data.

Ref access is limited to the configured event stream and the existing tenant
vault namespace. Immutable objects remain repository-scoped, as required for Git
replay. GitHub Contents permission itself is repository-wide: this adapter's
path checks are a local guard, not a GitHub branch permission boundary. Use a
dedicated ForgeProof installation and evidence repository, never another
product's identity. Operator configuration is the trust anchor; the adapter
cannot independently prove that a supplied identity belongs to the intended OCI
host. Plain RSA PEM files have no intrinsic expiry; GitHub rejection enforces
revocation, and installation token expiry is checked locally.

Offline tests use generated synthetic App keys and mocked HTTP only. They do not
prove real App permissions, OCI identity, live connectivity, signer availability,
or production acceptance. A separately authorized observed run with the real
project signer must attest source writes/commit/build/deploy before acceptance.
No GitHub, evidence-branch, secret, deployment, or provider changes accompany
this candidate.

## Bounded repair verification — 2026-11-17

Base HEAD remains `165076cdd2e19fdd4f45b5ab3830097a45255cbe`. This repair changes
only `githubAppRequest.ts`, its offline test file and this document. The existing
`githubRuntime.ts` candidate edits and original source history are preserved.
No commit, signature, push, merge, credential provisioning or deployment occurred.

- `npm run test:server -- tests/git-app-request.test.ts`: **59 passed**. New cases
  cover pre-abort, mid-mint abort with late completion, a surviving concurrent
  caller, the shared acquisition deadline, primary/secondary cooldowns, rate
  limiting during authentication, unsafe rate metadata, and ordinary denials.
- `npm run check`: **passed**.
- `git diff --check`: **passed**; the three untracked candidate files were also
  checked with `git diff --no-index --check /dev/null <file>` without whitespace
  diagnostics.
- `npm run build`: failed before build execution because the tsx CLI's IPC socket
  was denied (`listen EPERM`). `node --import tsx script/build.ts` ran the same
  build script successfully, producing the client and server before native tests.
- Related regression command:
  `npm run test:server -- tests/git-app-request.test.ts tests/git-production-connector.test.ts tests/git-connector-retry.test.ts tests/git-ref-deadline.test.ts tests/git-rate-limit.test.ts tests/git-transport-timing.test.ts tests/github-app.test.ts tests/github-app-git.test.ts`:
  **121 passed, 9 failed** across eight files (seven passed). The nine lifecycle
  failures in `github-app.test.ts` encountered sandbox socket binding denial
  (`listen EPERM`); the transport suites passed.
- `npm run test:git-store`, after the successful build script: **28 file-level
  tests passed, 6 failed**. Failed files: `git-commercial-runtime.test.mjs`,
  `git-custody-billing.test.mjs`, `git-lifeos-binding.test.mjs`,
  `git-private-mail.test.mjs`, `git-storage-bridge.test.mjs`, and
  `git-store.test.mjs`. The native runner reported generic process failures.
  A direct diagnostic, `node --import tsx tests/git-private-mail.test.mjs`,
  reproduced `spawnSync git EPERM` in its fixture setup. This does not establish
  the cause of all six failures or a passing native integration suite.
- The broad unfiltered `npm run test:server` was not rerun. The supplied historical
  missing `server/evidence` fixture limitation remains; no fixture was invented.

These are local offline results, not independent acceptance or production proof.

## No-header 403 correction verification — 2026-11-17

The preceding verification remains historical evidence. This follow-up changes
only the request adapter, its tests and this verification note. It recognizes
no-header 403 responses whose complete JSON message begins with GitHub's
secondary-limit message or primary API-limit message. Classification inspects
less than 4 KiB of complete JSON within the existing request deadline, cancels
remaining body consumption, and exposes only the sanitized body and a numeric
60-second Retry-After. Unrecognized, malformed and oversized bodies remain
ordinary authorization failures. No raw error text or credential identifiers are
logged. This extends the header-only secondary-limit description above.

The existing shared cooldown and valid-token preservation now apply to these
body-classified limits. There is no automatic replay of authentication or data
writes. Tests cover all four shared authentication phases, overlapping POST and
PATCH calls, one token mint, suppression through 59,999 ms, reuse after 60 seconds,
ordinary permission denials, malformed/oversized/chunked bodies, body cancellation
and stalled-body deadlines. Authentication failures do not cache partially
validated credentials.

- Seven focused suites: **127 passed**, including **73 request-adapter tests**
  (14 added in this correction). Command:
  `npx vitest run tests/git-app-request.test.ts tests/github-app-git.test.ts tests/git-transport-timing.test.ts tests/git-production-connector.test.ts tests/git-connector-retry.test.ts tests/git-rate-limit.test.ts tests/git-ref-deadline.test.ts`.
- The initial eight-suite run, before the last two body-stream cases were added:
  **133 passed, 9 failed**; the nine GitHub App lifecycle failures again reported
  sandbox `listen EPERM` at Supertest's local listener. No passing lifecycle-suite
  result is claimed.
- `npm run check`: **passed** after the final test additions.
- `git diff --check` and whitespace checks of the untracked adapter/test files:
  **passed**.

Base HEAD remains `165076cdd2e19fdd4f45b5ab3830097a45255cbe`. The original
candidate and prior verification history are preserved. This remains an
**UNATTESTED local candidate**, without commit, push, signing, deployment,
credential retrieval or changes to another project. No live issue closure or
production acceptance is claimed.
