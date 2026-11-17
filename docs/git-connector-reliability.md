# Immutable Git connector reliability

This change is based on accepted source `022007b44faa13cfa7a937768570000d17823d8f`.
It does not change the signed event format, trust pins, signer, tenant identity,
storage authority, or replay verification order.

## Boundaries

- Only commit/tree/blob GETs are retried: at most three transport attempts.
- Each attempt calls the normal production connector adapter again, creating
  normal SDK identity headers and using the same authorized GitHub connection.
- Existing 15-second per-request deadlines remain; the 30-second total budget
  now also includes backoff and response-body consumption. No shorter mutable
  ref deadline is reintroduced.
- Mutable reads and writes are never transport-retried.
- SDK-internal HTTP 401 replay is disabled for this Git adapter so writes and
  auth denials cannot secretly consume extra attempts. No credentials are
  changed or substituted.
- Auth/permission/scope/tenant/owner/configuration/signature/integrity denials,
  malformed JSON, and deadlines fail closed without retry. Existing denial
  matching is retained; no production error is newly assumed transient.
- Short Retry-After values are honored. A cooldown that cannot fit the remaining
  budget fails as GIT_RATE_LIMITED, without retrying early.

## Diagnostics

The SDK subclass wraps its existing protected `buildApiHeaders` and `fetchApi`
methods and calls their unchanged super implementations. Diagnostic records
contain only fixed phase/category labels, elapsed milliseconds and attempt
number. No headers, tokens, URLs, request/response bodies, exception messages,
or identity values are logged. Header/proxy exceptions are UNKNOWN, not
automatically classified as invalid credentials. Original exceptions are
re-thrown unchanged for the existing deny policy.

Disabling SDK internal unauthorized replay makes these hooks cover the sole
identity-header and proxy-request attempt. The adapter does not switch to the
v3 client, select another connection, or bypass identity acquisition.

## Verified coverage and limits

`tests/git-production-connector.test.ts` invokes the production
`connectorRequest`, observed SDK subclass, actual SDK `proxy`, and Git transport.
Only SDK identity-header results and external fetch responses are synthetic.
Cases cover transient success, exhaustion, mixed deadlines, HTTP auth denial,
scope/tenant/owner/signature failures, malformed bodies, write non-repetition,
safe logs, and unchanged signed-event bytes after a one-object transient error.
Existing Git-storage suites cover prior signed receipts, chain/checkpoint,
tenant and replay/CAS compatibility; project-service HTTP suites remain intact.

Generic pre-HTTP errors already had bounded retries in the base source. This
change makes the actual SDK path testable and observable and closes hidden
attempt/time-budget gaps; it is not proof of the production incident's cause.
The production SDK exception's underlying reason remains unknown. Known
identity/authorization failures are not made retryable merely to finish replay.
No persistent snapshot, startup replay retry loop, or scheduler is introduced.
No production enrollment, receipt issuance, or outage recovery is claimed.
