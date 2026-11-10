# Separate public GitHub App — configuration and verification

This is an additive integration. Do not change the existing OAuth App, its
Marketplace draft, GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET, the legacy
/api/github/callback, Clerk providers, Stripe prices/subscriptions/webhooks,
or the connector used by the private Git evidence store.

## Registration (GitHub owner action, not performed by this code)

Create a **separate public GitHub App** under the intended GitHub owner.
The existing draft belongs to the production OAuth App; leave it intact.
Associate any new Marketplace listing with the new GitHub App, not that draft.
No new price or paid Marketplace plan is needed to validate this integration.

Use the deployment's verified public origin as `<origin>` (currently
https://forgeproof.flyingcloudtech.com). Do not use a preview origin for the
production registration.

* Homepage: `<origin>/`
* User authorization callback: `<origin>/api/github-app/callback`
* Setup URL: `<origin>/api/github-app/setup`
* Webhook URL: `<origin>/api/github-app/webhook`
* Webhook content type: application/json; SSL verification enabled.
* Use the separate user-authorization callback after setup. Do not configure
  installation to skip setup in favor of an automatic OAuth redirect.
* Enable redirect on installation updates where GitHub offers it.
* Repository permissions: **Contents: read**, **Metadata: read**.
* Organization permissions: **Members: read**, needed to verify that a person
  linking an organization installation is an active organization administrator.
* No repository write, administration, actions, issues, or billing permissions.
* Subscribe to installation / installation-repositories lifecycle events.
  Enable Marketplace purchase events on the new listing when available.
  Do not point the new App at the legacy push webhook.
* Prefer “Only select repositories” during installation. Customers explicitly
  control their selected repositories. Do not install it on ForgeProof's private
  evidence repository merely to operate the store—the existing connector does that.

Repository writes / automatic push attestations are intentionally not implemented
by this read-only App. The legacy OAuth receipt-export flow remains available.

## Separate configuration

Set configuration through the workspace's secure settings; never paste secrets
into source, documentation, requests, or chat.

| Variable | Value |
| --- | --- |
| FORGEPROOF_GITHUB_APP_ID | Numeric ID of the NEW GitHub App |
| FORGEPROOF_GITHUB_APP_CLIENT_ID | Client ID of the NEW GitHub App |
| FORGEPROOF_GITHUB_APP_CLIENT_SECRET | Client secret of the NEW GitHub App |
| FORGEPROOF_GITHUB_APP_PRIVATE_KEY | RSA private key generated for the NEW GitHub App; PEM, actual newlines or escaped `\n` |
| FORGEPROOF_GITHUB_APP_WEBHOOK_SECRET | Separate webhook secret, identical in this app and the new GitHub App webhook settings |
| FORGEPROOF_GITHUB_APP_SLUG | New App slug from its GitHub URL |
| FORGEPROOF_GITHUB_APP_PUBLIC_ORIGIN | Exact HTTPS origin, no trailing slash; must match browser origin and registered callback |

The code never falls back to old OAuth credentials or to the receipt signer.
`GET /app` checks App ID, slug, client ID, signing key and read-only permissions
before connection or webhook processing. User authorization verifies the client
secret. A signed webhook delivery verifies the separately configured webhook
secret. Presence of environment variables alone is not a successful live check.

Missing credentials disable only the new integration. The legacy SQL development
preview also shows it as unavailable: its business state uses the existing Git
runtime, never a newly required PostgreSQL table or database migration.

## Customer flow

1. Sign in through existing Clerk and open Dashboard → Repositories.
2. Use the separate GitHub App connection control. Choose repositories on GitHub.
3. Setup creates a user-bound authorization state. The App callback verifies
   access to the installation and account ownership (or organization admin role).
4. An installation/account cannot be linked to a different ForgeProof customer
   without first unlinking it. Merely knowing installation/account IDs grants nothing.
5. Refresh reconciles the current repository selection; Unlink removes local
   access but does not uninstall the App at GitHub. Manage/uninstall through GitHub.

