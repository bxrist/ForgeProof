# Threat Model

## Project Overview

ForgeProof is a GitHub-integrated code-provenance attestation platform (Node.js/Express + React/Vite, PostgreSQL via Drizzle). It issues cryptographically signed (Ed25519) attestation receipts chained via SHA-256, verifiable publicly. Authentication uses Replit Auth (OpenID Connect, cookie session). Stripe (via the Replit connector) provides Free/Pro/Enterprise subscription billing with per-plan attestation quotas. A dormant "LifeOS" dedicated-service entitlement path exists but is disabled (`lifeosApproval === null`). Deployed public autoscale at forgeproof.flyingcloudtech.com.

## Assets

- **Attestation ledger** — the hash-chained `attestation_receipts` table. Integrity and availability are the core product value; destruction or pollution undermines all provenance claims.
- **User accounts / sessions** — Replit Auth identities, session cookies.
- **GitHub OAuth tokens** — stored per-user (`users.githubToken`), grant `repo` scope; compromise exposes private repos.
- **Stripe billing state** — customer IDs, subscription status, quotas.
- **Application secrets** — Ed25519 signing key, Stripe keys, GitHub client secret, webhook secrets.
- **API keys** — Bearer keys authorizing attestation writes under a user.

## Trust Boundaries

- **Browser ↔ Express API** — all client requests; the server must authenticate/authorize every protected action.
- **Public verification surface** — `/api/lookup`, `/api/verify/*`, `/api/v1/attestation/:id/chain`, badges, analytics are intentionally public and expose receipt fields (fileName/filePath/fileHash/model info). This is by design for a provenance product.
- **API ↔ PostgreSQL** — attestation writes use raw parameterized SQL inside advisory-lock transactions.
- **API ↔ GitHub / Stripe** — outbound calls with secrets; inbound webhooks must be signature-verified.
- **User ↔ Admin / operator** — Stripe reconciliation endpoints gate on `isTrustedStripeAdmin` + origin; seeding/reseed should be operator-only.

## Scan Anchors

- Production entry points: `server/routes.ts` (primary API surface, ~2100 lines), `server/index.ts` (Stripe webhook mounted raw before `express.json`), `server/mcp.ts`.
- Highest-risk areas: unauthenticated/admin routes in `server/routes.ts` (`/api/admin/reseed`), output-encoding sinks (badge SVG + receipt HTML export), webhook signature handling (`/api/github/webhook`), API-key auth (`authenticateApiKey`).
- Public vs authenticated: public = demo/lookup/verify/analytics/badge/openapi/mcp manifest; authenticated = `/api/attestations*`, `/api/repositories*`, `/api/api-keys*`, `/api/organizations*`, `/api/billing*`, `/api/preferences`, `/api/notifications*`.
- Dormant/dev: LifeOS entitlement (`server/lifeosEntitlement.ts`, `lifeosApproval.ts`) disabled; `server/seed.ts` is self-attestation seed data.

## Threat Categories

### Tampering / Denial of Service
The attestation ledger is the product. Any unauthenticated endpoint that deletes or mass-inserts receipts (e.g. `/api/admin/reseed`, or `/api/github/webhook` when no secret is configured) breaks integrity/availability guarantees. Guarantee: destructive and ledger-write endpoints MUST require authenticated, authorized callers or verified signatures.

### Information Disclosure
Public verification deliberately exposes receipt metadata. Attestation receipts created by authenticated users may contain private repo paths; the object-level `/api/attestations/:id` enforces ownership, but public lookup/verify/chain endpoints do not — treat private-repo file paths as potentially disclosed by design and avoid storing secrets in receipt fields.

### Cross-Site Scripting
Receipt fields (`model_name`, `model_provider`, `file_path`, etc.) are free-form strings and are reflected unescaped into `image/svg+xml` (badges) and `text/html` (receipt export) responses on the app origin. Guarantee: all user-influenced data rendered into SVG/HTML MUST be context-encoded.

### Spoofing
Webhooks (GitHub, Stripe) must verify signatures. Stripe is verified in `webhookHandlers.ts`. GitHub webhook verification is skipped entirely when `GITHUB_WEBHOOK_SECRET` is unset.

### Elevation of Privilege
Org membership writes allow owners/admins to set arbitrary roles (including `owner`) for arbitrary user IDs. API-key and session auth gate most sensitive routes; verify no authenticated-but-unauthorized object access.
