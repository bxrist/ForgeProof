# Milestone 0B phase 4: custody and verified billing inbox

Source-only continuation of phase 3, not production cutover or milestone GO.
SQL, Replit sessions, Stripe synchronization, billing configuration and all default
routes remain unchanged. No external endpoint, signer, production row, subscription,
GitHub remote or LifeOS repository was accessed. The operations below apply to
private infrastructure only; this document contains no private dataset or secrets.
No external attestation POST was made under the explicit source-only instruction.

## Credential authority and integration

`custody.ts` defines `CredentialCustodian`, an unavailable default and an
AES-256-GCM `EncryptedProviderCustodian`. Its injected `EncryptedCredentialVault`
must implement durable linearizable read-modify-write across processes. Only
credential envelopes, request-to-reference bindings and uniqueness reservations
belong there. It is not an application business database. Encryption uses fresh
96-bit nonces, 256-bit externally provisioned key and scope AAD. The key and vault
access credentials must come from an existing secure provider, never Git. No
production vault connector is supplied or automatically selected. Tests inject a
local in-memory fake vault, defined only in the test file. This proves protocol
behavior, not provider durability, key custody or cross-host transactions.

Construct `GitStorage(service, principal, members, guardUserId, custody, scope)`
only in a trusted composition root. Bind scope independently to the private
store's tenant/repository; never accept it or principal/membership from HTTP.
Credential CRUD/lookup requires principal ownership, not merely tenant membership.
An API-key endpoint must authenticate the owner separately before key creation.
`createApiKeyIdempotent(data, nonsecretRequestId, optionalOldKeyId)` stages a
verifier/prefix externally and commits only opaque reference, owner, permissions,
active flag and timestamps. No raw key is accepted by this API. Generate the raw
key outside Git, hand it to its owner once, and retain only its verifier in custody.
The existing `IStorage` signatures still type-check. Returned `keyHash` and
`keyPrefix` are empty compatibility fields, not usable credentials. This is a
behavior difference that a future UI adapter must handle deliberately.

Custodian uniqueness rejects reused verifiers and prefixes in its bound scope,
including retired keys. Verifiers are fixed-format SHA-256 hex, compared with
Node's constant-time byte equality. Prefixes are never authentication authority.
Lookup rejects duplicate matches, inactive/expired keys and other principals.
`authenticateApiKey(hash, permission, nonsecretRequestId)` checks accepted Git
state, writes a replay-safe use event and rechecks authorization. Reusing an old
use ID after revocation cannot grant access. `updateApiKeyLastUsed` is an internal
metadata compatibility method, not authentication. A future HTTP adapter must use
`authenticateApiKey`, not treat metadata updates as proof of possession. Git CAS
and the shared guard serialize quota checks, allocation, rotation and revocation.
Expired keys do not consume active-key quota. Revoked keys remain inactive history.

The state machine is **externally staged -> Git authorized -> Git revoked ->
external cleanup**. A custody stage alone never grants access. Creation/rotation
retries use the same owner, request ID and exact credential input. Secret input is
never included in the Git request fingerprint; the custodian compares it privately.
Rotation atomically authorizes the replacement and disables the old Git record.
Authentication requires both live custody material and accepted Git authorization.
There is no cross-system atomicity claim. If Git append fails or its acknowledgment
is lost, retain the inert stage and retry the same request. Do not blindly delete
it: the event may already have committed. Git readback determines authorization.
If staging fails, there is no authorization event. If cleanup fails after revoke,
Git still denies the key; repeat revoke to retry cleanup. Rotation's old verifier
can be destroyed by repeating `deleteApiKey` on its inactive record. Retired API
verifier/prefix uniqueness reservations remain encrypted externally; destroyed
OIDC material is removed. Failed/quota-denied stages consume custody storage but
never grant auth. A production vault needs bounded admission and a reviewed orphan
cleanup policy; orphan cleanup must account for in-flight/ambiguous Git writes.

`stageOidcSession`, `recoverOidcSession`, `revokeOidcSession` supply an internal
session-material boundary. Invoke staging only after the identity provider's
issuer/audience/nonce/token validation and independently bound user authorization.
These helpers do not validate OIDC assertions or implement browser cookies.
Git holds a new nonsecret descriptor ID, reference, user and expiry; the raw
session/access/refresh material stays encrypted externally. Revoke expires the
Git descriptor before custody cleanup. Recovery checks owner/expiry and rereads
Git after custody access. A descriptor ID alone is never a login credential.
Trusted request IDs must be nonsecret application command IDs, never session IDs.
Lost custody/encryption keys requires reauthentication and new API-key rotation;
a Git clone cannot restore usable credentials. Restore must not revive old
sessions automatically. An independently pinned checkpoint is required to prevent
rollback to pre-revocation history. Already authorized in-flight operations need
application transaction fencing; these helpers cannot revoke a response already
returned to another process.

## Stripe authority and bounded reconciliation

`StripeInbox` is an injected internal service with **no registered route** and no
Stripe API calls. The caller supplies original `Buffer` bytes, the original
Stripe-Signature header, a trusted endpoint secret outside Git, the expected
Connect account (or null for a directly owned account), and an independently
reviewed price-to-plan/quota map. A direct-account webhook secret must belong to
the intended app endpoint/account: a null account field does not identify an
account on its own. Do not share endpoint secrets across unrelated shared-account
applications. Use the existing Stripe SDK for exact-byte HMAC verification and
signature timestamp tolerance; additional future/ambiguous timestamp and event-age
checks fail closed. Event time and header time are bounded to five minutes.

