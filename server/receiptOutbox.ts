import { randomUUID } from "crypto";
import type { PoolClient } from "pg";
import { pool } from "./legacySqlPool";
import { currentApplicationStorage } from "./storageBackend";
import {
  appendReceiptToGit,
  assertLedgerSigner,
  createLedgerOutboxItem,
  getGitLedgerConfig,
  gitLedgerEnabled,
  GitLedgerError,
  type LedgerState,
} from "./gitLedger";

const OUTBOX_LOCK_ID = 681042071;
const LEASE_SECONDS = 90;
const MAX_ATTEMPTS = 12;
let workerTimer: NodeJS.Timeout | null = null;

export type EnqueueReceiptResult = "disabled" | "pending";

export async function stagingArchivePredecessor(client: Pick<PoolClient, "query">): Promise<string | null> {
  if (process.env.FORGEPROOF_ISOLATED_STAGING !== "true" || !gitLedgerEnabled()) return null;
  const result = await client.query("SELECT receipt_entry_hash FROM receipt_ledger_state WHERE singleton = true");
  if (!result.rows[0]) throw new Error("Isolated staging requires a verified archive checkpoint before receipt creation");
  return result.rows[0].receipt_entry_hash;
}

export async function enqueueReceiptOutbox(
  client: Pick<PoolClient, "query">,
  receiptRow: Record<string, any>,
): Promise<EnqueueReceiptResult> {
  const config = getGitLedgerConfig();
  if (!config) return "disabled";
  assertLedgerSigner(config);
  const item = createLedgerOutboxItem(receiptRow);
  if (item.receiptId <= config.baseReceiptId) {
    throw new GitLedgerError("Receipt ID is not beyond the pinned archive boundary", true, "base_receipt_mismatch");
  }

  const stateResult = await client.query(
    `SELECT receipt_entry_hash FROM receipt_ledger_state WHERE singleton = true LIMIT 1`
  );
  const queuedResult = await client.query(
    `SELECT r.entry_hash
     FROM receipt_outbox o
     JOIN attestation_receipts r ON r.id = o.receipt_id
     ORDER BY o.id DESC
     LIMIT 1`
  );
  const expectedPrevious = queuedResult.rows[0]?.entry_hash
    ?? stateResult.rows[0]?.receipt_entry_hash
    ?? config.baseReceiptEntryHash;
  if (item.payload.prevEntryHash !== expectedPrevious) {
    throw new GitLedgerError(
      "Receipt chain is not contiguous with the Git outbox checkpoint",
      true,
      "receipt_gap",
    );
  }

  const inserted = await client.query(
    `INSERT INTO receipt_outbox (receipt_id, event_id, payload, payload_hash, status)
     VALUES ($1, $2, $3::jsonb, $4, 'pending')
     ON CONFLICT (receipt_id) DO NOTHING
     RETURNING id`,
    [item.receiptId, item.eventId, JSON.stringify(item.payload), item.payloadHash],
  );
  if (inserted.rows.length === 0) {
    const existing = await client.query(
      `SELECT event_id, payload_hash FROM receipt_outbox WHERE receipt_id = $1 LIMIT 1`,
      [item.receiptId],
    );
    if (existing.rows[0]?.event_id !== item.eventId ||
        existing.rows[0]?.payload_hash !== item.payloadHash) {
      throw new GitLedgerError("Existing outbox intent does not match the signed receipt", true, "outbox_conflict");
    }
  }
  return "pending";
}

function rowToState(row: Record<string, any> | undefined): LedgerState | null {
  if (!row) return null;
  return {
    baseReceiptId: Number(row.base_receipt_id),
    sequence: Number(row.sequence),
    eventHash: row.event_hash,
    receiptEntryHash: row.receipt_entry_hash,
    commitSha: row.commit_sha,
    signerKeyId: row.signer_key_id,
  };
}

