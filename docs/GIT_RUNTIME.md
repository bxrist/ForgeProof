# Git-authoritative runtime

## Current implementation

`server/git-store/applicationRuntime.ts` installs `GitStorage` behind the
application storage facade. In Git mode it replays verified events before
listening. SQL seeding, SQL health checks, SQL Stripe-cache migrations and the
transitional SQL receipt-export worker are not the Git runtime's authority.

`server/git-store/githubRuntime.ts` connects the hosted implementation to a
private GitHub repository through the existing Replit GitHub connector.
`server/git-store/github-store.mjs` implements immutable Git reads and
compare-and-swap writes. Payload fetches can run concurrently; signature,
ancestry, checkpoint, hash-chain and record validation remain sequential.

## Existing-instance configuration

Keep configuration and credentials in the hosting environment, not this public
repository. These are configuration names, not instructions to create or rotate
credentials or reinitialize an existing store:

| Setting | Meaning |
| --- | --- |
| `FORGEPROOF_STORAGE=git` | Select Git business-state authority |
| `FORGEPROOF_GIT_GITHUB_REPOSITORY` | Operational private repository, `owner/repository` |
| `FORGEPROOF_GIT_TENANT` | Existing tenant namespace |
| `FORGEPROOF_GIT_STREAM` | Existing application stream |
| `FORGEPROOF_GIT_GUARD_USER_ID` | Existing bootstrap/authorized owner identity |
| `FORGEPROOF_GIT_CHECKPOINT` | JSON trust anchor with `commit`, `eventHash`, `sequence` |
| `FORGEPROOF_GIT_RECEIPT_KEYS` | Trusted receipt verification public keys |
| `FORGEPROOF_GIT_RECEIPT_PREDECESSOR` | Optional configured receipt predecessor |
| `FORGEPROOF_ED25519_PRIVATE_KEY_PEM` | Existing private signing material |
| `FORGEPROOF_ED25519_PUBLIC_KEY_PIN` | Matching independent public-key pin |

The deployed implementation also supports the historical
`FORGEPROOF_STAGING_SIGNER_PRIVATE_KEY_PEM` /
`FORGEPROOF_STAGING_SIGNER_PUBLIC_KEY_PIN` names in production when the primary
signer names are absent. Despite their names, do not assume those values are
disposable staging keys. Preserve the configured signer and trust anchor.

The GitHub connector requires its authorized hosting context; a plain clone
outside Replit does not inherit that connection. The existing alternative
`FORGEPROOF_GIT_CONFIG` path accepts an owner-private JSON configuration and a
trusted local `signerModule` supplying service/signing/custody adapters. See
`applicationRuntime.ts` for that interface. This release does not add a new
bootstrap wizard or automatically provision a store. An existing initialized
store and owner record are required by the current implementation.

## Authentication and billing

Clerk uses `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` and the frontend
`VITE_CLERK_PUBLISHABLE_KEY`. Configure the matching Clerk instance and its
allowed URLs. Authentication resolves application identities through the active
storage implementation, rather than requiring PostgreSQL.

Stripe settings are resolved by `server/stripeConfig.ts` and
`server/stripeClient.ts`. Existing live deployments use
`FORGEPROOF_STRIPE_MODE=live` and the matching
`FORGEPROOF_LIVE_STRIPE_*` credentials/catalog configuration.
`POST /api/stripe/webhook` verifies the raw request signature before processing
billing state. Ownership checks and event-id deduplication precede persisted
subscription updates. Merely returning from checkout is not proof of paid access.

The optional Stripe readiness page is server-admin-only. Its navigation link
is shown only after the server authorizes the current signed-in identity; a
readiness report of `ready: false` does not make an authorized admin a non-admin.
`FORGEPROOF_ADMIN_USER_IDS` is a server configuration, not an email/name check.

## Private evidence versus public source

The public repository must not contain operational signed-event archives,
credential custody records, customer identities, private deployment settings or
customer source-inventory exports. Runtime code for verifying and serving that
evidence is included.

The hosted instance has a materialized source-manifest asset under
`server/evidence/`; its customer inventory is intentionally not redistributed.
`script/build.ts` copies that directory into the server build. The public tree
retains its explanatory README so source-only builds have the required directory,
but does not include the hosted instance's private inventory JSON.
Its absence must not be represented as successful verification of that evidence.

## Updating source

Build with `npm ci`, `npm run check` and `npm run build`; run the relevant
regressions for changes. Updating source does not require importing history,
changing the signer, changing checkpoint pins, running SQL migrations, or
creating test payments. Preserve existing runtime settings and evidence.

The scripts directory contains explicit maintenance/migration tools for their
documented purposes. They are not automatically required setup steps. Do not run
them to make a checkout appear initialized or to populate demo data.
