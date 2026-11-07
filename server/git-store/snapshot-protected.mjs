// Source-only, injected PostgreSQL transaction adapter. Not a production exporter
// or replacement for the default ForgeProof PostgreSQL application. The caller
// owns a single authenticated, explicitly read-only pg.Client and reviewed
// source manifest. No SQL credentials, raw rows or private keys are logged.
import { buildProtectedHistoricalArchivePreflight } from './protected-archive.mjs';
import { receiptFields } from './schema.mjs';

const AUDIT_FIELDS = ['id','userId','action','resourceType','resourceId','metadata','ipAddress','createdAt'];
const RECEIPT_FIELDS = new Set(receiptFields);
const AUDIT_FIELDS_SET = new Set(AUDIT_FIELDS);
const toCamel = key => key.replace(/_([a-z])/g, (_,c)=>c.toUpperCase());

function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid input');
}
function normalizedValue(value) {
  if (value === undefined) throw new Error('Missing SQL field value');
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('Invalid SQL timestamp');
    return value.toISOString();
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) throw new Error('Invalid SQL number');
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizedValue);
  requireObject(value);
  if (Object.getPrototypeOf(value)!==Object.prototype && Object.getPrototypeOf(value)!==null) throw new Error('Unsupported SQL JSON value');
  const copy=Object.create(null);
  for(const [key,content] of Object.entries(value)) copy[key]=normalizedValue(content);
  return copy;
}
function normalizeSQLrow(row, expected) {
  requireObject(row);
  const mapped=Object.create(null);
  for(const [sourceKey,sourceValue] of Object.entries(row)) {
    if (typeof sourceKey !== 'string' || !/^[a-z_]+$/.test(sourceKey) && sourceKey!=='id') throw new Error('Unexpected SQL source column');
    const key=toCamel(sourceKey);
    if (!expected.has(key)) throw new Error('Unknown SQL source column');
    if (Object.hasOwn(mapped,key)) throw new Error('Duplicate SQL column mapping');
    mapped[key]=normalizedValue(sourceValue);
  }
  if(Object.keys(mapped).length!==expected.size) throw new Error('Incomplete SQL source row');
  for(const key of expected) if(!Object.hasOwn(mapped,key)) throw new Error('Missing SQL source column');
  if(!Number.isSafeInteger(mapped.id) || mapped.id < 1) throw new Error('Invalid SQL row id');
  return mapped;
}
function rows(result) {
  if (!result || !Array.isArray(result.rows) ||
      (result.rowCount != null && result.rowCount!==result.rows.length)) {
    throw new Error('Invalid SQL result shape');
  }
  return result.rows;
}
/** Capture and encrypt historical evidence from a *single injected* pg.Client.
 * The originalBytes produced below are canonicalized SQL-export serialization,
 * NOT necessarily the original HTTP attestation issuance response bytes.
 * No sensitive value, database URL, key or client handle is returned.
 */
export async function captureProtectedEvidence(client, source, encryptionKey) {
  requireObject(client);
  if (typeof client.query!=='function') throw new Error('Invalid SQL client');
  requireObject(source);
  if (Object.keys(source).length!==3 ||
      !Object.hasOwn(source,'tenant') || !Object.hasOwn(source,'repository') ||
      !Object.hasOwn(source,'manifest')) throw new Error('Invalid reviewed source');
  requireObject(source.manifest);
  if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length!==32) throw new Error('Invalid encryption key');
  let begun=false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    begun=true;
    await client.query("SET LOCAL statement_timeout = '30s'");
    const receiptRows=rows(await client.query('SELECT * FROM "attestation_receipts" ORDER BY id'));
    const auditRows=rows(await client.query('SELECT * FROM "audit_logs" ORDER BY id'));
    // Source rows remain in memory only. No JSON of plaintext leaves this call.
    const receipts=receiptRows.map(row=>{
      const record=normalizeSQLrow(row,RECEIPT_FIELDS);
      if(record.auditDetails!==null && typeof record.auditDetails!=='string') throw new Error('Invalid SQL receipt audit details');
      return {id:record.id,originalBytes:Buffer.from(JSON.stringify(record),'utf8')};
    });
    const auditLogs=auditRows.map(row=>{
      const record=normalizeSQLrow(row,AUDIT_FIELDS_SET);
      return {id:record.id,originalBytes:Buffer.from(JSON.stringify(record),'utf8')};
    });
    const stage=buildProtectedHistoricalArchivePreflight({
      version:2,tenant:source.tenant,repository:source.repository,
      manifest:source.manifest,receipts,auditLogs
    },encryptionKey);
    await client.query('COMMIT');
    return {...stage,serializationNote:'Exact serialized SQL export bytes, not necessarily original HTTP issuance bytes.'};
  } catch {
    if (begun) { try { await client.query('ROLLBACK'); } catch {} }
    // Avoid surfacing original SQL rows, driver credentials or SQL error text.
    throw new Error('Protected evidence capture failed');
  }
}