import { timingSafeEqual } from 'node:crypto';
import { captureSealedFullState, openSealedFullState } from './full-state-sealed.mjs';
import { TABLE_ORDER, TABLE_COLUMNS, validateManifest } from './full-state-inventory.mjs';

export const RESTORE_COUNTS = Object.freeze(Object.fromEntries(TABLE_ORDER.map((t, i) =>
  [t, [3, 12, 9, 17, 2, 1, 1, 2, 0, 15][i]])));
export const HISTORICAL_HEAD = 'a03da30aee480d94958de9b967c99057a59fe36022ed1644d68c2c58991ceea1';
const failure = () => new Error('Isolated restore capture rejected');

// Public SQL constants permit a synthetic client without a database dependency.
export const RESTORE_SQL = Object.freeze({
  identity: `SELECT current_database() AS database, current_setting('server_version_num') AS version, current_setting('listen_addresses') AS listeners, inet_client_addr() AS address, pg_backend_pid() AS pid, current_user AS username`,
  schemas: `SELECT nspname AS name FROM pg_catalog.pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname !~ '^pg_toast' ORDER BY nspname`,
  columns: `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position`,
  head: `SELECT entry_hash FROM public.attestation_receipts ORDER BY id DESC LIMIT 1`,
});

async function checkSource(client, trustedPreflight) {
  // This callback is a trust boundary, not self-reported pg connection metadata.
  const peer = await trustedPreflight(client);
  if (!peer || peer.authenticated !== true || peer.transport !== 'unix' ||
      peer.peerIdentityVerified !== true || peer.noTcpListeners !== true ||
      !Number.isSafeInteger(peer.backendPid) || peer.backendPid <= 0 ||
      typeof peer.databaseUser !== 'string' || !peer.databaseUser.length) throw failure();
  const { rows } = await client.query(RESTORE_SQL.identity);
  if (rows.length !== 1) throw failure();
  const r = rows[0];
  if (r.database !== 'forgeproof_0b_restore_test' || !/^17\d{4}$/.test(String(r.version)) ||
      r.listeners !== '' || r.address !== null || r.pid !== peer.backendPid || r.username !== peer.databaseUser) throw failure();
  const schemas = (await client.query(RESTORE_SQL.schemas)).rows;
  if (schemas.length !== 1 || schemas[0].name !== 'public') throw failure();
  const columns = (await client.query(RESTORE_SQL.columns)).rows;
  const expected = TABLE_ORDER.flatMap(t => TABLE_COLUMNS[t].map(c => `${t}.${c}`)).sort();
  const actual = columns.map(r => `${r.table_name}.${r.column_name}`).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw failure();
  const head = (await client.query(RESTORE_SQL.head)).rows;
  if (head.length !== 1 || head[0].entry_hash !== HISTORICAL_HEAD) throw failure();
}

/** Owner-only library. Exclusive idle authenticated client; never a pool shared with app traffic.
 * trustedPreflight must independently establish OS peer identity and listener isolation for
 * this exact connection each time. privateKeySource supplies separately owned keys in memory.
 */
export async function captureIsolatedRestore({ client, trustedPreflight, privateKeySource, manifest, scope }) {
  let encryptionKey, hmacKey;
  try {
    if (!client || typeof client.query !== 'function' || typeof trustedPreflight !== 'function' ||
        typeof privateKeySource !== 'function') throw failure();
    // Snapshot caller-owned metadata before awaiting any injected operation.
    manifest = structuredClone(manifest);
    scope = structuredClone(scope);
    validateManifest(manifest);
    for (const t of TABLE_ORDER) if (manifest.tables[t].expectedRowCount !== RESTORE_COUNTS[t]) throw failure();
    const keys = await privateKeySource();
    for (const k of [keys?.encryptionKey, keys?.hmacKey]) {
      if (!Buffer.isBuffer(k) || k.length !== 32 || k.every(b => b === 0)) throw failure();
    }
    encryptionKey = Buffer.from(keys.encryptionKey);
    hmacKey = Buffer.from(keys.hmacKey);
    if (timingSafeEqual(encryptionKey, hmacKey)) throw failure();
    // Force all unqualified queries in the existing exporter to resolve public tables.
    await client.query('SET search_path TO pg_catalog, public');
    await checkSource(client, trustedPreflight);
    const envelope = await captureSealedFullState(client, manifest, scope, encryptionKey, hmacKey);
    // Authenticate in memory, verify head inside the actual encrypted snapshot.
    const opened = openSealedFullState(envelope, scope, encryptionKey, hmacKey, manifest);
    if (opened.attestation_receipts.at(-1)?.entry_hash !== HISTORICAL_HEAD) throw failure();
    await checkSource(client, trustedPreflight);
    const after = await captureSealedFullState(client, manifest, scope, encryptionKey, hmacKey);
    if (after.wholeStateCommitment !== envelope.wholeStateCommitment) throw failure();
    await checkSource(client, trustedPreflight);
    return { envelope, counts: { ...RESTORE_COUNTS }, wholeStateCommitment: envelope.wholeStateCommitment, productionGoAllowed: false };
  } catch {
    throw failure();
  } finally {
    encryptionKey?.fill(0);
    hmacKey?.fill(0);
  }
}
