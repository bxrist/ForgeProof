# ForgeProof - Code Provenance for the AI Era

## Overview
ForgeProof is a GitHub-integrated code provenance attestation platform. It tracks which AI models generate code, where they operate, and provides cryptographic proof of origin using Ed25519 signatures and SHA-256 hash chains.

## Architecture

### Frontend (React + Vite)
- **Landing Page** (`client/src/pages/landing.tsx`) - Informational website explaining model/data sovereignty, trust architecture, use cases, API integration
- **Dashboard** (`client/src/pages/dashboard.tsx`) - Protected page showing attestation receipts, repositories, API keys
- **Attestation Detail** (`client/src/pages/attestation-detail.tsx`) - Individual receipt view with download

### Backend (Express)
- **Routes** (`server/routes.ts`) - API endpoints for attestations, repositories, API keys, plus public attestation API
- **Storage** (`server/storage.ts`) - DatabaseStorage implementing IStorage interface with PostgreSQL
- **Crypto** (`server/crypto.ts`) - Ed25519 signing, SHA-256 hashing, hash chain computation, API key generation
- **Seed** (`server/seed.ts`) - Self-attesting seed data (ForgeProof attests its own codebase)
- **Auth** (`server/replit_integrations/auth/`) - Replit Auth with OpenID Connect

### Shared
- **Schema** (`shared/schema.ts`) - Drizzle ORM models: repositories, attestationReceipts, apiKeys (plus users/sessions from auth)
- **Auth Models** (`shared/models/auth.ts`) - User and session tables for Replit Auth

### Database
- PostgreSQL with Drizzle ORM
- Tables: users, sessions, repositories, attestation_receipts, api_keys

## Key Design Decisions
- Ed25519 for digital signatures (fast, small keys, secure)
- SHA-256 for file hashing and hash chain
- Hash-chained attestation ledger (each entry links to previous)
- Self-attesting: ForgeProof attests its own codebase as seed data
- Replit Auth for user authentication
- No file uploads - GitHub integration only
- Versioned receipt schema (v1)

## User Preferences
- Frontend visual excellence is paramount
- Dark mode support via class-based toggling
- Inter font for body, Space Grotesk for display, JetBrains Mono for code
- Security/trust-oriented blue primary color scheme

## Recent Changes (Feb 2026)
- Initial MVP implementation
- Complete informational landing page with all sections
- Dashboard with tabs for attestations, repositories, API keys
- Attestation detail page with JSON download
- Ed25519 cryptographic signing
- Seed data with 5 self-attesting receipts
- Public attestation API at POST /api/v1/attest
