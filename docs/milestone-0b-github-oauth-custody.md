# ForgeProof 0B — GitHub OAuth credentials outside signed Git (source only)

## Authority and scope

Original owner instructions (verbatim, authoritative):

> Milestone 0B: use the handoff of 0a and continue.
>
> Proceed until done
>
> Continue until done only prompt me if I’m absolutely needed

This experimental ForgeProof source contribution is **not** production cutover authorization or a declaration of Milestone 0B completion. No Replit unpublished application code, user tokens, Stripe configuration, SQL rows, LifeOS source, default ForgeProof HTTP routes or billing files are included.

## Implementation

The signed, private Git `users` record may contain an opaque, UUID-validated `githubTokenRef`, but cannot contain raw OAuth tokens. `EncryptedProviderCustodian` supports the `github-oauth` credential kind, keeping the material only in an AES-256-GCM protected external transactional vault. GitStorage accesses OAuth material only for the exact authenticated owner with an explicitly configured custody binding. The vault namespace binds to both tenant scope and a stable digest of that owner's ID; a signed Git pointer copied to another user does not grant access. If the vault is missing or undecryptable, reads of an active owner's pointer fail closed.

On rotation/disconnect, private material is first staged in the independently encrypted vault; only an opaque reference is then committed to the signed Git event stream. Old material is retired **after** the Git authorization pointer has been durably accepted. A custody-cleanup failure is reported and can leave an inert, externally orphaned old secret requiring authorized cleanup. App-facing non-owner reads provide no plaintext secret or custody reference. No secret or unsalted deterministic token hash is in a signed event or audit fingerprint.

The existing `IStorage.updateUser` API does not carry stable client-supplied idempotency identifiers. New OAuth updates use fresh request IDs; the code does **not** promise exactly-once rotation under retries or automatic orphan cleanup. A real durable encrypted provider-backed custody implementation, independent encryption-key recovery/rotation and authenticator/source binding remain separate release requirements.

## Verification and current limits

The implementation was developed against a privately escrowed real Replit source baseline, **without importing those unpublished Replit application commits**. The private integration passed 92/92 Node and 215/215 Replit server Vitest tests, TypeScript and full client/server build. Only the Git-store custody, schema and storage modules and four synthetic tests were ported upstream. On isolated public-upstream source at prior commit `027227fcfb39a219bf1442f41f9712227b83a384`, **111/111** Node tests, TypeScript and application build passed, as did diff checks and high-confidence credential/secret-literal scanning.

Synthetic signed Git tests use an in-memory CAS vault and real generated Ed25519 signatures; they cover owner/member isolation, an independent signed Git clone, wrong key/scope, invalid token inputs, rotation/revocation, cleanup failure, and deliberately malicious signed cross-owner pointer reuse. **No real OAuth token was accessed or stored.** A requested Codex review was unable to inspect the diff and must **not** be presented as an independent successful source review; the actual automated tests, direct source inspection and static scans are distinct, directly observed evidence.

The deployed ForgeProof Replit application still reads PostgreSQL through `server/index.ts`, `server/middlewares/requireAuth.ts`, `server/routes.ts`, Stripe and webhook modules, and its ordinary IStorage uses DatabaseStorage. No upstream merge, release, production migration, deployed token vault, provider billing reconciliation, SMTP lease or real user acceptance is demonstrated here. The 0B status remains **NO_GO** until a consistent authorized production snapshot is migrated, the complete app cutover passes live private Git/Stripe/Clerk/recovery tests, LifeOS consumes an approved ForgeProof release, and Darwin independently signs off.
