import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionLifeos, exclusiveSecretFile } from "../scripts/provision-lifeos";

function fixture(opts: { keys?: any[]; users?: any[]; subs?: any[]; failInsert?: boolean } = {}) {
  const calls: Array<[string, unknown[] | undefined]> = [];
  let id = 41;
  const client = { query: vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push([sql, params]);
    if (sql.startsWith("SELECT id FROM users")) return { rows: opts.users ?? (params?.[0] === "owner-1" ? [{ id: "owner-1" }] : []) };
    if (sql.includes("FROM subscriptions")) return { rows: opts.subs ?? [] };
    if (sql.includes("FROM api_keys WHERE user_id")) return { rows: opts.keys ?? [] };
    if (sql.includes("FROM api_keys WHERE key_hash")) return { rows: [] };
    if (sql.startsWith("INSERT INTO api_keys")) { if (opts.failInsert) throw new Error("insert failed"); return { rows: [{ id: id++ }] }; }
    if (sql.startsWith("INSERT INTO users")) return { rows: [] };
    return { rows: [] };
  }) };
  return { client, calls };
}
const base = { ownerSubject: "owner-1", approvalReference: "ticket-123", secretFile: "/tmp/lifeos-key", expiresAt: new Date(Date.now() + 86400000) };
const run = (f: ReturnType<typeof fixture>, extra: any = {}) => provisionLifeos({ apply: false, ...base, productionVerified: false, ...extra }, { client: f.client, writeSecret: vi.fn(async () => async () => {}), token: "fp_sk_private-test-value", now: new Date() });

describe("LifeOS one-time provisioner", () => {
  it("dry-runs without writes or billing mutation", async () => {
    const f = fixture();
    expect(await run(f)).toMatchObject({ status: "dry-run-ready", expected: { createSubject: "lifeos-service-0a", createInactiveKey: true, permissions: ["attest:write"], ownerCheck: "existing-separate-owner-verified" } });
    expect(f.calls.some(([sql]) => /^(BEGIN|INSERT|UPDATE|DELETE|COMMIT)/.test(sql))).toBe(false);
    expect(f.calls.some(([sql]) => sql.includes("subscriptions") && /UPDATE|INSERT|DELETE/.test(sql))).toBe(false);
  });
  it("rejects wrong identity and key collisions", async () => {
    await expect(run(fixture(), { ownerSubject: "lifeos-service-0a" })).rejects.toThrow(/separate approving owner/);
    await expect(run(fixture({ keys: [{ id: 9 }] }))).rejects.toThrow(/already has an API key/);
  });
  it("requires explicit verified runtime for apply and rolls back failures", async () => {
    await expect(run(fixture(), { apply: true })).rejects.toThrow(/requires independent database identity and operator confirmation/);
    const f = fixture({ failInsert: true });
    await expect(run(f, { apply: true, productionVerified: true })).rejects.toThrow(/insert failed/);
    expect(f.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
    expect(f.calls.some(([sql]) => sql.includes("UPDATE subscriptions"))).toBe(false);
  });
  it("inserts one inactive write-only key and audit row without subscription writes", async () => {
    const f = fixture();
    const writeSecret = vi.fn(async () => async () => {});
    const result = await provisionLifeos({ apply: true, ...base, productionVerified: true }, { client: f.client, writeSecret, token: "fp_sk_private-test-value", now: new Date() });
    expect(result).toMatchObject({ status: "provisioned-inactive", subject: "lifeos-service-0a", apiKeyId: 41 });
    const insert = f.calls.find(([sql]) => sql.startsWith("INSERT INTO api_keys"))?.[0] ?? "";
    expect(insert).toContain("ARRAY['attest:write'], false");
    expect(f.calls.some(([sql]) => sql.includes("INSERT INTO audit_logs"))).toBe(true);
    expect(f.calls.some(([sql]) => sql.includes("UPDATE subscriptions") || sql.includes("INSERT INTO subscriptions"))).toBe(false);
    expect(writeSecret).toHaveBeenCalledOnce();
  });
  it("preserves a preexisting secret file on exclusive-create rejection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifeos-provision-"));
    const path = join(dir, "secret");
    await writeFile(path, "keep-this\n", { mode: 0o600 });
    try {
      await expect(exclusiveSecretFile(path, "new-secret")).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe("keep-this\n");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
