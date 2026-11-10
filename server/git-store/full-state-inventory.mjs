import { createHmac } from 'node:crypto';

const BEGIN_SQL = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const LOCAL_TIMEOUT_SQL = "SET LOCAL statement_timeout='30s'";
const COMMIT_SQL = 'COMMIT';
const ROLLBACK_SQL = 'ROLLBACK';

const TABLE_ORDER = [
  'users',
  'sessions',
  'repositories',
  'attestation_receipts',
  'api_keys',
  'organizations',
  'org_members',
  'subscriptions',
  'pending_emails',
  'audit_logs',
];

const TABLE_COLUMNS = Object.freeze({
  service_dashboard_principals: ['issuer_id','tenant_key'],
  service_dashboard_bindings: ['id','issuer_id','owner_id','org_id','tenant_key','scope','scope_evidence','evidence','verified_by','created_at','revoked_at'],
  service_dashboard_grants: ['id','binding_id','receipt_id','granted_by','created_at','revoked_at'],
  users: [
    'id',
    'email',
    'first_name',
    'last_name',
    'profile_image_url',
    'github_token',
    'github_username',
    'notification_email',
    'notify_on_git_failure',
    'stripe_customer_id',
    'default_repo_id',
    'detail_repo_id',
    'last_active_tab',
    'created_at',
    'updated_at',
  ],
  sessions: ['sid', 'sess', 'expire'],
  repositories: [
    'id',
    'user_id',
    'org_id',
    'github_id',
    'name',
    'full_name',
    'url',
    'default_branch',
    'description',
    'last_synced_at',
    'created_at',
  ],
  attestation_receipts: [
    'id',
    'user_id',
    'org_id',
    'repository_id',
    'file_hash',
    'file_name',
    'file_path',
    'model_name',
    'model_provider',
    'country_of_origin',
    'detected_country',
    'compliance_status',
    'attestation_type',
    'parent_attestation_id',
    'audit_verdict',
    'audit_details',
    'signature',
    'public_key',
    'prev_entry_hash',
    'entry_hash',
    'receipt_version',
    'signed_at',
    'git_commit_url',
    'git_commit_message',
    'metadata',
    'created_at',
  ],
  api_keys: [
    'id',
    'user_id',
    'name',
    'key_hash',
    'key_prefix',
    'permissions',
    'is_active',
    'last_used_at',
    'expires_at',
    'created_at',
  ],
  organizations: ['id', 'name', 'slug', 'owner_id', 'description', 'created_at'],
  org_members: ['id', 'org_id', 'user_id', 'role', 'created_at'],
  subscriptions: [
    'id',
    'user_id',
    'org_id',
    'stripe_customer_id',
    'stripe_subscription_id',
    'plan',
    'status',
    'current_period_start',
    'current_period_end',
    'attestation_limit',
    'attestation_count',
    'api_key_limit',
    'created_at',
  ],
  pending_emails: [
    'id',
    'to',
    'subject',
    'body_html',
    'body_text',
    'retry_count',
    'next_retry_at',
    'status',
    'created_at',
  ],
  audit_logs: [
    'id',
    'user_id',
    'action',
    'resource_type',
    'resource_id',
    'metadata',
    'ip_address',
    'created_at',
  ],
});

export { TABLE_ORDER, TABLE_COLUMNS, normalizeRowStrict, validateManifest };
export function getTableOrder(manifest) {
  return Object.keys(manifest?.tables ?? {}).length === 13
    ? [...TABLE_ORDER,'service_dashboard_principals','service_dashboard_bindings','service_dashboard_grants']
    : TABLE_ORDER;
}

function failClosed() {
  return new Error('Application state inventory failed');
}

function validateHmacKey(hmacKey) {
  if (!Buffer.isBuffer(hmacKey) || hmacKey.length !== 32) {
    throw failClosed();
  }
}

