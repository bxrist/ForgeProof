# ForgeProof

**Signed code-provenance receipts and Git-authoritative application state**

A [Flying Cloud Technology](https://www.flyingcloudtech.com) project.
Licensed under [Apache 2.0](LICENSE).

## What the application does

ForgeProof issues Ed25519-signed receipts for file hashes and declared provenance.
Receipts are linked by a SHA-256 ledger chain and can be verified publicly.
The application includes a React dashboard, Clerk authentication, scoped API
keys, repository management, organizations, audit records, and Stripe billing.

**Git is authoritative for application-owned business state. PostgreSQL is not
required for the Git runtime.** The public product repository contains code;
the hosted application's operational state is in a separate private Git evidence
repository. Cloning this repository does not copy customer records or credentials.

## Evidence boundaries

- A valid signature proves integrity and the signing identity's assertion. It
  does not independently prove which AI authored code or where a provider ran.
- Model/provider declarations are distinct from observed model attribution.
  Missing attribution and unverified processing regions remain unknown.
- SHA-256 ledger chaining is separate from optional parent/child attestation
  lineage. A receipt without a parent or child can still belong to a valid ledger.
- A signed source manifest covers its listed file hashes as one signed inventory;
  it does not constitute a separate signature or security audit for each file.
- The source commit/manifest reference is distinct from an optional receipt-export
  Git commit and from the operational Git business-state ledger.
- The public demo uses isolated illustrative fixtures, not fabricated production
  receipts. It is not evidence that a commercial workflow passed.

## Architecture

```text
Clerk session / scoped API key
           |
Express routes -> application storage facade -> GitStorage
                                                  |
                                  signed, ordered event replay
                                  atomic compare-and-swap append
                                                  |
                                  private operational Git repository

Stripe webhooks -> signature + ownership checks -> Git subscription state
Public verification -> receipt signature + content hash + ledger checks
```

The Git implementation includes replay, trusted checkpoints, chain and ancestry
validation, protected record storage, provider credential custody, idempotent
billing-event handling, and atomic receipt/quota updates. Cold GitHub replay
prefetches immutable payloads with bounded concurrency while verification remains
ordered.

Clerk remains the identity provider. Stripe remains the commercial billing
provider. Git stores application-owned records; it does not replace those
providers' own identity or payment systems.

## Development and operation

Requires Node.js 20+ and npm.

```bash
git clone https://github.com/bxrist/ForgeProof.git
cd ForgeProof
npm ci
npm run check
npm run build
```

These commands compile the source; they do not configure an operational store or
create customer data. See [Git runtime configuration](docs/GIT_RUNTIME.md) for
the existing runtime's settings and adapter boundaries.

For an already configured Git instance:

```bash
# Set the instance's existing Git, signer and authentication configuration first.
FORGEPROOF_STORAGE=git npm run dev
# Production: build first, then start with the configured production environment.
npm start
```

Do not run migration, provisioning, seeding, catalog, or reconciliation scripts
against an existing deployment merely to update its source.

### Optional legacy SQL mode

The SQL adapter and Drizzle schema remain for compatibility. Only operators
explicitly using `FORGEPROOF_STORAGE=postgres` need `DATABASE_URL` and SQL schema
management. Development without an explicit Git selection/configuration can
default to this legacy mode. This is not a PostgreSQL requirement for Git mode.

### Checks

```bash
npm run check
npm run test:git-store
npm run test:server
npm run build
```

The Git regression runner removes PostgreSQL environment variables and uses
temporary fixture repositories/keys. Browser tests use Playwright and a running
development server; some authenticated suites require a configured Clerk test
environment. Do not run them against real customer accounts by assumption.
Passing automated tests does not assert that every live payment or API-key
workflow has been exercised.

## API

Create a receipt using an existing active API key with `attest:write` permission
and available quota. This is a write operation; the example is not run by setup.

```bash
curl -X POST https://your-instance.example/api/v1/attest \
  -H "Authorization: Bearer $FORGEPROOF_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "file_path": "src/example.ts",
    "file_hash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "model_name": "UNSPECIFIED",
    "model_provider": "UNSPECIFIED",
    "country_of_origin": "UNSPECIFIED"
  }'
```

Replace the illustrative hash with the actual file's bare 64-character SHA-256
hex digest. Supply provenance declarations only when supported by your evidence.
Successful issuance returns HTTP 201. A timeout does not prove issuance failed;
inspect existing receipts before retrying, since the endpoint does not provide
client-supplied idempotency for arbitrary repeat submissions.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/v1/attest` | Authenticated receipt issuance |
| GET | `/api/verify/entry/:id` | Public receipt verification |
| GET | `/api/v1/verify/:hash` | Verify by entry hash |
| GET | `/api/verify/chain` | Public ledger verification |
| GET | `/api/lookup` | Public receipt lookup |
| GET | `/api/openapi.json` | API specification |

## Integrations and source release

Existing GitHub OAuth connections and the separate GitHub App integration are
distinct. See [GitHub App setup](docs/github-app-setup.md); publishing this source
does not register or activate an App or Marketplace listing.

This source release aligns the application implementation with the deployed
November 10, 2026 source (`cc9f594fcc88eb1b0b9d7f41b24469cf748efe08`).
Documentation and portable configuration are updated separately. Private
deployment configuration, operational archives, materialized customer source
inventories, agent notes and secrets are not part of the public source release.
Historical repository commits describe their own revisions, not current
runtime requirements.

## Links

- [Hosted application](https://forgeproof.flyingcloudtech.com)
- [Illustrative demo](https://forgeproof.flyingcloudtech.com/demo)
- [SDK documentation](https://forgeproof.flyingcloudtech.com/sdk)
- [Threat model](https://forgeproof.flyingcloudtech.com/threat-model)
- [Receipt attribution](docs/receipt-attribution.md)
