// Offline operator tool. Never called by a browser, API key or receipt issuer.
// DATABASE_URL must reference the reviewed deployment's isolated database.
import pg from "pg";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  issuer: { type: "string" }, owner: { type: "string" }, org: { type: "string" },
  scope: { type: "string", default: "selected" }, "scope-evidence": { type: "string" },
  evidence: { type: "string" }, apply: { type: "boolean", default: false },
} });
if (!["selected", "full-service"].includes(values.scope!) ||
    (values.scope === "full-service" ? !values["scope-evidence"]?.trim() : values["scope-evidence"] !== undefined)) {
  throw new Error("Scope must be selected (default) or full-service with explicit --scope-evidence OWNER_APPROVAL_FOR_ALL_HISTORY_AND_FUTURE");
}
if (!values.issuer || values.issuer === "forgeproof-system" || !values.evidence?.trim() ||
    Boolean(values.owner) === Boolean(values.org) || values.owner === values.issuer ||
    (values.org && (!/^\d+$/.test(values.org) || Number(values.org) <= 0))) {
  throw new Error("Required: --issuer SUBJECT, exactly one of --owner SUBJECT / --org LOCAL_ID, --evidence REVIEW_REFERENCE; optional --apply");
}
if (!values.apply) {
  await new Promise<void>((resolve, reject) => process.stdout.write("Dry run: no database accessed. Independently verify dedicated principal, tenant ownership and approval evidence before --apply.\n", error => error ? reject(error) : resolve()));
  process.exit(0);
}
if (!process.env.DATABASE_URL) throw new Error("Explicit isolated DATABASE_URL required");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const issuer = await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [values.issuer]);
  if (issuer.rows.length !== 1) throw new Error("Issuer unavailable");
  const target = values.owner
    ? await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [values.owner])
    : await client.query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE", [values.org]);
  if (target.rows.length !== 1) throw new Error("Target unavailable");
  const tenantKey = values.owner ? `user:${values.owner}` : `org:${Number(values.org)}`;
  await client.query(`INSERT INTO service_dashboard_principals(issuer_id,tenant_key) VALUES($1,$2)
    ON CONFLICT (issuer_id) DO NOTHING`, [values.issuer, tenantKey]);
  const pin = await client.query("SELECT tenant_key FROM service_dashboard_principals WHERE issuer_id=$1 FOR UPDATE", [values.issuer]);
  if (pin.rows[0]?.tenant_key !== tenantKey) throw new Error("Principal permanently belongs to another tenant; provision a separate principal");
  const result = await client.query(`INSERT INTO service_dashboard_bindings
    (issuer_id, owner_id, org_id, evidence, tenant_key, scope, scope_evidence, verified_by) VALUES ($1,$2,$3,$4,$5,$6,$7,current_user) RETURNING id`,
    [values.issuer, values.owner ?? null, values.org ? Number(values.org) : null, values.evidence, tenantKey, values.scope, values["scope-evidence"] ?? null]);
  await client.query("COMMIT");
  console.log(JSON.stringify({ bindingId: result.rows[0].id, scope: values.scope, receiptGrantsCreated: 0 }));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally { client.release(); await pool.end(); }
