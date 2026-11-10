import type { IStorage } from "./storage";

/** Runtime shape validation is not proof of backend semantic parity. */
export const legacyStorageMethods = [
  "ensureUser",
  "getUser",
  "updateUser",
  "getRepositories",
  "getRepository",
  "getRepositoryByGithubId",
  "createRepository",
  "updateRepository",
  "updateRepositoryLastSynced",
  "deleteRepository",
  "getAttestations",
  "getSystemAttestations",
  "getAllAttestationsOrdered",
  "getAttestation",
  "getAttestationsByFilePath",
  "getAttestationByEntryHash",
  "getAttestationsByParentId",
  "getLatestAttestation",
  "createAttestation",
  "updateAttestationGitCommitUrl",
  "getApiKeys",
  "getApiKeyByHash",
  "createApiKey",
  "deleteApiKey",
  "updateApiKeyLastUsed",
  "getOrganizations",
  "getOrganization",
  "getOrganizationBySlug",
  "createOrganization",
  "updateOrganization",
  "deleteOrganization",
  "getOrgMembers",
  "getOrgMember",
  "addOrgMember",
  "removeOrgMember",
  "updateOrgMemberRole",
  "createAuditLog",
  "getAuditLogs",
  "getAuditLogsByResource",
  "clearAllAttestations",
  "getSubscription",
  "getSubscriptionByStripeId",
  "getSubscriptionByCustomerId",
  "createSubscription",
  "updateSubscription",
  "incrementAttestationCount",
  "resetAttestationCount",
  "getOrCreateFreeSubscription",
  "createPendingEmail",
  "getDuePendingEmails",
  "updatePendingEmail",
] as const satisfies readonly (keyof IStorage)[];

// Adding an application storage method must also extend runtime validation.
const completeContract: Exclude<keyof IStorage, typeof legacyStorageMethods[number]> extends never ? true : never = true;
void completeContract;

export function validateLegacyStorage(value: unknown): asserts value is IStorage {
  const missing = legacyStorageMethods.filter(name => !value || typeof (value as Record<string, unknown>)[name] !== "function");
  if (missing.length) throw new Error(`Missing legacy IStorage methods: ${missing.join(", ")}`);
}
