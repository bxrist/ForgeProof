import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getTableOrder, TABLE_COLUMNS, normalizeRowStrict, validateManifest } from './full-state-inventory.mjs';

const VERSION = 1;
const BEGIN_SQL = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const LOCAL_TIMEOUT_SQL = "SET LOCAL statement_timeout='30s'";
const COMMIT_SQL = 'COMMIT';
const ROLLBACK_SQL = 'ROLLBACK';

function failClosed() {
  return new Error('Protected full state capture failed');
}

function ensureBuffer32(value) {
  if (!Buffer.isBuffer(value) || value.length !== 32) throw failClosed();
}

function validateScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw failClosed();
  const keys = Object.keys(scope);
  if (keys.length !== 2 || !keys.includes('tenantId') || !keys.includes('repositoryId')) throw failClosed();
  for (const value of [scope.tenantId,scope.repositoryId])
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw failClosed();
}

function tableIdentityKey(table, row) {
  if (table === 'service_dashboard_principals') return row.issuer_id;
  if (table === 'sessions') return row.sid;
  return row.id;
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

function encodeAAD(payload) {
  return Buffer.from(canonicalize(payload), 'utf8');
}

function validateEnvelopeShape(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw failClosed();
  const expectedTop = ['version', 'scope', 'schema', 'tableRecords', 'wholeStateCommitment', 'productionGoAllowed'];
  const keys = Object.keys(envelope);
  if (keys.length !== expectedTop.length || expectedTop.some((k) => !keys.includes(k))) throw failClosed();
  if (envelope.version !== VERSION) throw failClosed();
  if (envelope.productionGoAllowed !== false) throw failClosed();
}

function validateSchemaSection(schema, reviewedManifest) {
  const TABLE_ORDER=getTableOrder(reviewedManifest);
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw failClosed();
  const expected = ['sourceFingerprintCommitment', 'tables'];
  const keys = Object.keys(schema);
  if (keys.length !== expected.length || expected.some((k) => !keys.includes(k))) throw failClosed();
  if (typeof schema.sourceFingerprintCommitment !== 'string' || !/^[a-f0-9]{64}$/.test(schema.sourceFingerprintCommitment)) throw failClosed();
  if (!schema.tables || typeof schema.tables !== 'object' || Array.isArray(schema.tables)) throw failClosed();

  for (const table of TABLE_ORDER) {
    const manifestDef = reviewedManifest.tables[table];
    const schemaDef = schema.tables[table];
    if (!schemaDef || typeof schemaDef !== 'object' || Array.isArray(schemaDef)) throw failClosed();
    const schemaKeys = Object.keys(schemaDef);
    if (schemaKeys.length !== 2 || !schemaKeys.includes('columns') || !schemaKeys.includes('expectedRowCount')) throw failClosed();
    if (!Array.isArray(schemaDef.columns)) throw failClosed();
    if (!Number.isSafeInteger(schemaDef.expectedRowCount) || schemaDef.expectedRowCount < 0) throw failClosed();
    if (schemaDef.expectedRowCount !== manifestDef.expectedRowCount) throw failClosed();
    if (schemaDef.columns.length !== TABLE_COLUMNS[table].length) throw failClosed();
    for (let i = 0; i < TABLE_COLUMNS[table].length; i += 1) {
      if (schemaDef.columns[i] !== TABLE_COLUMNS[table][i]) throw failClosed();
    }
  }

  const schemaKeys = Object.keys(schema.tables).sort();
  const expectedKeys = [...TABLE_ORDER].sort();
  if (schemaKeys.length !== expectedKeys.length) throw failClosed();
  for (let i = 0; i < expectedKeys.length; i += 1) {
    if (schemaKeys[i] !== expectedKeys[i]) throw failClosed();
  }
}

function buildSourceFingerprintCommitment(hmacKey, reviewedManifest) {
  const payload = Buffer.from(reviewedManifest.sourceDbFingerprint, 'utf8');
  return createHmac('sha256', hmacKey).update(payload).digest('hex');
}

function buildTableAAD(table, scope, reviewedManifest, sourceFingerprintCommitment, rowCount) {
  return encodeAAD({
    version: VERSION,
    table,
    tenantId: scope.tenantId,
    repositoryId: scope.repositoryId,
    sourceFingerprintCommitment,
    schemaColumns: TABLE_COLUMNS[table],
    expectedRowCount: reviewedManifest.tables[table].expectedRowCount,
    observedRowCount: rowCount,
  });
}

function validateTableRecordShape(record, table, reviewedManifest) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw failClosed();
  const keys = Object.keys(record);
  const expected = ['table', 'rowCount', 'columns', 'aadSha256', 'nonceBase64', 'tagBase64', 'ciphertextBase64', 'ciphertextSha256', 'tableCommitmentHmac'];
  if (keys.length !== expected.length || expected.some((k) => !keys.includes(k))) throw failClosed();
  if (record.table !== table) throw failClosed();
  if (!Number.isSafeInteger(record.rowCount) || record.rowCount < 0) throw failClosed();
  if (record.rowCount !== reviewedManifest.tables[table].expectedRowCount) throw failClosed();
  if (!Array.isArray(record.columns) || record.columns.length !== TABLE_COLUMNS[table].length) throw failClosed();
  for (let i = 0; i < TABLE_COLUMNS[table].length; i += 1) {
    if (record.columns[i] !== TABLE_COLUMNS[table][i]) throw failClosed();
  }
  if (!/^[a-f0-9]{64}$/.test(record.aadSha256)) throw failClosed();
  if (!/^[a-f0-9]{64}$/.test(record.ciphertextSha256)) throw failClosed();
  if (!/^[a-f0-9]{64}$/.test(record.tableCommitmentHmac)) throw failClosed();
}

