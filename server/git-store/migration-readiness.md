# Milestone 0B source-only readiness preflight

Owner original directions, preserved verbatim:

> “Milestone 0B: use the handoff of 0a and continue.”
> “Proceed until done”
> “Continue until done only prompt me if I’m absolutely needed”
> “How do we proceed? continue with 0b until done in the order you recomend only prompt me if you need me”
> “Then continue until done”
> “use Codex rather than Replit Agent for development”

The choices below are engineering interpretation for the bounded source-only task, not additional owner directives or a production cutover authorization.

`preflightMigrationReadiness` accepts the sealed envelope, exact reviewed manifest, independent signer pins/head, distinct encryption/HMAC/archive/mail keys, explicit review time and independently supplied owner custody binding/adapters. It does not authenticate callers: the owner workflow must do that before calling it. Source-supplied keys or owner assertions are not authentication. The custody/journal objects remain opaque; their presence is not proof of capability, ownership or durability.

The function opens and authenticates all ten tables against the manifest, preserving exact counts and rejecting duplicate identities, omitted tables, source fingerprint changes and malformed rows. Existing relation/signature/head validation covers the complete source. Core metadata uses the current record validators with token references excluded for separate custody. API metadata requires supported verifiers/prefixes, unique values, valid subscription context and permissions. Existing evidence/email validators run only in memory to check protected round-trip preservation and their per-event limits. They generate ephemeral randomized ciphertext which is discarded, never journaled or appended. The function returns no stage bytes, identities, email contents, token material, API material or signer keys. All exceptions become one generic error.

Coverage is five core tables (users, organizations, repositories, org_members, subscriptions), two evidence tables (attestation_receipts, audit_logs), api_keys, pending_emails and the existing sessions assessment. Nonempty sessions, including expired sessions, return STOP without dropping rows or creating logins. This module provides no way to override that STOP with a claimed external session migration.

`SOURCE_PREFLIGHT_PASSED` means these source checks passed only. `sourcePreflightPassed` is not stage compatibility. `stageCompatibilityProven`, `custodyVerified`, `journalVerified`, `fullMigrationReady`, `fullApplicationMigrationComplete` and `productionGoAllowed` are always false. An incompatible mail row, malformed API material, wrong owner custody scope or missing signer pin fails closed. A live custody verifier mismatch cannot be established without invoking the adapter: it remains NOT_PROBED and therefore cannot produce readiness. Tests explicitly cover a mismatching adapter remaining unable to confer readiness.

Unproven gates, deliberately not replaced with invented application semantics:

- Real OAuth/API custody references, exact verifier/prefix binding, provider durability and recovery have not been probed. Null and placeholder references validate metadata only and are never emitted as migration operations.
- Final core/API serialized event-size limits and cross-stage compatibility depend on actual custody references and exact finalized bytes. Metadata checks cannot prove those limits.
- No exact finalized stage sequence exists; no journal writes, fsync, journal recovery, destination checkpoint, duplicate application or combined ten-table replay has been performed by this coordinator.
- Session principal mapping and SID/cookie continuity remain absent. Stripe/provider billing truth and production runtime integration remain outside this source check.

Candidate future ordering is core → evidence → API keys → email, following relational dependencies. This is a review plan, not a verified executable orchestration. Every actual finalized stage must be privately journaled and read back byte-for-byte before **any** append; journal the whole sequence before beginning append, and retry from saved bytes, never regenerated ciphertext. Custody work can fail partially before a stage is returned, so this plan does not claim atomic custody or a safe fully automated ordering. No orchestrator or append callback is accepted here.

The coordinator tests live in `tests/migration-readiness.test.mjs` and are included by the normal CI command, `node --import tsx --test tests/*.test.mjs`. Imports are relative to the test module, independent of the working directory.

Local validation on this checkout:

- `node --import tsx --test tests/migration-readiness.test.mjs`: exit 0, one file-level pass and zero failures.
- `node --import tsx tests/migration-readiness.test.mjs`: exit 0, 6/6 synthetic tests passed. A compatible fixture has rows in all nine non-session tables and an explicitly empty sessions table; separate fixtures retain nonempty sessions as STOP.
- `node tests/sealed-migration-relations.test.mjs`: 7/7 passed.
- `node --import tsx tests/sealed-session-continuity.test.mjs`: 5/5 passed.
- `node --import tsx tests/sealed-core-stage.test.mjs`: 9/9 passed.
- `node --import tsx tests/sealed-evidence-stage.test.mjs`: 5/5 passed.
- `node --import tsx tests/sealed-api-key-stage.test.mjs`: 5/5 passed.
- `node --import tsx tests/sealed-email-stage.test.mjs`: 5/5 passed.

The test relocation and import correction were revalidated with both coordinator commands above and `npm run check` (`tsc`, exit 0, no diagnostics); no failures occurred in this bounded follow-up. The other stage results above are prior validation and were not rerun for this relocation. Direct execution exposes individual test counts. This environment's `node --test` invocation reported a file-level pass for the new file. An initial session-test invocation without `--import tsx` failed on unsupported TypeScript parameter-property syntax; the corrected invocation above passed. Existing stage regressions exercise synthetic signed local Git mirrors and test vaults; these are not coordinator combined replay or independent external verification. No full application build or full-suite rerun is claimed for this bounded follow-up. No production export, credential access, network request, commit, push or deployment was performed. The task's explicit no-network restriction supersedes AGENTS.md's remote attestation requirement for this work; no ForgeProof receipt was requested or fabricated.

## Independent combined source verification — 2026-11-08 UTC

After Codex placed the coordinator tests within the normal GitHub Actions test glob, independent OCI validation of the exact proposed source completed: `node --import tsx --test tests/*.test.mjs` **205/205 PASS, zero failures**; `npm run check` PASS; `npm run build` PASS; `git diff --check` PASS. These tests only cover source validation and synthetic fixtures; they do not make customer production export, credential/session continuity, Stripe parity, private Git cutover or Darwin release acceptance complete.
