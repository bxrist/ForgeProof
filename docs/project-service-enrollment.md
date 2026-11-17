# Independent project lifecycle services

This extends ForgeProof's existing signed Git state and private credential custody.
It does not enroll any production project automatically, change LifeOS credentials,
or infer active projects from discovered repositories.

## Enrollment and readback

All owner operations require the existing authenticated customer session:

- `POST /api/project-enrollments`
  `{ "repositoryId": 123, "active": true, "expiresAt": "<UTC ISO timestamp>" }`.
  Expiry must be in the future and within 90 days.
  The repository must already belong to this customer in ForgeProof. The server
  uses that customer's existing GitHub connection to verify the exact GitHub
  repository ID/full name, administrative permission, and that it is neither
  archived nor disabled. Missing connection, denial or provider failure does not
  enroll a project.
- `GET /api/project-enrollments` returns only the owner's enrolled services,
  including service identity, tenant, project, activation, credential status and
  expiry. It does not return credentials or verifiers.
- `DELETE /api/project-enrollments/:id` revokes the owner's binding in signed Git.
  Another customer cannot revoke it.

Enrollment creates a distinct service subject and random, finite-expiry
`attest:write` credential for that project. The bearer secret is returned only in
the successful enrollment response (`credential`, HTTP 201, `Cache-Control:
no-store`). Only its verifier is held in encrypted private custody; the signed
Git record holds an opaque custody reference. Do not put the response into source,
logs, issues, browser storage or chat. Transfer it through the caller's protected
credential provisioning mechanism.

If enrollment's response is lost, list enrolled services before taking any further
action. The secret cannot be read back. Revoke the inaccessible binding before an
explicit replacement enrollment. This release does not implement in-place
credential rotation; a replacement identity cannot claim old identity's parents.

Repository discovery is NOT activation. The active-project denominator must be
the explicitly approved projects in scope, with current authorization and
unexpired credentials. ForgeProof and AgentPort are not claimed enrolled by this
source change. The API supports each independently when its actual owner invokes
enrollment; it never shares the LifeOS key.

## Service APIs

Send the issued bearer credential to these routes, using its enrollment ID:

- `GET /api/project-services/:id/authorization`: validates signed Git binding,
  repository/account relationship, expiry, revocation, permission and private
  custody proof. Returns `authorized: true` and the safe binding.
- `POST /api/project-services/:id/attest`: requires `Idempotency-Key` and:

```json
{
  "file_path": "src/example.ts",
  "file_hash": "<bare lowercase 64-character SHA-256>",
  "model_name": "UNSPECIFIED",
  "model_provider": "UNSPECIFIED",
  "country_of_origin": "UNSPECIFIED",
  "signedAt": "<UTC ISO timestamp with milliseconds>",
  "lifecycle": {
    "project": "owner/repository",
    "stage": "source-write",
    "parents": [],
    "observedAt": "<UTC ISO timestamp>"
  }
}
```

The existing lifecycle schema also supports `commitSha`, `actor`, `tool`, `model`
and `evidenceUri`. Unknown top-level fields are rejected. Observed model metadata
must match the receipt declarations. Missing model observations stay UNKNOWN.
All stages use the existing signed lifecycle envelope and trusted receipt signer.
The envelope retains its existing version/prefix for compatibility; it does not
mean the caller used the LifeOS identity.

Stage links: source-write has no parents; commit requires source-write parents
and a commit SHA; build requires one commit parent; deployment one build parent;
rollback one deployment and one build parent. All parents must belong to the
same service subject and exact project. Deployment/rollback artifacts must match
their linked build. Hashes are submitted evidence, not a claim that ForgeProof
independently ran the build or observed the hosting provider.

- `GET /api/project-services/:id/attest/status/:requestId`: authenticated read-only
  recovery of the original receipt, including signature and lifecycle evidence.
  Never resend an ambiguous write with a new request ID. A 404 is not proof that
  an in-flight write cannot commit. Exact retries retain the same request ID,
  body and signedAt; conflicting reuse is rejected.

Request IDs use the existing 8–129 character LifeOS identity grammar. Successful
issuance returns HTTP 201 and the original signed receipt. Wrong bearer,
project, tenant, revoked or expired authorization fails closed. Infrastructure
failure returns sanitized 503; there is no SQL, LifeOS-key or anonymous fallback.

## Commercial and cryptographic boundaries

Project service subjects cannot authenticate as account API keys. Issuance
rechecks the binding and custody proof inside each existing Git CAS attempt.
Receipts belong to the service subject; issuance consumes the enrolling owner's
existing attestation quota atomically, without creating a subscription, customer,
price or payment. LifeOS's existing noncommercial path is unchanged.

Readback is derived from verified signed Git replay. Enrollment/rotation is not
a public detached identity certificate. Public independent receipt verification
uses `/api/lookup?q=<id-or-entryHash>`, `/api/verify/entry/:id/lifecycle` and the
existing ledger verifier, with a separately trusted signer pin and full parent
graph. The public lifecycle envelope binds project, artifact and parent hashes;
private tenant/service identity binding is checked through authenticated status.

## Verification coverage and limits

- `tests/git-project-services.test.mjs`: isolated real signed Git and Ed25519
  fixtures; separate subjects/credentials, five-stage graph, owner quota,
  cross-account/project denial, wrong key, expiry, revocation, forged/missing
  parent references, custody/replay failure, post-commit response loss and
  idempotent recovery.
- `tests/project-service-routes.test.ts`: HTTP session/bearer boundaries,
  activation/expiry validation, provider permission/error handling, no fallback,
  principal selection, request identity, recovery and sanitized errors.
  HTTP tests stub issuance; cryptographic tests above use real fixture keys.
- Existing Git/LifeOS suites remain required compatibility checks.

No fixture is production evidence. Real enrollment, secure credential delivery,
authenticated bot calls, mandatory DevBot/BuildBot enforcement in other products,
and the actual authorized active-project denominator must be verified separately.
This change neither modifies LifeOS nor closes its issue merely on test results.
