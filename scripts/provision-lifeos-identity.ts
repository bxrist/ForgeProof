import { open, unlink } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { and, eq } from "drizzle-orm";
import { db, pool } from "../server/db";
import { generateApiKey } from "../server/crypto";
import { apiKeys, auditLogs, subscriptions, users } from "../shared/schema";

export const LIFEOS_USER_ID = "lifeos-service-0a";
const SERVICE_LABEL = { firstName: "LifeOS", lastName: "Service" } as const;
const AUDIT_ACTION = "lifeos_identity_provisioned";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ProvisionDeps = {
  db: typeof db;
  makeApiKey: typeof generateApiKey;
  writeSecret: (path: string, secret: string, onCreated: () => void) => Promise<void>;
  removeSecret: (path: string) => Promise<void>;
};

const realDeps: ProvisionDeps = {
  db,
  makeApiKey: generateApiKey,
  async writeSecret(path, secret, onCreated) {
    const file = await open(path, "wx", 0o600);
    onCreated();
    try {
      await file.writeFile(`${secret}\n`, { encoding: "utf8" });
      await file.chmod(0o600);
    } finally {
      await file.close();
    }
  },
  async removeSecret(path) { await unlink(path); },
};

function assertCleanUser(user: typeof users.$inferSelect | undefined) {
  if (!user) return;
  if (user.id !== LIFEOS_USER_ID || user.firstName !== SERVICE_LABEL.firstName || user.lastName !== SERVICE_LABEL.lastName) {
    throw new Error(`Refusing user ID collision: ${LIFEOS_USER_ID} must have the exact LifeOS Service label.`);
  }
  throw new Error("The LifeOS service identity already exists; provisioning is one-time and will not modify it.");
}

async function assertNoPriorRows(tx: Tx) {
  const [priorSubscription] = await tx.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.userId, LIFEOS_USER_ID)).limit(1);
  const [priorKey] = await tx.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.userId, LIFEOS_USER_ID)).limit(1);
  const [priorAudit] = await tx.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.userId, LIFEOS_USER_ID), eq(auditLogs.action, AUDIT_ACTION))).limit(1);
  if (priorSubscription || priorKey || priorAudit) throw new Error("Refusing unexpected prior entitlement, API key, or provisioning audit for the service identity.");
}