The first supported event is `invoice.paid`, with status paid, no remaining amount,
subscription-cycle reason, one complete non-prorated quantity-one subscription
line, known price, matching invoice/line subscription and existing exact Git
customer/subscription pair. No caller may adopt unknown provider IDs. Mixed invoices,
proration, trials, cancellations, subscription updates, catalog fetching and
subscription creation are deliberately unsupported and fail closed. This is a
working bounded inbox, not a complete commercial lifecycle implementation.

A real `evt_` ID deduplicates the transaction. A `stripe-event` immutable audit
record and subscription update publish in the same Git CAS with the tenant guard.
Only normalized nonsecret commercial data is fingerprinted; webhook bytes and
signatures never enter Git. Reuse of an ID with different normalized content fails.
A strictly newer event-created cursor prevents older events reverting state;
ambiguous equal-second distinct events fail for explicit reconciliation. Duplicates
inside the freshness window are acknowledged idempotently. Redelivery outside
that window is rejected, not allowed to reset counters. Git replay itself rebuilds
all accepted historical inbox events without revalidating expired webhook headers.

Same-period paid events preserve counts. A reset requires a confirmed paid period
whose start strictly advances, is not future-dated or overlapping the previous
period, and whose end does not regress. Uninitialized periods require reviewed
migration rather than inferred resets. Cancellation and out-of-order/missed events
need a future authenticated provider-read reconciliation adapter with explicit
ordering and app-owned identity checks. There are no automatic provider reads,
paid plan changes or subscription operations. `acceptStripeInvoice` and the older
`reconcileSubscription` are internal trusted methods, never public RPCs. Only the
verified inbox should call the new method; future routes must preserve that boundary.

## Private operations runbook and future live requirements

1. Keep the private evidence store, independent trust/checkpoints and custodian
   separate from public source. Provision a real existing secure vault connector
   with linearizable transactions, OS/provider ACLs, durable encrypted backup,
   key rotation/recovery, bounded admission and outage monitoring. Never deploy the
   test fake. Bind one custody scope per independently authorized store. Validate
   restart, wrong-key, unavailable-provider, ambiguous commit and revoked-key recovery
   on private synthetic data before wiring an application endpoint.
2. Resume a staged create with the same nonsecret command ID and exact secret
   input through custody; inspect verified Git state to distinguish inert stage
   from accepted authorization. Revoke in Git first; retry custody cleanup until
   complete. Never roll back Git to undo a key. After credential-provider loss,
   deny authentication, recover the provider securely or reauthenticate/rotate.
   Recover Git with the latest independently retained checkpoint from phase 3.
3. For a future webhook endpoint, mount bounded raw-byte parsing before any JSON
   parser, supply the endpoint secret from secure provisioning and the reviewed
   app-only account/catalog map, then call `StripeInbox.receive`. Translate failures
   to bounded generic responses; never log raw bytes, tokens or provider secrets.
   Do not mount it beside default SQL synchronization as a second authority.
   Reconcile late/missing events via a future read-only provider adapter before
   allowing further billing progression. Broader lifecycle events need source work.
4. Full product cutover still requires replacing Replit OIDC/session SQL storage,
   `connect-pg-simple`, default route assumptions (including separate receipt-count
   increments), direct admin SQL, Stripe catalog SQL and stripe-replit-sync startup/
   webhooks, seed/health code and default `DatabaseStorage` composition. Preserve
   existing production behavior until one coherent replacement is tested. Supply
   authenticated HTTP/UI adapters with exact owner/org roles and immutable receipt
   annotations; these internal services are not an interchangeable legacy boot.
5. Real migration remains a separate operation: obtain a consistent authorized
   read-only snapshot, preserve provider identities, commercial periods/counters,
   memberships and every historical signed field. Unstructured metadata must never
   be dropped or published. Current archive/snapshot schemas reject it. Implement
   and review a restricted archive/custody extension preserving the original signed
   bytes and complete global predecessor chain before importing such history.
   Do not invent model, author, country or original serialization. Reconcile original
   records, signatures and all required content through credible private readback.
6. Run independent clone-only recovery, credential reentry, billing lifecycle and
   quota continuity checks; validate real provider transactions, durable distributed
   checkpoints, SSH ACLs, retention and host/power-loss behavior. Publish a reviewed
   release and independently record LifeOS adoption through separately authorized
   work. No publication, live migration, external Git write or milestone GO occurred
   in this source pass.

Tests use synthetic credentials, Stripe SDK test headers/fixture-shaped invoices,
and temporary local bare Git only. They cover wrong/unsigned/stale/tampered
webhooks, unknown identities/prices, duplicate IDs, ordering/backdating, lost commit
acknowledgments, unchanged and advancing periods, tenant theft, permission/quota
checks, rotation, expiry, custody failure, OIDC revoke and a Git-object leakage scan.
They are not captured production Stripe events or certification of a deployed vault.

Validation on 2026-11-07: `npm run check` passed; `node --import tsx --test
tests/*.test.mjs` passed **75/75** (68 prior tests plus seven new adversarial
custody/billing tests); `git diff --check` passed. The suite used host permissions
for local subprocess/loopback access after the sandbox denied Git object scanning.
The existing router Promise-like-handler deprecation warning remains. No test
contacted an external provider or remote. No attestation receipt ID is claimed.