function validateManifest(manifest) {
  const TABLE_ORDER=getTableOrder(manifest);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      Object.keys(manifest).length !== 3 ||
      Object.keys(manifest).some(k => !['version','sourceDbFingerprint','tables'].includes(k)))
    throw failClosed();
  if (manifest.version !== 1) throw failClosed();
  if (typeof manifest.sourceDbFingerprint !== 'string' ||
      manifest.sourceDbFingerprint.length < 1 || manifest.sourceDbFingerprint.length > 256)
    throw failClosed();
  if (!manifest.tables || typeof manifest.tables !== 'object' || Array.isArray(manifest.tables)) {
    throw failClosed();
  }

  const manifestKeys = Object.keys(manifest.tables).sort();
  const expectedKeys = [...TABLE_ORDER].sort();
  if (manifestKeys.length !== expectedKeys.length) throw failClosed();
  for (let i = 0; i < expectedKeys.length; i += 1) {
    if (manifestKeys[i] !== expectedKeys[i]) throw failClosed();
  }

  for (const table of TABLE_ORDER) {
    const def = manifest.tables[table];
    if (!def || typeof def !== 'object' || Array.isArray(def) ||
        Object.keys(def).some(k=>!['expectedRowCount','reviewedSchemaColumns'].includes(k)))
      throw failClosed();
    if (!Number.isSafeInteger(def.expectedRowCount) || def.expectedRowCount < 0) throw failClosed();
    if (def.reviewedSchemaColumns !== undefined) {
      if (!Array.isArray(def.reviewedSchemaColumns)) throw failClosed();
      const expectedColumns = TABLE_COLUMNS[table];
      if (def.reviewedSchemaColumns.length !== expectedColumns.length) throw failClosed();
      for (let i = 0; i < expectedColumns.length; i += 1) {
        if (def.reviewedSchemaColumns[i] !== expectedColumns[i]) throw failClosed();
      }
    }
  }
}

function sanitizeValue(value) {
  // Undefined must not be interpreted as SQL NULL: doing so would silently
  // change original source bytes and make the custody proof meaningless.
  if (value === null) return null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw failClosed();
    return value.toISOString();
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw failClosed();
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (typeof value === 'object' && value &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    if (Object.getOwnPropertySymbols(value).length) throw failClosed();
    const output=Object.create(null);
    for (const k of Object.keys(value).sort()) {
      if (k === '__proto__' || k === 'constructor') throw failClosed();
      output[k]=sanitizeValue(value[k]);
    }
    return output;
  }
  throw failClosed();
}

function validatePrimaryIdentity(table, row) {
  if (table === 'service_dashboard_principals') {
    if (typeof row.issuer_id !== 'string' || !row.issuer_id) throw failClosed();
    return;
  }
  if (table === 'users') {
    if (typeof row.id !== 'string' || row.id.length === 0) throw failClosed();
    return;
  }
  if (table === 'sessions') {
    if (typeof row.sid !== 'string' || row.sid.length === 0) throw failClosed();
    return;
  }
  if (typeof row.id !== 'number' || !Number.isSafeInteger(row.id) || row.id <= 0) throw failClosed();
}

function rowIdentifier(table, row) {
  if (table === 'service_dashboard_principals') return row.issuer_id;
  return table === 'sessions' ? row.sid : row.id;
}

function normalizeRowStrict(table, row, expectedColumns) {
  if (!row || typeof row !== 'object' || Array.isArray(row) ||
      (Object.getPrototypeOf(row)!==Object.prototype && Object.getPrototypeOf(row)!==null) ||
      Object.getOwnPropertySymbols(row).length) throw failClosed();

  const rowKeys = Object.keys(row).sort();
  const expectedKeys = [...expectedColumns].sort();
  if (rowKeys.length !== expectedKeys.length) throw failClosed();
  for (let i = 0; i < expectedKeys.length; i += 1) {
    if (rowKeys[i] !== expectedKeys[i]) throw failClosed();
  }

  const normalized = {};
  for (const col of expectedColumns) {
    normalized[col] = sanitizeValue(row[col]);
  }

  validatePrimaryIdentity(table, normalized);
  JSON.stringify(normalized);
  return normalized;
}

function hmacHex(key, input) {
  return createHmac('sha256', key).update(input, 'utf8').digest('hex');
}