export async function captureSealedFullState(client, reviewedManifest, scope, encryptionKey, hmacKey) {
  const TABLE_ORDER=getTableOrder(reviewedManifest);
  try { validateManifest(reviewedManifest); } catch { throw failClosed(); }
  validateScope(scope);
  ensureBuffer32(encryptionKey);
  ensureBuffer32(hmacKey);
  if (timingSafeEqual(encryptionKey, hmacKey)) throw failClosed();

  let started = false;
  try {
    await client.query(BEGIN_SQL);
    started = true;
    await client.query(LOCAL_TIMEOUT_SQL);

    const sourceFingerprintCommitment = buildSourceFingerprintCommitment(hmacKey, reviewedManifest);
    const usedNonces = new Set();
    const tableRecords = [];
    const wholeCommitHmac = createHmac('sha256', hmacKey);

    for (const table of TABLE_ORDER) {
      const idColumn = table === 'sessions' ? 'sid' : table === 'service_dashboard_principals' ? 'issuer_id' : 'id';
      const result = await client.query(`SELECT * FROM "${table}" ORDER BY "${idColumn}"`);
      if (!result || !Array.isArray(result.rows) ||
          (result.rowCount != null && result.rowCount !== result.rows.length) ||
          result.rows.length !== reviewedManifest.tables[table].expectedRowCount) {
        throw failClosed();
      }

      const seenIds = new Set();
      const normalizedRows = [];
      for (const row of result.rows) {
        const normalized = normalizeRowStrict(table, row, TABLE_COLUMNS[table]);
        const identity = tableIdentityKey(table, normalized);
        if (seenIds.has(identity)) throw failClosed();
        seenIds.add(identity);
        normalizedRows.push(normalized);
      }

      normalizedRows.sort((a,b)=>{
        const l=tableIdentityKey(table,a),r=tableIdentityKey(table,b);
        return typeof l==='number' ? l-r : (l<r?-1:l>r?1:0);
      });
      const plaintext = Buffer.from(canonicalize(normalizedRows), 'utf8');
      const nonce = randomBytes(12);
      const nonceId=nonce.toString('base64');
      if (usedNonces.has(nonceId)) throw failClosed();
      usedNonces.add(nonceId);
      const aad = buildTableAAD(table, scope, reviewedManifest, sourceFingerprintCommitment, normalizedRows.length);
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      const ciphertextSha256 = createHash('sha256').update(ciphertext).digest('hex');
      const aadSha256 = createHash('sha256').update(aad).digest('hex');

      // The content commitment is keyed over NORMALIZED PLAINTEXT, not the
      // randomly encrypted ciphertext: a repeat export of identical source
      // state must keep the same HMAC even with fresh AES-GCM nonces.
      const tableCommitmentHmac = createHmac('sha256', hmacKey)
        .update('ForgeProof-0B-state-v1\n')
        .update(aad)
        .update(plaintext)
        .digest('hex');

      wholeCommitHmac
        .update(Buffer.from(table, 'utf8'))
        .update(Buffer.from(tableCommitmentHmac, 'utf8'));

      tableRecords.push({
        table,
        rowCount: normalizedRows.length,
        columns: TABLE_COLUMNS[table],
        aadSha256,
        nonceBase64: nonce.toString('base64'),
        tagBase64: tag.toString('base64'),
        ciphertextBase64: ciphertext.toString('base64'),
        ciphertextSha256,
        tableCommitmentHmac,
      });
    }

    const envelope = {
      version: VERSION,
      scope: {
        tenantId: scope.tenantId,
        repositoryId: scope.repositoryId,
      },
      schema: {
        sourceFingerprintCommitment,
        tables: Object.fromEntries(TABLE_ORDER.map((table) => [
          table,
          {
            columns: [...TABLE_COLUMNS[table]],
            expectedRowCount: reviewedManifest.tables[table].expectedRowCount,
          },
        ])),
      },
      tableRecords,
      wholeStateCommitment: wholeCommitHmac.digest('hex'),
      productionGoAllowed: false,
    };

    await client.query(COMMIT_SQL);
    return envelope;
  } catch (_error) {
    if (started) {
      try {
        await client.query(ROLLBACK_SQL);
      } catch (_rollbackErr) {
      }
    }
    throw failClosed();
  }
}

