# Milestone 0A service identity operations

ForgeProof already stores users, API keys, and subscriptions separately. A LifeOS integration identity can therefore be scoped to one dedicated user and one active API key; its subscription row can carry an unlimited entitlement (`attestation_limit = -1`, `api_key_limit = -1`) without changing any other customer subscription or Stripe state. The request path enforces the per-user subscription quota.

## Operator setup

The one-time operator script creates the fixed user ID `lifeos-service-0a`, labeled exactly `LifeOS Service`, along with one API key, its free unlimited entitlement, and one audit record in a single PostgreSQL transaction. It creates no email/OAuth identity and no Stripe customer or subscription. It refuses every existing user, key, entitlement, or prior provisioning audit collision for that ID. The API key has only `attest:write` and `attest:read` permissions.

Choose an absolute path in the LifeOS secret store, then preview and apply:

```sh
npx tsx scripts/provision-lifeos-identity.ts --secret-file /absolute/secret/path/FORGEPROOF_API_KEY
npx tsx scripts/provision-lifeos-identity.ts --secret-file /absolute/secret/path/FORGEPROOF_API_KEY --apply
```

Dry-run is the default. `--apply` writes the plaintext key once to the specified path using exclusive creation and mode `0600`; it never prints the key. The path must not already exist. The script reports only deterministic IDs, the key prefix, and billing fields. It uses the existing `free` plan label with `attestation_limit = -1` and `api_key_limit = -1`, which the request path interprets as unlimited. Both Stripe IDs are null. It does not create Stripe objects, change other rows, or modify global billing behavior.

## Rollback

If the command fails, it rolls back its transaction and removes the secret file it created. If an operator needs to undo a successfully provisioned identity, delete only `api_keys`, `subscriptions`, the `lifeos_identity_provisioned` audit row, and `users` rows for `lifeos-service-0a` in one reviewed database transaction, then remove the LifeOS secret. Do not delete rows for any other user. No customer subscription, Stripe object, global billing setting, or infrastructure needs modification.

The service must not be considered active until an operator has provisioned it and independently verified that its key authenticates, its entitlement has no Stripe links and has an audit record, and other customer subscriptions still retain their existing quotas and Stripe linkage. This repository change does not provision production credentials or execute the script against any database.