export async function inspectCompleteApplicationSource(client, reviewedManifest, hmacKey) {
  validateHmacKey(hmacKey);
  validateManifest(reviewedManifest);
  const TABLE_ORDER=getTableOrder(reviewedManifest);

  const summary = {
    manifestVersion: reviewedManifest.version,
    // An untrusted reviewed fingerprint might itself contain a hostname or
    // credential-like text. Return only its keyed commitment.
    reviewedSourceFingerprintHmac: hmacHex(hmacKey,reviewedManifest.sourceDbFingerprint),
    inventoryType: 'application-source-preflight',
    stripeCoverage: {
      providerManagedStripeSchemaCovered: false,
      webhookCredentialTruthCovered: false,
      productionGoAllowed: false,
      note: 'Stripe provider-managed schema, billing truth, and webhook credentials are excluded from Milestone 0B inventory coverage.',
    },
    secretCustodyRequirement: {
      required: true,
      sensitiveNonNullCounts: {
        users_github_token: 0,
        api_keys_key_hash: 0,
        api_keys_key_prefix: 0,
        sessions_sess: 0,
        pending_emails_to: 0,
        pending_emails_body_html: 0,
        pending_emails_body_text: 0,
      },
    },
    tables: {},
    sourceTotals: {
      tableCount: TABLE_ORDER.length,
      rowCount: 0,
      sourceHmacDigest: '',
    },
    constraints: {
      includesLineageSignatureVerification: false,
      includesFullEncryptedMigration: false,
      includesProductionSourceSnapshot: false,
      includesUserOrStripeBillingTruth: false,
    },
  };

  const tableDigests = [];

  let transactionStarted=false;
  try {
    if (!client || typeof client.query!=='function') throw failClosed();
    await client.query(BEGIN_SQL);
    transactionStarted=true;
    await client.query(LOCAL_TIMEOUT_SQL);

    for (const table of TABLE_ORDER) {
      // SQL identifiers are an internal fixed whitelist, never user input.
      const idColumn = table==='sessions' ? 'sid' : table==='service_dashboard_principals' ? 'issuer_id' : 'id';
      const sql = `SELECT * FROM "${table}" ORDER BY "${idColumn}"`;
      const result = await client.query(sql);
      if (!result || !Array.isArray(result.rows) ||
          (result.rowCount!=null && result.rowCount!==result.rows.length))
        throw failClosed();

      const expectedColumns = TABLE_COLUMNS[table];
      const seen = new Set();
      const rowHmacs = [];

      for (const rawRow of result.rows) {
        const normalized = normalizeRowStrict(table, rawRow, expectedColumns);
        const identity = rowIdentifier(table, normalized);
        if (seen.has(identity)) throw failClosed();
        seen.add(identity);

        if (table === 'users' && normalized.github_token !== null) {
          summary.secretCustodyRequirement.sensitiveNonNullCounts.users_github_token += 1;
        }
        if (table === 'api_keys') {
          if (normalized.key_hash !== null) {
            summary.secretCustodyRequirement.sensitiveNonNullCounts.api_keys_key_hash += 1;
          }
          if (normalized.key_prefix !== null) {
            summary.secretCustodyRequirement.sensitiveNonNullCounts.api_keys_key_prefix += 1;
          }
        }
        if (table === 'sessions' && normalized.sess !== null) {
          summary.secretCustodyRequirement.sensitiveNonNullCounts.sessions_sess += 1;
        }
        if (table === 'pending_emails') {
          if (normalized.to !== null) summary.secretCustodyRequirement.sensitiveNonNullCounts.pending_emails_to += 1;
          if (normalized.body_html !== null) summary.secretCustodyRequirement.sensitiveNonNullCounts.pending_emails_body_html += 1;
          if (normalized.body_text !== null) summary.secretCustodyRequirement.sensitiveNonNullCounts.pending_emails_body_text += 1;
        }

        const rowSerialized = JSON.stringify(normalized);
        const rowDigest = hmacHex(hmacKey, rowSerialized);
        rowHmacs.push({ id: identity, digest: rowDigest });
      }

      rowHmacs.sort((a, b) => {
        if (typeof a.id === 'number' && typeof b.id === 'number') return a.id - b.id;
        return String(a.id).localeCompare(String(b.id));
      });

      const observedRowCount = rowHmacs.length;
      const expectedRowCount = reviewedManifest.tables[table].expectedRowCount;
      if (observedRowCount !== expectedRowCount) throw failClosed();

      const tableDigest = hmacHex(
        hmacKey,
        JSON.stringify({ table, rowHmacs: rowHmacs.map((entry) => entry.digest) }),
      );

      summary.tables[table] = {
        observedRowCount,
        expectedRowCount,
        schemaColumns: expectedColumns,
        tableHmacDigest: tableDigest,
      };
      summary.sourceTotals.rowCount += observedRowCount;
      tableDigests.push({ table, digest: tableDigest });
    }

    summary.sourceTotals.sourceHmacDigest = hmacHex(
      hmacKey,
      JSON.stringify(tableDigests.map((entry) => `${entry.table}:${entry.digest}`)),
    );

    await client.query(COMMIT_SQL);
    return summary;
  } catch {
    if (transactionStarted) {
      try { await client.query(ROLLBACK_SQL); } catch { /* preserve bounded error */ }
    }
    throw failClosed();
  }
}
