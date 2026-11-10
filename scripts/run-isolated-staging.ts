import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";
import { prepareStagingEnvironment } from "../server/stagingEnvironment";

async function main() {
  const { values } = parseArgs({ options: { serve: { type: "boolean", default: false },
    initialize: { type: "boolean", default: false } } });
  const root = process.cwd();
  const prepared = prepareStagingEnvironment(process.env, root);
  // Never use the shell DATABASE_URL or PG* defaults.
  const client = new pg.Client({ connectionString: prepared.env.DATABASE_URL,
    ssl: false, connectionTimeoutMillis: 5000 });
  let databaseReady = false;
  try {
    await client.connect();
    const result = await client.query(`SELECT
      current_database() = 'forgeproof_0b_staging' AS correct_database,
      current_setting('data_directory') = $1 AS correct_cluster,
      current_setting('listen_addresses') = '' AS socket_only,
      NOT pg_is_in_recovery() AS primary,
      to_regclass('public.receipt_outbox') IS NOT NULL AS outbox,
      to_regclass('public.receipt_ledger_state') IS NOT NULL AS checkpoint`,
    [resolve(root, "generated-artifacts/0b-staging-pg/data")]);
    databaseReady = Object.values(result.rows[0]).every(value => value === true);
    console.log(JSON.stringify({ stagingDatabase: result.rows[0] }));
  } catch {
    console.log(JSON.stringify({ stagingDatabaseAccessible: false }));
  } finally { await client.end(); }
  console.log(JSON.stringify({ missingConfigurationNames: prepared.missing,
    invalidConfigurationNames: prepared.invalid,
    emailDeliveryConfigured: !!(prepared.env.SMTP_HOST && prepared.env.SMTP_USER && prepared.env.SMTP_PASS) }));
  if (!databaseReady || prepared.missing.length || prepared.invalid.length) {
    process.exitCode = 1;
    return;
  }
  // Set only this launcher process, before importing modules with cached config.
  Object.assign(process.env, prepared.env);
  const { getGitLedgerConfig, assertLedgerSigner, inspectPinnedLedgerBase } = await import("../server/gitLedger");
  const config = getGitLedgerConfig(prepared.env);
  if (!config) throw new Error("missing config");
  assertLedgerSigner(config);
  if (values.initialize) {
    // Validate the actual protected private Git commit and preserved signed tail
    // before creating any local checkpoint. Never import receipt/user rows.
    const anchor = await inspectPinnedLedgerBase(config);
    const setup = new pg.Client({ host: prepared.socket, port: 55439,
      user: "runner", database: "forgeproof_0b_staging", ssl: false });
    try {
      await setup.connect();
      await setup.query("BEGIN");
      await setup.query("SELECT pg_advisory_xact_lock(7329105)");
      const existing = await setup.query(`SELECT
        (SELECT count(*) FROM attestation_receipts) +
        (SELECT count(*) FROM receipt_outbox) +
        (SELECT count(*) FROM receipt_ledger_state) AS rows`);
      if (Number(existing.rows[0].rows) !== 0) throw new Error("Staging initialization requires empty ledger tables");
      await setup.query(`INSERT INTO receipt_ledger_state
        (singleton,base_receipt_id,sequence,event_hash,receipt_entry_hash,commit_sha,signer_key_id)
        VALUES(true,$1,$2,$3,$4,$5,$6)`,
      [anchor.baseReceiptId, anchor.sequence, anchor.eventHash, anchor.receiptEntryHash, anchor.commitSha, anchor.signerKeyId]);
      await setup.query("SELECT setval(pg_get_serial_sequence('public.attestation_receipts','id'), $1, true)", [anchor.baseReceiptId]);
      await setup.query("COMMIT");
      console.log(JSON.stringify({ isolatedCheckpointInitialized: true, historicalRowsImported: false }));
    } catch (error) { await setup.query("ROLLBACK"); throw error; }
    finally { await setup.end(); }
  }
  console.log(JSON.stringify({ localPreflightPassed: true, providerAcceptancePassed: false }));
  if (!values.serve) return;
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: root, env: prepared.env, stdio: "inherit",
  });
  process.once("SIGTERM", () => child.kill("SIGTERM"));
  process.once("SIGINT", () => child.kill("SIGINT"));
  child.once("error", () => { console.error("Staging child failed to start"); process.exitCode = 1; });
  child.once("exit", code => { process.exitCode = code ?? 1; });
}
main().catch(() => {
  console.error("Staging preflight failed closed; no provider acceptance or activation claimed.");
  process.exitCode = 1;
});