export function openSealedFullState(envelope, scope, encryptionKey, hmacKey, reviewedManifest) {
  const TABLE_ORDER=getTableOrder(reviewedManifest);
  try { validateManifest(reviewedManifest); } catch { throw failClosed(); }
  validateScope(scope);
  ensureBuffer32(encryptionKey);
  ensureBuffer32(hmacKey);
  if (timingSafeEqual(encryptionKey, hmacKey)) throw failClosed();

  validateEnvelopeShape(envelope);
  validateScope(envelope.scope);
  if (envelope.scope.tenantId !== scope.tenantId || envelope.scope.repositoryId !== scope.repositoryId) throw failClosed();
  validateSchemaSection(envelope.schema, reviewedManifest);
  const expectedFingerprintCommitment = buildSourceFingerprintCommitment(hmacKey, reviewedManifest);
  const actualFingerprintCommitment = envelope.schema.sourceFingerprintCommitment;
  if (!timingSafeEqual(Buffer.from(expectedFingerprintCommitment, 'hex'), Buffer.from(actualFingerprintCommitment, 'hex'))) {
    throw failClosed();
  }

  if (!Array.isArray(envelope.tableRecords) || envelope.tableRecords.length !== TABLE_ORDER.length) throw failClosed();
  if (typeof envelope.wholeStateCommitment !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.wholeStateCommitment)) throw failClosed();

  const output = {};
  const usedNonces = new Set();
  const wholeCommitHmac = createHmac('sha256', hmacKey);

  for (let index = 0; index < TABLE_ORDER.length; index += 1) {
    const table = TABLE_ORDER[index];
    const record = envelope.tableRecords[index];
    validateTableRecordShape(record, table, reviewedManifest);

    // Buffer.from accepts noncanonical base64 and can silently ignore bad
    // characters. Require exactly reversible encodings before decryption.
    function decodeCanonicalBase64(value) {
      if (typeof value !== 'string' || !value.length ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw failClosed();
      const bytes=Buffer.from(value,'base64');
      if (bytes.toString('base64') !== value) throw failClosed();
      return bytes;
    }
    const nonce = decodeCanonicalBase64(record.nonceBase64);
    const tag = decodeCanonicalBase64(record.tagBase64);
    const ciphertext = decodeCanonicalBase64(record.ciphertextBase64);
    if (nonce.length !== 12 || tag.length !== 16 || !ciphertext.length) throw failClosed();
    if (usedNonces.has(record.nonceBase64)) throw failClosed();
    usedNonces.add(record.nonceBase64);

    const ciphertextSha256 = createHash('sha256').update(ciphertext).digest('hex');
    if (!timingSafeEqual(Buffer.from(ciphertextSha256, 'hex'), Buffer.from(record.ciphertextSha256, 'hex'))) throw failClosed();

    const aad = buildTableAAD(table, scope, reviewedManifest, expectedFingerprintCommitment, record.rowCount);
    const aadSha256 = createHash('sha256').update(aad).digest('hex');
    if (!timingSafeEqual(Buffer.from(aadSha256, 'hex'), Buffer.from(record.aadSha256, 'hex'))) throw failClosed();

    let plaintext;
    try {
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, nonce);
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (_e) {
      throw failClosed();
    }

    const expectedTableCommitment = createHmac('sha256', hmacKey)
      .update('ForgeProof-0B-state-v1\n')
      .update(aad)
      .update(plaintext)
      .digest('hex');
    if (!timingSafeEqual(Buffer.from(expectedTableCommitment, 'hex'),
                         Buffer.from(record.tableCommitmentHmac, 'hex'))) throw failClosed();
    wholeCommitHmac.update(Buffer.from(table,'utf8')).update(Buffer.from(expectedTableCommitment,'utf8'));

    let parsed;
    try {
      parsed = JSON.parse(plaintext.toString('utf8'));
    } catch (_e) {
      throw failClosed();
    }

    if (!Array.isArray(parsed) || parsed.length !== record.rowCount) throw failClosed();
    const seenIds = new Set();
    const normalizedRows = [];
    for (const row of parsed) {
      const normalized = normalizeRowStrict(table, row, TABLE_COLUMNS[table]);
      const identity = tableIdentityKey(table, normalized);
      if (seenIds.has(identity)) throw failClosed();
      seenIds.add(identity);
      normalizedRows.push(normalized);
    }

    for (let i=1;i<normalizedRows.length;i++) {
      const left=tableIdentityKey(table,normalizedRows[i-1]);
      const right=tableIdentityKey(table,normalizedRows[i]);
      if (typeof left==='number' ? left>=right : left>=right) throw failClosed();
    }
    output[table] = normalizedRows;
  }

  const computedWhole = wholeCommitHmac.digest('hex');
  if (!timingSafeEqual(Buffer.from(computedWhole, 'hex'), Buffer.from(envelope.wholeStateCommitment, 'hex'))) throw failClosed();

  return output;
}
