/**
 * One-time cutover of the live production SQL state into the private GitHub
 * Git store. Input is a JSON export of production rows (path in argv[2]); it is
 * never committed. Receipts keep their original signatures byte-for-byte;
 * nothing is re-signed or fabricated. Idempotent: rerunning returns duplicate.
 *
 * Run with NODE_ENV=production so the production signer secret is used.
 */
import { readFileSync } from "node:fs";
import { createGitHubStore } from "../server/git-store/githubRuntime";
import { protectLegacyReceipt } from "../server/git-store/protected-receipt.mjs";
import { EncryptedProviderCustodian } from "../server/git-store/custody";
import { protectLegacyAuditLog } from "../server/git-store/protected-audit.mjs";

type Row = Record<string, any>;
const iso = (v: unknown) => (v == null ? null : new Date(/[zZ]|[+-]\d\d:\d\d$/.test(String(v)) ? String(v) : String(v) + "Z").toISOString());
const txt = (v: unknown) => (v == null || v === "" ? null : String(v));
const strip = <T extends Row>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null)) as T;

async function main() {
  const rows = JSON.parse(readFileSync(process.argv[2], "utf8")) as Record<string, Row[]>;
  const dryRun = process.argv[3] === "--dry-run";
  const { settings, service, custody: remoteCustody, material } = createGitHubStore();
  const memory = new Map<string, string>();
  const custody = dryRun ? new EncryptedProviderCustodian({ transact: async (ns, change) => { const r = change(memory.get(ns)); memory.set(ns, r.envelope); return r.result; } }, material.custodyKey) : remoteCustody;
  const scope = `${settings.tenant}:${settings.stream}`;
  const ops: any[] = [];
  const put = (kind: string, id: string | number, record: Row) => ops.push({ kind, id, action: "put", expectedVersion: null, record: strip({ ...record, id }) });

  for (const u of rows.users) put("users", u.id, {
    email: txt(u.email), firstName: txt(u.first_name), lastName: txt(u.last_name), profileImageUrl: txt(u.profile_image_url),
    githubUsername: txt(u.github_username), notificationEmail: txt(u.notification_email), notifyOnGitFailure: u.notify_on_git_failure ?? null,
    stripeCustomerId: txt(u.stripe_customer_id), defaultRepoId: txt(u.default_repo_id), detailRepoId: txt(u.detail_repo_id),
    lastActiveTab: txt(u.last_active_tab), createdAt: iso(u.created_at), updatedAt: iso(u.updated_at),
  });
  if (rows.users.some(u => u.github_token)) throw new Error("GitHub OAuth tokens present; stage them in custody before cutover");
  for (const o of rows.organizations) put("organizations", o.id, { name: o.name, slug: o.slug, ownerId: o.owner_id, description: txt(o.description), createdAt: iso(o.created_at) });
  for (const m of rows.org_members) put("orgMembers", m.id, { orgId: m.org_id, userId: m.user_id, role: m.role, createdAt: iso(m.created_at) });
  for (const r of rows.repositories) put("repositories", r.id, {
    userId: r.user_id, orgId: r.org_id ?? null, githubId: r.github_id, name: r.name, fullName: r.full_name, url: r.url,
    defaultBranch: txt(r.default_branch), description: txt(r.description), lastSyncedAt: iso(r.last_synced_at), createdAt: iso(r.created_at),
  });
  for (const s of rows.subscriptions) put("subscriptions", s.id, {
    userId: s.user_id, orgId: s.org_id ?? null, stripeCustomerId: txt(s.stripe_customer_id), stripeSubscriptionId: txt(s.stripe_subscription_id),
    plan: s.plan, status: s.status, currentPeriodStart: iso(s.current_period_start), currentPeriodEnd: iso(s.current_period_end),
    attestationLimit: s.attestation_limit, attestationCount: s.attestation_count, apiKeyLimit: s.api_key_limit, createdAt: iso(s.created_at),
  });
  // API key verifiers move into encrypted custody; the plaintext key never existed server-side.
  for (const k of rows.api_keys) {
    const credentialRef = await custody.stage(scope, `${k.user_id}:migrated-api-key:${k.id}`, { kind: "api-key", verifier: k.key_hash, prefix: k.key_prefix });
    put("apiKeys", k.id, {
      userId: k.user_id, name: k.name, permissions: k.permissions, isActive: k.is_active, lastUsedAt: iso(k.last_used_at),
      expiresAt: iso(k.expires_at), credentialRef, createdAt: iso(k.created_at),
    });
  }
  for (const p of rows.service_dashboard_principals) put("serviceDashboardPrincipals", p.issuer_id, { issuerId: p.issuer_id, tenantKey: p.tenant_key });
  for (const b of rows.service_dashboard_bindings) put("serviceDashboardBindings", b.id, {
    issuerId: b.issuer_id, ownerId: b.owner_id ?? null, orgId: b.org_id ?? null, tenantKey: b.tenant_key, scope: b.scope,
    scopeEvidence: b.scope_evidence ?? null, evidence: b.evidence, verifiedBy: b.verified_by, createdAt: iso(b.created_at), revokedAt: iso(b.revoked_at),
  });
  for (const g of rows.service_dashboard_grants) put("serviceDashboardGrants", g.id, {
    bindingId: g.binding_id, receiptId: g.receipt_id, grantedBy: g.granted_by, createdAt: iso(g.created_at), revokedAt: iso(g.revoked_at),
  });
  for (const a of rows.audit_logs) {
    const original = { id: a.id, userId: a.user_id ?? null, action: a.action, resourceType: a.resource_type ?? null, resourceId: a.resource_id ?? null,
      metadata: a.metadata ?? null, ipAddress: a.ip_address ?? null, createdAt: iso(a.created_at) };
    if (original.metadata == null) put("auditLogs", a.id, { userId: original.userId, action: a.action, resourceType: original.resourceType, resourceId: original.resourceId, ipAddress: original.ipAddress, createdAt: original.createdAt });
    else ops.push({ kind: "auditLogs", id: a.id, action: "put", expectedVersion: null,
      record: protectLegacyAuditLog(Buffer.from(JSON.stringify(original)), settings.tenant, settings.stream, material.auditEncryptionKey) });
  }
  // Receipts in chain order, exact signed fields, encrypted originals for unstructured content.
  for (const r of [...rows.attestation_receipts].sort((a, b) => a.id - b.id)) {
    const original = {
      id: r.id, userId: r.user_id, orgId: r.org_id ?? null, repositoryId: r.repository_id ?? null, fileHash: r.file_hash, fileName: r.file_name ?? null,
      filePath: r.file_path, modelName: r.model_name, modelProvider: r.model_provider, countryOfOrigin: r.country_of_origin,
      detectedCountry: r.detected_country ?? null, complianceStatus: r.compliance_status ?? null, attestationType: r.attestation_type ?? null,
      parentAttestationId: r.parent_attestation_id ?? null, auditVerdict: r.audit_verdict ?? null, auditDetails: r.audit_details ?? null,
      signature: r.signature, publicKey: r.public_key, prevEntryHash: r.prev_entry_hash ?? null, entryHash: r.entry_hash,
      receiptVersion: r.receipt_version, signedAt: r.signed_at, gitCommitUrl: r.git_commit_url ?? null, gitCommitMessage: r.git_commit_message ?? null,
      metadata: r.metadata ?? null, createdAt: iso(r.created_at),
    };
    const bytes = JSON.stringify(original);
    ops.push({ kind: "receipts", id: r.id, action: "put", expectedVersion: null,
      record: original.metadata == null && original.auditDetails == null ? { id: r.id, original: bytes }
        : protectLegacyReceipt(Buffer.from(bytes), settings.tenant, settings.stream, material.receiptEncryptionKey) });
  }
  if (dryRun) {
    await service.preflight([{ idempotencyKey: "production-sql-cutover-v1", operations: ops }]);
    console.log(JSON.stringify({ dryRun: true, operations: ops.length, bytes: JSON.stringify(ops).length }));
    return;
  }
  const result = await service.append({ idempotencyKey: "production-sql-cutover-v1", operations: ops });
  const state = await service.replay();
  const counts = Object.fromEntries(Object.entries(state.records).map(([k, v]) => [k, Object.keys(v as object).length]));
  console.log(JSON.stringify({ checkpoint: result.checkpoint, duplicate: result.duplicate, counts, receiptHead: state.receiptHead }));
}
main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
