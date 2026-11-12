# LifeOS request recovery reconciliation

This source reconciles the accepted HTTP idempotency implementation at
`04f8c777bd74ed1ce100d0d170db35fae7aa305b` with the working Git-native
authorization, protected owner binding, lifecycle signing and commercial runtime.

## Why direct replacement was unsafe

The public source snapshot predated the deployed principal-selection correction,
signed Git approval loader and lifecycle implementation. Replacing the editor
tree would have restored a lookup before service-principal selection and removed
project-scoped lifecycle verification. The HTTP change itself was not the cause.
The release process had failed to reconcile those intervening source corrections.

## Reconciliation

- Retain the working request-local principal selection, bearer proof, exact key
  permissions, expiry, private custody and signed owner audit-selector precedence.
- Retain lifecycle parent graph validation and original receipt signature bytes.
- Incorporate the accepted request identity parser, atomic Git request lookup,
  pre-retry authorization revalidation, HTTP status handler, focused tests and
  output-encoding mocks.
- Bind the existing lifecycle input into the same keyed request fingerprint.
  An identical retry returns the original receipt and lifecycle envelope, without
  re-signing or appending. Changed lifecycle input returns 409.
- Recover only the signed public lifecycle projection; private receipt metadata
  remains protected. Status checks also enforce the approved project.
- Keep the existing issuance timings, Stripe request-local client behavior and
  retired readiness navigation.
- Update lineage fixtures to the existing accessible-receipt query and
  same-issuer logical-history contract, retaining tenant-isolation assertions.

## Contract and verification

See `lifeos-http-idempotency.md` for the accepted opt-in contract:
`Idempotency-Key` plus canonical `signedAt`, and authenticated read-only
`GET /api/lifeos/attest/status/:requestId`. Unkeyed requests remain unkeyed.
Status responses use `Cache-Control: no-store`.

The real Git/custody/Express fixture now exercises all five lifecycle stages,
identical retries, read-only status, changed lifecycle conflicts, wrong bearer,
conflicting principal and revoked-key denial. Synthetic fixtures use temporary
repositories and synthetic keys only. No historical UNKNOWN request is replayed.

Validation: 176 Git tests passed; TypeScript and production build passed.
The Node 20 server run exposed a Node 22-only SQLite test fixture and five stale
lineage mocks. After correcting those mocks, Node 22 passed 341/344 server tests;
the remaining three timed out under parallel load. A focused one-worker rerun
of those three files passed all 46 tests. No failed assertions remain.
No real billing or receipt issuance was used.

## Source identity boundary

The public repository contains portable application code, tests and documentation.
The editor retains its deployment `.replit`, private evidence inventories,
collaborator instructions and internal operational notes. These are not replaced
by public template configuration or uploaded as application source.

Future synchronization must compare application paths against the accepted
public commit, preserve environment-only paths, and reconcile intervening fixes
before declaring equivalence. A public source commit is not proof of which
server binary is running; record the build's commit separately.