export async function flushReceiptOutboxOnce(): Promise<boolean> {
  if (!gitLedgerEnabled()) return false;
  const config = getGitLedgerConfig();
  if (!config) return false;

  const client = await pool.connect();
  let locked = false;
  let claimedId: number | null = null;
  let leaseOwner: string | null = null;
  let item: ReturnType<typeof createLedgerOutboxItem> | null = null;
  let state: LedgerState | null = null;
  try {
    const lock = await client.query(
      `SELECT pg_try_advisory_lock($1) AS locked`,
      [OUTBOX_LOCK_ID],
    );
    locked = lock.rows[0]?.locked === true;
    if (!locked) return false;

    await client.query("BEGIN");
    const stateResult = await client.query(
      `SELECT base_receipt_id, sequence, event_hash, receipt_entry_hash, commit_sha, signer_key_id
       FROM receipt_ledger_state
       WHERE singleton = true
       FOR UPDATE`,
    );
    state = rowToState(stateResult.rows[0]);
    const next = await client.query(
      `SELECT o.id, o.receipt_id, o.event_id, o.payload, o.payload_hash,
              o.status, o.attempts, o.next_attempt_at, o.lease_expires_at
       FROM receipt_outbox o
       WHERE o.status <> 'delivered'
       ORDER BY o.id
       LIMIT 1
       FOR UPDATE`,
    );
    const row = next.rows[0];
    if (!row || row.status === "blocked" ||
        (row.status === "processing" && row.lease_expires_at && new Date(row.lease_expires_at).getTime() > Date.now()) ||
        (new Date(row.next_attempt_at).getTime() > Date.now())) {
      await client.query("COMMIT");
      return false;
    }

    claimedId = Number(row.id);
    leaseOwner = randomUUID();
    item = {
      id: Number(row.id),
      receiptId: Number(row.receipt_id),
      eventId: row.event_id,
      payload: row.payload,
      payloadHash: row.payload_hash,
    };
    await client.query(
      `UPDATE receipt_outbox
       SET status = 'processing',
           attempts = attempts + 1,
           lease_owner = $2,
           lease_expires_at = now() + ($3 * interval '1 second')
       WHERE id = $1`,
      [claimedId, leaseOwner, LEASE_SECONDS],
    );
    await client.query("COMMIT");

    const nextState = await appendReceiptToGit(item, config, state);

    await client.query("BEGIN");
    if (state) {
      const advanced = await client.query(
        `UPDATE receipt_ledger_state
         SET sequence = $1,
             event_hash = $2,
             receipt_entry_hash = $3,
             commit_sha = $4,
             signer_key_id = $5,
             updated_at = now()
         WHERE singleton = true
           AND sequence = $6
           AND event_hash = $7
           AND receipt_entry_hash = $8`,
        [
          nextState.sequence,
          nextState.eventHash,
          nextState.receiptEntryHash,
          nextState.commitSha,
          nextState.signerKeyId,
          state.sequence,
          state.eventHash,
          state.receiptEntryHash,
        ],
      );
      if (advanced.rowCount !== 1) throw new GitLedgerError("Local checkpoint changed during delivery", true, "checkpoint_race");
    } else {
      await client.query(
        `INSERT INTO receipt_ledger_state
           (singleton, base_receipt_id, sequence, event_hash, receipt_entry_hash, commit_sha, signer_key_id, updated_at)
         VALUES (true, $1, $2, $3, $4, $5, $6, now())`,
        [
          nextState.baseReceiptId,
          nextState.sequence,
          nextState.eventHash,
          nextState.receiptEntryHash,
          nextState.commitSha,
          nextState.signerKeyId,
        ],
      );
    }
    await client.query(
      `UPDATE receipt_outbox
       SET status = 'delivered',
           git_commit_sha = $2,
           ledger_sequence = $3,
           ledger_event_hash = $4,
           delivered_at = now(),
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_error_code = NULL
       WHERE id = $1 AND lease_owner = $5`,
      [claimedId, nextState.commitSha, nextState.sequence, nextState.eventHash, leaseOwner],
    );
    await client.query("COMMIT");
    return true;
  } catch (error: any) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original failure; the session lock is released below.
    }
    if (claimedId !== null && leaseOwner) {
      const permanent = error instanceof GitLedgerError && error.permanent;
      const attempts = Number((await safeAttemptCount(client, claimedId)) ?? MAX_ATTEMPTS);
      const blocked = permanent || attempts >= MAX_ATTEMPTS;
      const delaySeconds = Math.min(300, 2 ** Math.min(attempts, 8));
      await client.query(
        `UPDATE receipt_outbox
         SET status = $2,
             next_attempt_at = now() + ($3 * interval '1 second'),
             lease_owner = NULL,
             lease_expires_at = NULL,
             last_error_code = $4
         WHERE id = $1 AND lease_owner = $5`,
        [
          claimedId,
          blocked ? "blocked" : "pending",
          delaySeconds,
          error instanceof GitLedgerError ? error.code : "provider_error",
          leaseOwner,
        ],
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    if (locked) {
      await client.query(`SELECT pg_advisory_unlock($1)`, [OUTBOX_LOCK_ID]).catch(() => undefined);
    }
    client.release();
  }
}