Marketplace-originated installations without a ForgeProof state are supported
after Clerk sign-in: setup still requires a fresh, user-bound GitHub App
authorization round trip. If a customer reaches setup signed out, sign in to
ForgeProof and retry the setup URL or start the dashboard connection flow.

Optional read API:
`GET /api/github-app/installations/:id/repositories/:repoId/contents?path=<file>&ref=<full-40-char-commit>`

Requires the linked customer and active installation. It rechecks GitHub repository
access and mints a repository-specific, read-only installation token. Tokens are
never returned or persisted; supported file responses are at most 1 MiB. There is
no new receipt creation, source modification, or automatic provenance claim.

## Event semantics and commercial boundary

Webhook verification uses the exact raw request bytes and HMAC-SHA256 before any
provider fetch or Git mutation. Separate persistent delivery records make duplicate
deliveries idempotent; conflicting bodies with the same delivery ID are rejected.
Only normalized IDs, repository metadata, state hashes and purchase summaries are
stored—not raw webhook bodies, user tokens, keys, emails, or payment instruments.

Installation/repository events fetch current state from GitHub, preventing delayed
events from restoring removed access. Suspension clears accessible repositories.
A current GitHub 404 marks an installation deleted. Concurrent changes reject stale
snapshots and require retry; failed reconciliation is not acknowledged as success.
GitHub does not guarantee automatic webhook redelivery: use its delivery UI to
redeliver failed deliveries. Customer Refresh also reconciles installation state.

Marketplace actions: purchased, changed, cancelled, pending_change,
pending_change_cancelled. The server verifies the current purchase through
`GET /marketplace_listing/accounts/:account_id` authenticated as the new App.
Upcoming plan changes remain pending. A 404 means no current subscription.
Events arriving before account linking remain unassigned and become visible only
through a subsequently verified installation/account association.

These are **Marketplace observations, not ForgeProof paid entitlements**.
`billingActivated` is always false—even for verified events. Stripe remains the
sole existing commercial billing authority. Nothing creates a price, charges a
customer, updates a Stripe subscription, cancels a plan, or increases quotas.
The unverified webhook path performs no business-state writes.

## Verification before a separately authorized publish

Unit/route tests use isolated fixture identities and provider responses; the Git
replay test uses a disposable bare repository. They do not prove real registration.

Required real checks, once the new registration and credentials exist:

1. Match the registration's App ID, client ID, slug and private key via `/app`.
2. Complete an authorized test installation and App user-authorization callback.
3. Confirm only selected repositories are visible; test a removed repository,
   suspended installation, second-customer denial, and local unlink.
4. Deliver a genuine signed event to the NEW webhook URL, verify its delivery
   record, then redeliver it and confirm a duplicate acknowledgment.
5. Exercise Marketplace test events belonging to the NEW listing. If GitHub's
   Marketplace stub endpoints are needed, use an isolated test harness; this
   runtime deliberately uses real endpoints and does not label stub data live.
6. Confirm the old OAuth connection and existing Stripe regression checks still pass.

No live deployment change or publish was performed as part of this implementation.
The owner explicitly requires registration and credentials to be correctly matched
and verified before production is republished. No extra staging requirement is added.

The new Git record class is additive and old signed history replays unchanged.
After the first new record is written, older binaries that do not recognize this
class cannot replay it; do not roll back to such a binary or rewrite Git history.
Keep an updated reader when disabling the integration.

## Listing URLs still needed

Existing public pages: homepage `/`, `/demo`, `/sdk`, `/threat-model`, `/glossary`,
`/sign-up`, `/sign-in`; machine docs `/api/openapi.json`, `/api/mcp/manifest`.
Dedicated public support, privacy and terms pages were not added in this narrowly
scoped integration. Supply owner-approved URLs/content as required by GitHub's
listing review. Registration/listing approval is a GitHub action, not a code test.

References:
https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app
https://docs.github.com/en/rest/apps/installations
https://docs.github.com/en/rest/apps/marketplace
https://docs.github.com/en/webhooks/webhook-events-and-payloads
