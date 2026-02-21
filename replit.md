# ForgeProof - Code Provenance for the AI Era

## Overview
ForgeProof is a GitHub-integrated code provenance attestation platform. It tracks which AI models generate code, where they operate, and provides cryptographic proof of origin using Ed25519 signatures and SHA-256 hash chains.

## Architecture

### Frontend (React + Vite)
- **Landing Page** (`client/src/pages/landing.tsx`) - Comprehensive informational website with sovereignty, trust architecture, how it works, use cases, platform features grid, API integration sections
- **Demo Page** (`client/src/pages/demo.tsx`) - Public read-only dashboard showing self-attesting seed data, no login required
- **Demo Attestation Detail** (`client/src/pages/demo-attestation-detail.tsx`) - Public individual receipt view with JSON download and certificate export
- **Dashboard** (`client/src/pages/dashboard.tsx`) - Protected page with tabs: Attestations, Repositories (with GitHub sync), API Keys (with notification prefs), Teams (organizations), Activity Log (audit trail)
- **Attestation Detail** (`client/src/pages/attestation-detail.tsx`) - Individual receipt view with download and certificate export
- **Verify Page** (`client/src/pages/verify.tsx`) - Hash chain verification UI showing every entry's integrity
- **Lookup Page** (`client/src/pages/lookup.tsx`) - Public receipt lookup/verification by ID or hash
- **SDK Docs** (`client/src/pages/sdk.tsx`) - Python/TypeScript/curl code examples, GPT Actions guide, badge embeds
- **Analytics** (`client/src/pages/analytics.tsx`) - Visual analytics by provider, model, country, compliance status
- **Custom Logo** (`client/src/components/ForgeProofLogo.tsx`) - Hammer-and-anvil SVG with hash/proof elements
- **Onboarding** (`client/src/components/OnboardingWalkthrough.tsx`) - First-time user walkthrough with 5 steps
- **Error Boundary** (`client/src/components/ErrorBoundary.tsx`) - Global error catching with friendly UI
- **SEO** (`client/src/components/SEO.tsx`) - Reusable meta tags component using react-helmet-async

### Backend (Express)
- **Routes** (`server/routes.ts`) - API endpoints for attestations, repositories, API keys, organizations, audit logs, notifications, public attestation API, GitHub OAuth/webhooks, MCP tools, analytics, badges, receipt export, OpenAPI spec
- **Storage** (`server/storage.ts`) - DatabaseStorage implementing IStorage interface with PostgreSQL
- **Crypto** (`server/crypto.ts`) - Ed25519 signing, SHA-256 hashing, hash chain computation, API key generation
- **Seed** (`server/seed.ts`) - Self-attesting seed data (ForgeProof attests its own codebase)
- **MCP** (`server/mcp.ts`) - MCP Tool Server with forgeproof_attest, forgeproof_lookup, forgeproof_verify_chain, forgeproof_batch_attest
- **Auth** (`server/replit_integrations/auth/`) - Replit Auth with OpenID Connect

### Shared
- **Schema** (`shared/schema.ts`) - Drizzle ORM models: repositories, attestationReceipts, apiKeys, organizations, orgMembers, auditLogs (plus users/sessions from auth)
- **Auth Models** (`shared/models/auth.ts`) - User and session tables for Replit Auth (includes githubToken, githubUsername, notificationEmail fields)

### Database
- PostgreSQL with Drizzle ORM
- Tables: users, sessions, repositories, attestation_receipts, api_keys, organizations, org_members, audit_logs

## API Endpoints
- `POST /api/v1/attest` - Create attestation receipt (Bearer API key auth)
- `GET /api/v1/verify/:hash` - Verify attestation by entry hash
- `GET /api/lookup` - Public receipt lookup by ID or hash
- `GET /api/verify/chain` - Full hash chain verification
- `GET /api/analytics` - Attestation analytics data
- `GET /api/badge/:id.svg` - SVG badge for individual attestation
- `GET /api/badge/repo/:repoName.svg` - SVG badge for repository
- `GET /api/receipt/:id/export` - HTML certificate export (printable)
- `GET /api/openapi.json` - OpenAPI spec for GPT Actions
- `GET /api/mcp/manifest` - MCP tool server manifest
- `POST /api/mcp/tools` - Execute MCP tools (Bearer API key auth)
- `POST /api/github/webhook` - GitHub push event webhook listener (HMAC verified)
- `GET /api/github/connect` - GitHub OAuth initiation
- `GET /api/github/callback` - GitHub OAuth callback (stores token)
- `GET /api/github/status` - GitHub connection status
- `GET /api/github/repos` - Fetch connected GitHub repos
- `GET /api/organizations` - List user organizations
- `POST /api/organizations` - Create organization
- `GET /api/organizations/:id/members` - List org members
- `POST /api/organizations/:id/members` - Add org member
- `DELETE /api/organizations/:id` - Delete organization
- `GET /api/audit-logs` - User audit log history
- `GET /api/notifications/preferences` - Get notification preferences
- `POST /api/notifications/preferences` - Update notification preferences
- `GET /api/demo/attestations` - Public demo attestation list
- `GET /api/demo/attestations/:id` - Public demo attestation detail

## Key Design Decisions
- Ed25519 for digital signatures (fast, small keys, secure)
- SHA-256 for file hashing and hash chain
- Hash-chained attestation ledger (each entry links to previous)
- Self-attesting: ForgeProof attests its own codebase as seed data
- Replit Auth for user authentication
- Rate limiting on all public endpoints (express-rate-limit)
- Versioned receipt schema (v1)
- MCP tool server for AI agent integration
- GitHub OAuth with CSRF state protection
- GitHub webhook with HMAC signature verification
- Audit logging on all mutation operations

## User Preferences
- Frontend visual excellence is paramount
- Dark mode support via class-based toggling
- Inter font for body, Space Grotesk for display, JetBrains Mono for code
- Security/trust-oriented blue primary color scheme

## Recent Changes (Feb 2026)
- Initial MVP implementation complete
- Phase 1: Rate limiting, search/filtering, public lookup page, verify page
- Phase 2: SDK docs page, MCP Tool Server, OpenAPI spec for GPT Actions
- Phase 3: GitHub OAuth flow with token persistence, webhook listener, repo sync
- Phase 4: Analytics dashboard, badge SVG endpoints, receipt certificate export
- Phase 5: Onboarding walkthrough for first-time dashboard users
- Phase 6: Toast notifications, mobile responsive nav, loading skeletons
- Phase 7: Error boundary, SEO meta tags on all pages
- Phase 8: Audit logging, team/org support, notification preferences
- Phase 9: Landing page comprehensive feature documentation
