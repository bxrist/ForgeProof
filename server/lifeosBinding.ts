import { GitStorage } from "./git-store/storage";
import { restoreProtectedAuditLog } from "./git-store/protected-audit.mjs";
import { installProtectedLifeosApproval, validateLifeosApproval } from "./lifeosApproval";
import { projectIdSchema } from "./lifeosLifecycle";
import type { createGitHubStore } from "./git-store/githubRuntime";
import type { Replay } from "./git-store/store.mjs";

type Resources = ReturnType<typeof createGitHubStore>;
const SUBJECT = "lifeos-service-0a";
const ACTION = "lifeos.owner_approval";
class BindingEligibilityError extends Error {
  constructor(readonly category: LifeosBindingFailure, message: string) { super(message); }
}
function eligible(resources: Resources, state: Replay) {
  const owner = resources.settings.guardUserId, user = state.records.users[SUBJECT];
  if (!user || owner === SUBJECT || !state.records.users[owner])
    throw new BindingEligibilityError("identity_binding", "Existing distinct service and owner required");
  const sub = Object.values(state.records.subscriptions).find(s => s.userId === SUBJECT);
  if (user.stripeCustomerId || user.githubTokenRef ||
      (sub && (sub.plan !== "free" || sub.stripeCustomerId || sub.stripeSubscriptionId)))
    throw new BindingEligibilityError("commercial_association", "Service must remain non-commercial");
  const active = Object.values(state.records.apiKeys).filter(k => k.userId === SUBJECT && k.isActive &&
    (!k.expiresAt || Date.parse(String(k.expiresAt)) > Date.now()));
  const key = active[0];
  const message = "One existing unexpired attest:write-only key required";
  if (active.length !== 1) throw new BindingEligibilityError("active_key_count", message);
  if (!key.expiresAt || !Number.isFinite(Date.parse(String(key.expiresAt))))
    throw new BindingEligibilityError("key_expiry", message);
  if (!Array.isArray(key.permissions) || key.permissions.length !== 1 || key.permissions[0] !== "attest:write")
    throw new BindingEligibilityError("key_permissions", message);
  if (typeof key.credentialRef !== "string") throw new BindingEligibilityError("credential_reference", message);
  return { owner, key };
}
function readAudit(resources: Resources, row: unknown) {
  return JSON.parse(restoreProtectedAuditLog(row, resources.settings.tenant,
    resources.settings.stream, resources.material.auditEncryptionKey).toString("utf8"));
}

/** Owner-authorized server operation, not a public endpoint. No token/hash is returned. */
export async function bindExistingLifeosProject(resources: Resources, project: string, approvalReference: string) {
  projectIdSchema.parse(project);
  if (!approvalReference.trim()) throw new Error("Existing owner authorization reference required");
  const state = await resources.service.replay(), { owner, key } = eligible(resources, state);
  const scope = `${resources.settings.tenant}:${resources.settings.stream}`;
  const ref = await resources.custody.bindLifeosApproval(scope, String(key.credentialRef), {
    service: "lifeos", userId: SUBJECT, apiKeyId: Number(key.id), dedicated: true,
    approvedBySubject: owner, approvedAt: new Date().toISOString(), approvalReference, projects: [project],
  });
  for (const row of Object.values(state.records.auditLogs)) {
    if (!row.auditCore) continue;
    const core = JSON.parse(String(row.auditCore));
    if (core.action !== ACTION || core.userId !== owner) continue;
    const prior = readAudit(resources, row);
    if (prior.metadata?.custodyRef === ref) return { auditId: Number(row.id) };
  }
  const git = new GitStorage(resources.service, owner, Object.keys(state.records.users), owner,
    resources.custody, scope, resources.material.mailEncryptionKey,
    resources.material.auditEncryptionKey, resources.material.receiptEncryptionKey, true);
  const audit = await git.createAuditLog({
    userId: owner, action: ACTION, resourceType: "lifeos-service", resourceId: SUBJECT,
    metadata: { custodyRef: ref, projects: [project], approvalReference }, ipAddress: null,
  });
  return { auditId: audit.id };
}

/** Returns false on invalid optional configuration without taking commercial startup down. */
export type LifeosBindingFailure =
  | "selector_missing" | "runtime_not_production" | "configuration_conflict"
  | "selector_invalid" | "audit_missing" | "service_eligibility"
  | "audit_decryption" | "audit_binding" | "custody_read"
  | "approval_invalid" | "owner_binding" | "key_binding" | "project_binding"
  | "custody_verification" | "verifier_mismatch" | "approval_installation"
  | "identity_binding" | "commercial_association" | "active_key_count"
  | "key_expiry" | "key_permissions" | "credential_reference";
export type LifeosBindingDiagnostic = {
  category: LifeosBindingFailure;
  exception: boolean;
};
/** Diagnostics are fixed labels only: never forward exception messages, IDs or provider responses. */
export async function loadLifeosGitBinding(
  resources: Resources, state: Replay,
  report: (diagnostic: LifeosBindingDiagnostic) => void = () => {},
): Promise<boolean> {
  let category: LifeosBindingFailure = "selector_missing";
  const fail = (code: LifeosBindingFailure, exception = false) => {
    report({ category: code, exception });
    return false;
  };
  try {
    if (!process.env.LIFEOS_OWNER_APPROVAL_AUDIT_ID) return fail("selector_missing");
    installProtectedLifeosApproval(null);
    if (process.env.NODE_ENV !== "production") return fail("runtime_not_production");
    // The signed Git selector is authoritative. Obsolete deployment JSON/file
    // settings cannot override it; all audit/custody/key checks below still apply.
    const id = Number(process.env.LIFEOS_OWNER_APPROVAL_AUDIT_ID);
    if (!Number.isSafeInteger(id) || id <= 0) return fail("selector_invalid");
    if (!state.records.auditLogs[id]) return fail("audit_missing");
    category = "service_eligibility";
    const { owner, key } = eligible(resources, state);
    category = "audit_decryption";
    const audit = readAudit(resources, state.records.auditLogs[id]);
    if (audit.action !== ACTION || audit.userId !== owner || audit.resourceId !== SUBJECT) return fail("audit_binding");
    const scope = `${resources.settings.tenant}:${resources.settings.stream}`;
    category = "custody_read";
    const approval = validateLifeosApproval(await resources.custody.recoverLifeosApproval(scope, audit.metadata?.custodyRef));
    if (!approval) return fail("approval_invalid");
    if (approval.approvedBySubject !== owner) return fail("owner_binding");
    if (approval.apiKeyId !== key.id) return fail("key_binding");
    if (JSON.stringify(approval.projects) !== JSON.stringify(audit.metadata?.projects)) return fail("project_binding");
    category = "custody_verification";
    if (!await resources.custody.matches(scope, String(key.credentialRef), approval.apiKeyHash)) return fail("verifier_mismatch");
    category = "approval_installation";
    installProtectedLifeosApproval(approval);
    return true;
  } catch (error) {
    return error instanceof BindingEligibilityError
      ? fail(error.category) : fail(category, true);
  }
}