async function safeAttemptCount(client: PoolClient, id: number): Promise<number | null> {
  try {
    const result = await client.query(`SELECT attempts FROM receipt_outbox WHERE id = $1`, [id]);
    return result.rows[0] ? Number(result.rows[0].attempts) : null;
  } catch {
    return null;
  }
}

export function startReceiptOutboxWorker(): void {
  if (!gitLedgerEnabled() || workerTimer) return;
  try {
    const config = getGitLedgerConfig();
    if (!config) return;
    assertLedgerSigner(config);
  } catch (error: any) {
    const code = error instanceof GitLedgerError ? error.code : "configuration_error";
    console.error(`Git receipt outbox worker is not ready (${code}).`);
    return;
  }
  workerTimer = setInterval(() => {
    void flushReceiptOutboxOnce().catch((error: any) => {
      const code = error instanceof GitLedgerError ? error.code : "provider_error";
      console.error(`Git receipt outbox delivery did not complete (${code}).`);
    });
  }, 8_000);
  workerTimer.unref?.();
  void flushReceiptOutboxOnce().catch((error: any) => {
    const code = error instanceof GitLedgerError ? error.code : "provider_error";
    console.error(`Git receipt outbox delivery did not complete (${code}).`);
  });
}

export async function getReceiptLedgerStatuses(
  receiptIds: number[],
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (receiptIds.length === 0) return result;
  const git=currentApplicationStorage();
  if (git) {
    const receipts=await git.getAllAttestationsOrdered();
    const present=new Set(receipts.map(r=>r.id));
    for (const id of receiptIds) if (present.has(id)) result.set(id,"in_git");
    return result;
  }
  if (!gitLedgerEnabled()) {
    return result;
  }
  const rows = await pool.query(
    `SELECT r.id AS receipt_id, o.status, o.git_commit_sha, s.base_receipt_id
     FROM attestation_receipts r
     LEFT JOIN receipt_outbox o ON o.receipt_id = r.id
     LEFT JOIN receipt_ledger_state s ON s.singleton = true
     WHERE r.id = ANY($1::int[])`,
    [receiptIds],
  );
  for (const row of rows.rows) {
    const status = row.status === "delivered"
      ? "in_git"
      : row.status === "pending" || row.status === "processing"
        ? "pending"
        : row.status === "blocked"
          ? "blocked"
          : row.base_receipt_id !== null && row.base_receipt_id !== undefined && row.receipt_id <= row.base_receipt_id
            ? "historical_boundary"
            : "not_anchored";
    result.set(Number(row.receipt_id), status);
  }
  return result;
}
