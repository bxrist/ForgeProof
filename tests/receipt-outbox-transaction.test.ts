import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  query: vi.fn(), release: vi.fn(), append: vi.fn(),
  item: { id: 1, receiptId: 46, eventId: "event", payloadHash: "payload", payload: { prevEntryHash: "base", entryHash: "next" } },
  status: "pending",
}));
vi.mock("../server/db", () => ({
  pool: { connect: async () => ({ query: fixture.query, release: fixture.release }) },
}));
vi.mock("../server/gitLedger", () => ({
  gitLedgerEnabled: () => true,
  getGitLedgerConfig: () => ({ baseReceiptId: 45, baseReceiptEntryHash: "base" }),
  assertLedgerSigner: () => undefined,
  createLedgerOutboxItem: () => fixture.item,
  appendReceiptToGit: fixture.append,
  GitLedgerError: class extends Error {
    constructor(message: string, public permanent = true, public code = "ledger_error") { super(message); }
  },
}));
import { enqueueReceiptOutbox, flushReceiptOutboxOnce, stagingArchivePredecessor } from "../server/receiptOutbox";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.status = "pending";
  fixture.query.mockImplementation(async (sql: string) => {
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
    if (sql.includes("FROM receipt_ledger_state")) return { rows: [{
      base_receipt_id: 45, sequence: 1, event_hash: "event-base",
      receipt_entry_hash: "base", commit_sha: "commit-base", signer_key_id: "signer",
    }] };
    if (sql.includes("FROM receipt_outbox o") && sql.includes("WHERE o.status")) return { rows: [{
      id: 1, receipt_id: 46, event_id: "event", payload_hash: "payload",
      payload: fixture.item.payload, status: fixture.status,
      attempts: 0, next_attempt_at: new Date(0), lease_expires_at: null,
    }] };
    if (sql.includes("SELECT attempts")) return { rows: [{ attempts: 1 }] };
    if (sql.includes("INSERT INTO receipt_outbox")) return { rows: [{ id: 1 }] };
    return { rows: [], rowCount: 1 };
  });
  fixture.append.mockResolvedValue({
    baseReceiptId: 45, sequence: 2, eventHash: "event-next",
    receiptEntryHash: "next", commitSha: "commit-next", signerKeyId: "signer",
  });
});

describe("transactional receipt capture and acknowledgement", () => {
  it("uses a checkpoint for empty isolated staging only, and fails closed without one", async () => {
    vi.stubEnv("FORGEPROOF_ISOLATED_STAGING", "true");
    try {
      expect(await stagingArchivePredecessor({ query: fixture.query } as any)).toBe("base");
      fixture.query.mockResolvedValueOnce({ rows: [] });
      await expect(stagingArchivePredecessor({ query: fixture.query } as any)).rejects.toThrow("verified archive checkpoint");
      vi.stubEnv("FORGEPROOF_ISOLATED_STAGING", "");
      fixture.query.mockClear();
      expect(await stagingArchivePredecessor({ query: fixture.query } as any)).toBeNull();
      expect(fixture.query).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
  it("enqueues on the caller's connection without committing independently", async () => {
    await expect(enqueueReceiptOutbox({ query: fixture.query } as any, {})).resolves.toBe("pending");
    const commands = fixture.query.mock.calls.map(([sql]) => sql);
    expect(commands.some(sql => sql.includes("INSERT INTO receipt_outbox"))).toBe(true);
    expect(commands).not.toContain("COMMIT");
    expect(commands).not.toContain("BEGIN");
    expect(fixture.append).not.toHaveBeenCalled();
  });

  it("acknowledges the checkpoint and outbox row together after Git succeeds", async () => {
    expect(await flushReceiptOutboxOnce()).toBe(true);
    const commands = fixture.query.mock.calls.map(([sql]) => sql);
    const checkpointIndex = commands.findIndex(sql => sql.includes("UPDATE receipt_ledger_state"));
    const deliveredIndex = commands.findIndex(sql => sql.includes("status = 'delivered'"));
    const commits = commands.map((sql, index) => sql === "COMMIT" ? index : -1).filter(index => index >= 0);
    expect(commits).toHaveLength(2);
    expect(checkpointIndex).toBeGreaterThan(commits[0]);
    expect(deliveredIndex).toBeGreaterThan(checkpointIndex);
    expect(commits[1]).toBeGreaterThan(deliveredIndex);
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("keeps durable intent retryable when Git is unavailable", async () => {
    fixture.append.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(flushReceiptOutboxOnce()).rejects.toThrow("provider unavailable");
    const commands = fixture.query.mock.calls.map(([sql]) => sql);
    expect(commands).not.toContain(expect.stringContaining("status = 'delivered'"));
    expect(fixture.query.mock.calls.some(([sql, args]) =>
      sql.includes("SET status = $2") && args[1] === "pending"
    )).toBe(true);
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("does not skip an earlier blocked event to deliver a later receipt", async () => {
    fixture.status = "blocked";
    expect(await flushReceiptOutboxOnce()).toBe(false);
    expect(fixture.append).not.toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledOnce();
  });
});
