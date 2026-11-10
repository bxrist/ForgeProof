import { createHash, randomBytes } from "node:crypto";
import { open, lstat, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import pg from "pg";

const SERVICE = "lifeos-service-0a";
type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };
type ProvisionDeps = {
  client: Queryable;
  writeSecret: (path: string, token: string) => Promise<() => Promise<void>>;
  token: string;
  now: Date;
};

export async function exclusiveSecretFile(path: string, token: string): Promise<() => Promise<void>> {
  const handle = await open(path, "wx", 0o600);
  const created = await handle.stat();
  try { await handle.writeFile(`${token}\n`, { encoding: "utf8" }); await handle.sync(); }
  catch (error) { await handle.close();
    const current = await lstat(path).catch(() => null);
    if (current && current.dev === created.dev && current.ino === created.ino) await unlink(path).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return async () => {
    const current = await lstat(path).catch(() => null);
    if (current && current.dev === created.dev && current.ino === created.ino) await unlink(path);
  };
}

export async function provisionLifeos(input: {
  apply: boolean; ownerSubject: string; approvalReference: string; secretFile: string; expiresAt: Date;
  productionVerified: boolean;
}, deps: ProvisionDeps) {
  if (!input.ownerSubject.trim() || input.ownerSubject === SERVICE || !input.approvalReference.trim()) throw new Error("A separate approving owner and audit reference are required");
  if (!isAbsolute(input.secretFile)) throw new Error("Secret file path must be absolute");
  if (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= deps.now) throw new Error("Key expiration must be in the future");
  if (input.apply && !input.productionVerified) throw new Error("--apply requires independent database identity and operator confirmation");
  const hash = createHash("sha256").update(deps.token).digest("hex");
  let transaction = false;
  let cleanupSecret: (() => Promise<void>) | null = null;
  let commitAmbiguous = false;
  let rollbackConfirmed = false;
  try {
    if (input.apply) { await deps.client.query("BEGIN"); transaction = true; }
    const lock = "SELECT pg_advisory_xact_lock(hashtext($1))";
    if (input.apply) await deps.client.query(lock, [SERVICE]);
    const [serviceRows, ownerRows] = await Promise.all([
      deps.client.query(`SELECT id FROM users WHERE id = $1${input.apply ? " FOR UPDATE" : ""}`, [SERVICE]),
      deps.client.query(`SELECT id FROM users WHERE id = $1${input.apply ? " FOR SHARE" : ""}`, [input.ownerSubject]),
    ]);
    const service = serviceRows.rows[0];
    const owner = ownerRows.rows[0];
    if (!owner) throw new Error("Separate approving owner must already exist");
    if (service) throw new Error("Dedicated service identity already exists; refusing subject collision");
    const [subs, keys] = await Promise.all([
      deps.client.query(`SELECT id FROM subscriptions WHERE user_id = $1${input.apply ? " FOR UPDATE" : ""}`, [SERVICE]),
      deps.client.query(`SELECT id FROM api_keys WHERE user_id = $1${input.apply ? " FOR UPDATE" : ""}`, [SERVICE]),
    ]);
    if (subs.rows.length) throw new Error("Service identity has a subscription collision; refusing provisioning");
    if (keys.rows.length) throw new Error("Service identity already has an API key; refusing collision");
    const collision = await deps.client.query("SELECT id FROM api_keys WHERE key_hash = $1", [hash]);
    if (collision.rows.length) throw new Error("Generated API key hash collision");
    const auditCollision = await deps.client.query("SELECT id FROM audit_logs WHERE action = $1 AND metadata->>'approvalReference' = $2", ["lifeos.identity.provisioned", input.approvalReference]);
    if (auditCollision.rows.length) throw new Error("Provisioning audit reference collision; refusing provisioning");
    if (!input.apply) return { status: "dry-run-ready", expected: { createSubject: SERVICE, createInactiveKey: true, permissions: ["attest:write"], ownerSubject: owner.id, ownerCheck: "existing-separate-owner-verified", expiresAt: input.expiresAt.toISOString() } };

    await deps.client.query(
      `INSERT INTO users (id, email, first_name, last_name, profile_image_url, github_token, github_username,
                          notification_email, notify_on_git_failure, stripe_customer_id, default_repo_id,
                          detail_repo_id, last_active_tab)
       VALUES ($1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL)`, [SERVICE],
    );

    cleanupSecret = await deps.writeSecret(input.secretFile, deps.token);
    const inserted = await deps.client.query(
      `INSERT INTO api_keys (user_id, name, key_hash, key_prefix, permissions, is_active, expires_at)
       VALUES ($1, 'LifeOS service 0A', $2, $3, ARRAY['attest:write'], false, $4) RETURNING id`,
      [SERVICE, hash, deps.token.substring(0, 12), input.expiresAt],
    );
    const keyId = inserted.rows[0]?.id;
    if (!Number.isSafeInteger(Number(keyId)) || Number(keyId) <= 0) throw new Error("API key insert returned invalid ID");
    await deps.client.query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, metadata)
       VALUES ($1, 'lifeos.identity.provisioned', 'api_key', $2, $3::jsonb)`,
      [input.ownerSubject, String(keyId), JSON.stringify({ serviceSubject: SERVICE, approvalReference: input.approvalReference, active: false, permission: "attest:write" })],
    );
    try {
      await deps.client.query("COMMIT"); transaction = false;
    } catch {
      // COMMIT may have reached the server. Do not remove the secret or claim rollback.
      transaction = false;
      commitAmbiguous = true;
      throw new Error("Commit outcome ambiguous; preserve the secret file and reconcile the inactive key by service subject/audit reference");
    }
    return { status: "provisioned-inactive", subject: SERVICE, apiKeyId: Number(keyId), expiresAt: input.expiresAt.toISOString(), secretFile: input.secretFile };
  } catch (error) {
    if (transaction) {
      try { await deps.client.query("ROLLBACK"); rollbackConfirmed = true; }
      catch { /* preserve secret whenever database outcome is uncertain */ }
    }
    if (cleanupSecret && rollbackConfirmed && !commitAmbiguous) await cleanupSecret().catch(() => undefined);
    throw error;
  }
}

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; }
async function main() {
  const apply = process.argv.includes("--apply");
  const databaseUrl = process.env.DATABASE_URL;
  const ownerSubject = arg("--owner-subject");
  const approvalReference = arg("--approval-reference");
  const secretFile = arg("--secret-file");
  const expiresAt = arg("--expires-at");
  const expectedDatabase = arg("--expected-database");
  const expectedHost = arg("--expected-host");
  if (!databaseUrl || !ownerSubject || !approvalReference || !secretFile || !expiresAt) throw new Error("Required: DATABASE_URL, --owner-subject, --approval-reference, --secret-file ABSOLUTE_PATH, --expires-at ISO_DATE");
  if (!isAbsolute(secretFile)) throw new Error("--secret-file must be an absolute path");
  if (apply && (!expectedDatabase || !expectedHost || arg("--confirm-production") !== "I_VERIFIED_THIS_PRODUCTION_TARGET")) {
    throw new Error("--apply requires --expected-database, --expected-host, and explicit operator confirmation");
  }
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  const token = `fp_sk_${randomBytes(32).toString("base64url")}`;
  try {
    const identity = await client.query("SELECT current_database() AS database, inet_server_addr()::text AS host");
    if (apply && (identity.rows[0]?.database !== expectedDatabase || identity.rows[0]?.host !== expectedHost)) throw new Error("Read-only database identity does not match operator-confirmed target");
    const result = await provisionLifeos({ apply, ownerSubject, approvalReference, secretFile, expiresAt: new Date(expiresAt), productionVerified: apply && !!expectedDatabase && !!expectedHost }, { client, writeSecret: exclusiveSecretFile, token, now: new Date() });
    console.log(JSON.stringify(result));
    if (!apply) console.log("Dry-run only; no database writes or secret file created. Repeat with --apply only from the explicitly verified production runtime.");
  } finally { client.release(); await pool.end(); }
}

if (process.argv[1]?.endsWith("provision-lifeos.ts")) main().catch((error) => { console.error(error instanceof Error ? error.message : "Provisioning failed"); process.exitCode = 1; });