export async function provisionLifeosIdentity(
  options: { apply: boolean; secretFile: string },
  deps: ProvisionDeps = realDeps,
) {
  if (!isAbsolute(options.secretFile)) throw new Error("--secret-file must be an absolute path.");
  const secretPath = resolve(options.secretFile);
  const preview = {
    mode: options.apply ? "apply" : "dry-run",
    userId: LIFEOS_USER_ID,
    serviceLabel: "LifeOS Service",
    operation: "create one user, one API key, one free unlimited entitlement, and one audit record",
    plan: "free", status: "active", attestationLimit: -1, apiKeyLimit: -1,
    stripeCustomerId: null, stripeSubscriptionId: null,
    permissions: ["attest:write", "attest:read"], secretFile: secretPath,
  };

  // Dry run verifies existing state and never creates or discloses a key.
  if (!options.apply) {
    const [existingUser] = await deps.db.select().from(users).where(eq(users.id, LIFEOS_USER_ID)).limit(1);
    assertCleanUser(existingUser);
    await deps.db.transaction(async (tx) => assertNoPriorRows(tx));
    return preview;
  }

  let secretCreated = false;
  try {
    const key = deps.makeApiKey();
    const result = await deps.db.transaction(async (tx) => {
      const [existingUser] = await tx.select().from(users).where(eq(users.id, LIFEOS_USER_ID)).limit(1);
      assertCleanUser(existingUser);
      await assertNoPriorRows(tx);

      const [createdUser] = await tx.insert(users).values({
        id: LIFEOS_USER_ID,
        firstName: SERVICE_LABEL.firstName,
        lastName: SERVICE_LABEL.lastName,
        email: null,
        stripeCustomerId: null,
      }).returning({ id: users.id, firstName: users.firstName, lastName: users.lastName, stripeCustomerId: users.stripeCustomerId });
      if (createdUser?.id !== LIFEOS_USER_ID || createdUser.firstName !== "LifeOS" || createdUser.lastName !== "Service" || createdUser.stripeCustomerId !== null) {
        throw new Error("Created identity readback did not match the exact service identity contract.");
      }

      // Recheck membership immediately before assigning the no-charge entitlement.
      const [membership] = await tx.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, stripeCustomerId: users.stripeCustomerId }).from(users).where(eq(users.id, LIFEOS_USER_ID)).limit(1);
      if (!membership || membership.firstName !== "LifeOS" || membership.lastName !== "Service" || membership.stripeCustomerId !== null) {
        throw new Error("Exact LifeOS Service membership could not be verified; refusing entitlement.");
      }

      await tx.insert(apiKeys).values({
        userId: LIFEOS_USER_ID, name: "LifeOS Milestone 0A service key",
        keyHash: key.keyHash, keyPrefix: key.keyPrefix,
        permissions: ["attest:write", "attest:read"], isActive: true,
      });
      await tx.insert(subscriptions).values({
        userId: LIFEOS_USER_ID, plan: "free", status: "active", attestationLimit: -1,
        attestationCount: 0, apiKeyLimit: -1, stripeCustomerId: null, stripeSubscriptionId: null,
      });
      await tx.insert(auditLogs).values({
        userId: LIFEOS_USER_ID, action: AUDIT_ACTION, resourceType: "service_identity",
        resourceId: LIFEOS_USER_ID,
        metadata: { plan: "free", status: "active", attestationLimit: -1, apiKeyLimit: -1, stripeCustomerId: null, stripeSubscriptionId: null, keyPrefix: key.keyPrefix },
      });

      // Create the operator's only plaintext copy before commit; a transaction failure removes it.
      await deps.writeSecret(secretPath, key.fullKey, () => { secretCreated = true; });

      const [savedKey] = await tx.select({ id: apiKeys.id, userId: apiKeys.userId, keyPrefix: apiKeys.keyPrefix, permissions: apiKeys.permissions }).from(apiKeys).where(eq(apiKeys.userId, LIFEOS_USER_ID)).limit(1);
      const [savedEntitlement] = await tx.select({ id: subscriptions.id, plan: subscriptions.plan, status: subscriptions.status, attestationLimit: subscriptions.attestationLimit, apiKeyLimit: subscriptions.apiKeyLimit, stripeCustomerId: subscriptions.stripeCustomerId, stripeSubscriptionId: subscriptions.stripeSubscriptionId }).from(subscriptions).where(eq(subscriptions.userId, LIFEOS_USER_ID)).limit(1);
      if (!savedKey || savedKey.keyPrefix !== key.keyPrefix || JSON.stringify(savedKey.permissions) !== JSON.stringify(["attest:write", "attest:read"]) || !savedEntitlement || savedEntitlement.plan !== "free" || savedEntitlement.status !== "active" || savedEntitlement.attestationLimit !== -1 || savedEntitlement.apiKeyLimit !== -1 || savedEntitlement.stripeCustomerId !== null || savedEntitlement.stripeSubscriptionId !== null) {
        throw new Error("Provisioned identity readback failed contract verification.");
      }
      return { userId: createdUser.id, keyId: savedKey.id, keyPrefix: savedKey.keyPrefix, subscriptionId: savedEntitlement.id };
    });
    return { ...preview, result };
  } catch (error) {
    if (secretCreated) {
      try {
        await deps.removeSecret(secretPath);
      } catch (cleanupError) {
        const detail = cleanupError instanceof Error ? cleanupError.message : "unknown cleanup error";
        throw new Error(`Provisioning failed and secret-file cleanup also failed for ${secretPath}: ${detail}`, { cause: error });
      }
    }
    throw error;
  }
}

function parseArgs(argv: string[]) {
  let apply = false;
  let secretFile: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apply" && !apply) apply = true;
    else if (argv[i] === "--secret-file" && !secretFile && argv[i + 1]) secretFile = argv[++i];
    else throw new Error("Usage: npx tsx scripts/provision-lifeos-identity.ts --secret-file /absolute/path [--apply]");
  }
  if (!secretFile || !isAbsolute(secretFile)) throw new Error("Usage: npx tsx scripts/provision-lifeos-identity.ts --secret-file /absolute/path [--apply]");
  return { apply, secretFile };
}

if (process.argv[1]?.endsWith("provision-lifeos-identity.ts")) {
  provisionLifeosIdentity(parseArgs(process.argv.slice(2)))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "Provisioning failed.");
      process.exitCode = 1;
    })
    .finally(async () => { await pool.end(); });
}
