# Milestone 0B — Private Application Parity (Protected Envelope v3)

## Status

Implemented protected envelope v3 for private receipt and private audit encryption paths while preserving strict backward compatibility for existing historical signed v2 records.

## Security issue addressed

Previous v2 envelopes exposed an unkeyed `plaintextSha256`. For low-entropy private metadata, an attacker with public redacted core could perform offline candidate reconstruction and hash comparison without decrypting.

v3 removes this oracle by replacing plaintext SHA digest publication with keyed commitment:

- `plaintextHmac: hmac-sha256:<hex>` only
- HMAC key derived from encryption key via HKDF-SHA256
- Independent HKDF purpose/info and static salt for receipt vs audit
- AES-256-GCM remains unchanged for confidentiality/integrity

`ciphertextSha256` remains present and continues to hash ciphertext only.

## Compatibility and protocol rules

### New writes

- `protectLegacyReceipt` now emits `encryption.version = 3`
- `protectLegacyAuditLog` now emits `encryption.version = 3`
- v3 uses 12-byte random nonce and version-specific AAD contexts:
  - receipt: `ForgeProof-protected-receipt-v3`
  - audit: `ForgeProof-protected-audit-v3`

### Historical reads

- `verifyProtectedReceiptCore` and `restoreProtectedReceipt` accept:
  - exact v2 shape with `plaintextSha256`
  - exact v3 shape with `plaintextHmac`
- `verifyProtectedAuditCore` and `restoreProtectedAuditLog` accept:
  - exact v2 shape with `plaintextSha256`
  - exact v3 shape with `plaintextHmac`
- Mixed fields, downgrade confusion, and extra fields are rejected.
- v2 AAD contexts remain unchanged and continue validating historical signed git records.

### Decrypt/restore behavior

- v2 restore: validates `plaintextSha256`
- v3 restore: recomputes keyed HMAC and compares with timing-safe equality
- wrong key, tag, tenant, repository, or core scope fails closed

## Test coverage

Updated and added tests:

- `tests/protected-audit.test.mjs`
  - migrated expectations from v2 plaintext SHA to v3 plaintext HMAC
- `tests/protected-envelope-v3.test.mjs`
  - v3 private receipt no-plaintext-hash regression
  - v3 private audit no-plaintext-hash regression
  - strict mixed/extra field rejection
  - wrong-scope restore failure
  - ciphertext tamper detection
  - synthetic genuine v2 fixture builders for receipt and audit to prove legacy verify+restore
  - v3 signed-event chain stability check using Ed25519 signatures

## Out of scope (unchanged)

No changes to handlers, storage interfaces, source receipt signing trust, database schema, billing, counts, or production migrations.
