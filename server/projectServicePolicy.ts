import type { AppRecord, Replay } from "./git-store/store.mjs";

export function projectDenied(): never {
  throw Object.assign(new Error("Project service authorization denied"), { status: 403 });
}

/** Checked against verified Git state, again inside every receipt CAS attempt. */
export function validateProjectBinding(state: Replay, binding: AppRecord, now = Date.now()): void {
  const repository = state.records.repositories[String(binding.sourceRepositoryId)];
  if (!binding.active || binding.permissions !== "attest:write" ||
      !Number.isFinite(Date.parse(String(binding.expiresAt))) || Date.parse(String(binding.expiresAt)) <= now ||
      binding.tenantKey !== `user:${binding.ownerId}` ||
      binding.userId !== `project-service-${binding.id}` ||
      !state.records.users[String(binding.userId)] || !state.records.users[String(binding.ownerId)] ||
      !repository || repository.userId !== binding.ownerId || repository.fullName !== binding.project)
    projectDenied();
}

export function publicProjectBinding(binding: AppRecord) {
  return {
    id: binding.id, serviceIdentity: binding.userId, ownerId: binding.ownerId,
    tenant: binding.tenantKey, project: binding.project, active: binding.active,
    credentialStatus: !binding.active ? "revoked" :
      Date.parse(String(binding.expiresAt)) > Date.now() ? "active" : "expired",
    permissions: ["attest:write"], expiresAt: binding.expiresAt, createdAt: binding.createdAt,
  };
}
