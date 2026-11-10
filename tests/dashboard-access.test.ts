import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
import { PgDialect } from "drizzle-orm/pg-core";

const state = vi.hoisted(() => ({
  query: vi.fn(), release: vi.fn(),
}));
vi.mock("../server/db", () => ({
  db: {}, pool: { query: state.query, connect: async () => ({ query: state.query, release: state.release }) },
}));
vi.mock("../server/middlewares/requireAuth", () => ({ requireAuth: (_req: any, _res: any, next: any) => next() }));
import { dashboardReceiptScope } from "../server/legacySqlStorage";
import { registerDashboardAccessRoutes } from "../server/dashboardAccess";

// Execute the actual generated access predicate in an isolated relational engine.
// No production connection, test server, credentials or network are needed.
function visible(subject: string, mutate = "") {
  const query = new PgDialect().sqlToQuery(dashboardReceiptScope(subject)!);
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
CREATE TABLE attestation_receipts(id integer,user_id text);
CREATE TABLE service_dashboard_bindings(id integer,issuer_id text,owner_id text,org_id integer,revoked_at text,scope text);
CREATE TABLE service_dashboard_grants(binding_id integer,receipt_id integer,revoked_at text);
CREATE TABLE organizations(id integer,owner_id text);
CREATE TABLE org_members(org_id integer,user_id text,role text);
INSERT INTO attestation_receipts VALUES (1,'alice'),(2,'bob'),(3,'forgeproof-system'),(41,'svc-a'),(42,'svc-a'),(43,'svc-b'),(44,'svc-c'),(45,'unbound');
INSERT INTO organizations VALUES(1,'alice'),(2,'bob');
INSERT INTO org_members VALUES(1,'member-a','member'),(1,'admin-a','admin'),(2,'member-b','member'),(1,'unknown-role','invented');
INSERT INTO service_dashboard_bindings VALUES(1,'svc-a',NULL,1,NULL,'selected'),(2,'svc-b',NULL,2,NULL,'selected'),(3,'svc-c','alice',NULL,NULL,'selected');
INSERT INTO service_dashboard_grants VALUES(1,41,NULL),(2,43,NULL),(3,44,NULL),(1,43,NULL);
`);
    database.exec(mutate);
    const sql = query.sql.replace(/\$(\d+)/g, (_match, index) => `:p${index}`);
    const params = Object.fromEntries(query.params.map((value, index) => [`p${index + 1}`, value]));
    return database.prepare(`SELECT id FROM attestation_receipts WHERE ${sql} ORDER BY id`).all(params).map((row: any) => row.id);
  } finally { database.close(); }
}

describe("dashboard relational isolation", () => {
  it("keeps personal and demo access, includes multiple explicitly granted principals", () => {
    expect(visible("alice")).toEqual([1, 3, 41, 44]);
    expect(visible("bob")).toEqual([2, 3, 43]);
  });
  it("uses stored organization memberships and rejects forged or unknown roles", () => {
    expect(visible("member-a")).toEqual([3, 41]);
    expect(visible("admin-a")).toEqual([3, 41]);
    expect(visible("member-b")).toEqual([3, 43]);
    expect(visible("unknown-role")).toEqual([3]);
    expect(visible("org_1")).toEqual([3]);
    expect(visible("alice@example.com")).toEqual([3]);
  });
  it("never exposes ungranted historical receipts or a mismatched issuer grant", () => {
    expect(visible("alice")).not.toContain(42);
    expect(visible("alice")).not.toContain(43);
    expect(visible("alice")).not.toContain(45);
  });
  it("honors grant, binding and membership revocation on the next read", () => {
    expect(visible("alice", "UPDATE service_dashboard_grants SET revoked_at='now' WHERE receipt_id=41;")).toEqual([1, 3, 44]);
    expect(visible("alice", "UPDATE service_dashboard_bindings SET revoked_at='now' WHERE id=1;")).toEqual([1, 3, 44]);
    expect(visible("member-a", "DELETE FROM org_members WHERE user_id='member-a';")).toEqual([3]);
  });
  it("full-service dynamically includes historical and future receipts without grants or duplicates", () => {
    const mutation = "UPDATE service_dashboard_bindings SET scope='full-service' WHERE id=1; INSERT INTO attestation_receipts VALUES(46,'svc-a'),(47,'svc-b'); INSERT INTO org_members VALUES(1,'alice','admin');";
    expect(visible("alice", mutation)).toEqual([1, 3, 41, 42, 44, 46]);
    expect(visible("bob", mutation)).toEqual([2, 3, 43]);
    expect(visible("member-a", mutation)).toEqual([3, 41, 42, 46]);
    expect(visible("alice", mutation + "UPDATE service_dashboard_bindings SET revoked_at='now' WHERE id=1;")).toEqual([1, 3, 44]);
    expect(visible("member-a", mutation + "DELETE FROM org_members WHERE user_id='member-a';")).toEqual([3]);
    expect(visible("alice", mutation + "DELETE FROM organizations WHERE id=1;")).toEqual([1, 3, 44]);
  });
  it("unknown scope fails closed and revoked selected grants do not reveal future receipts", () => {
    expect(visible("alice", "UPDATE service_dashboard_bindings SET scope='unknown' WHERE id=1;")).toEqual([1, 3, 44]);
  });
  it("parameterizes hostile subjects without changing authorization", () => {
    expect(visible("alice' OR 1=1 --")).toEqual([3]);
  });
});

const handlers = new Map<string, any>();
registerDashboardAccessRoutes({
  post: (path: string, ...fns: any[]) => handlers.set(`POST ${path}`, fns.at(-1)),
  delete: (path: string, ...fns: any[]) => handlers.set(`DELETE ${path}`, fns.at(-1)),
} as any);
async function invoke(method: string, path: string, body: any, subject = "alice", id = "1") {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), sendStatus: vi.fn() };
  const next = vi.fn();
  await handlers.get(`${method} ${path}`)({ body, dbUser: { id: subject }, params: { id } }, res, next);
  expect(next).not.toHaveBeenCalled();
  return res;
}
beforeEach(() => { vi.clearAllMocks(); });
describe("grant administration", () => {
  it("requires an active verified binding even for a tenant admin", async () => {
    state.query.mockResolvedValue({ rows: [] });
    const res = await invoke("POST", "/api/dashboard-access/grants", { bindingId: 1, receiptId: 41 });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(state.query.mock.calls.some(([sql]) => sql.includes("INSERT"))).toBe(false);
    expect(state.release).toHaveBeenCalled();
  });
  it.each(["member", "owner", "invented"])("rejects membership role %s without actual ownership", async role => {
    state.query.mockImplementation(async (sql: string) => ({ rows:
      sql.includes("SELECT b.*") ? [{ id: 1, issuer_id: "svc-a", org_id: 1 }] :
      sql.includes("SELECT owner_id") ? [{ owner_id: "bob" }] :
      sql.includes("SELECT role") ? [{ role }] : [] }));
    const res = await invoke("POST", "/api/dashboard-access/grants", { bindingId: 1, receiptId: 41 });
    expect(res.status).toHaveBeenCalledWith(403);
  });
  it.each(["actual-owner", "admin", "personal-owner"])("allows genuine %s to explicitly grant one issuer-owned receipt", async authority => {
    state.query.mockImplementation(async (sql: string) => ({ rows:
      sql.includes("SELECT b.*") ? [{ id: 1, scope: "selected", issuer_id: "svc-a", ...(authority === "personal-owner" ? { owner_id: "alice" } : { org_id: 1 }) }] :
      sql.includes("SELECT owner_id") ? [{ owner_id: authority === "actual-owner" ? "alice" : "bob" }] :
      sql.includes("SELECT role") ? [{ role: authority }] :
      sql.includes("INSERT") ? [{ id: 8 }] : [] }));
    const res = await invoke("POST", "/api/dashboard-access/grants", { bindingId: 1, receiptId: 41 });
    expect(res.status).toHaveBeenCalledWith(201);
    const insert = state.query.mock.calls.find(([sql]) => sql.includes("INSERT"))!;
    expect(insert[0]).toContain("user_id = $4");
    expect(insert[1]).toEqual([1, 41, "alice", "svc-a"]);
    expect(state.query).toHaveBeenCalledWith("COMMIT");
  });
  it("rejects caller supplied authority and invalid receipt IDs", async () => {
    const res = await invoke("POST", "/api/dashboard-access/grants", { bindingId: 1, receiptId: 41, orgId: 1 });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(state.query).not.toHaveBeenCalled();
  });
  it("rejects per-receipt mutations for full-service scope", async () => {
    state.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("SELECT b.*")
      ? [{ id: 1, owner_id: "alice", scope: "full-service" }] : [] }));
    expect((await invoke("POST", "/api/dashboard-access/grants", { bindingId: 1, receiptId: 41 })).status).toHaveBeenCalledWith(409);
    expect(state.query.mock.calls.some(([sql]) => sql.includes("INSERT"))).toBe(false);
  });
  it.each(["grants", "bindings"])("revokes %s under locked current authority", async resource => {
    state.query.mockResolvedValue({ rows: [] });
    expect((await invoke("DELETE", `/api/dashboard-access/${resource}/:id`, {})).status).toHaveBeenCalledWith(403);
    state.query.mockImplementation(async (sql: string) => ({ rows:
      sql.includes("SELECT b.*") ? [{ id: 1, org_id: 1 }] :
      sql.includes("SELECT owner_id") ? [{ owner_id: "alice" }] : [] }));
    expect((await invoke("DELETE", `/api/dashboard-access/${resource}/:id`, {})).sendStatus).toHaveBeenCalledWith(204);
    expect(state.query.mock.calls.some(([sql]) => sql.includes("FOR UPDATE OF b"))).toBe(true);
    expect(state.query).toHaveBeenCalledWith("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2 FOR UPDATE", [1, "alice"]);
    expect(state.query).toHaveBeenCalledWith("COMMIT");
  });
});


describe("additive migration constraints in SQLite compatibility rehearsal", () => {
  it("keeps receipt rows intact and enforces target, ownership, uniqueness and foreign keys", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`PRAGMA foreign_keys = ON;
        CREATE TABLE users(id varchar PRIMARY KEY);
        CREATE TABLE organizations(id integer PRIMARY KEY);
        CREATE TABLE attestation_receipts(id integer PRIMARY KEY);
        INSERT INTO users VALUES ('svc'), ('alice'), ('bob');
        INSERT INTO organizations VALUES (1);
        INSERT INTO attestation_receipts VALUES (41);`);
      // SQLite compatibility substitutions only; real PostgreSQL deployment is
      // still a mandatory independent release gate.
      const migration = readFileSync(new URL("../migrations/20261108_dashboard_access.sql", import.meta.url), "utf8")
        .replaceAll("serial PRIMARY KEY", "integer PRIMARY KEY")
        .replaceAll("DEFAULT now()", "DEFAULT CURRENT_TIMESTAMP");
      db.exec(migration);
      db.exec("INSERT INTO service_dashboard_principals VALUES('svc','user:alice');");
      const bind = db.prepare("INSERT INTO service_dashboard_bindings(issuer_id,owner_id,org_id,evidence,verified_by,tenant_key) VALUES(?,?,?,?,?,'user:alice')");
      expect(() => bind.run('svc', null, null, 'approval', 'operator')).toThrow();
      expect(() => bind.run('svc', 'alice', 1, 'approval', 'operator')).toThrow();
      expect(() => bind.run('svc', 'svc', null, 'approval', 'operator')).toThrow();
      expect(() => bind.run('svc', 'alice', null, '', 'operator')).toThrow();
      expect(() => bind.run('missing', 'alice', null, 'approval', 'operator')).toThrow();
      bind.run('svc', 'alice', null, 'approval', 'operator');
      expect(() => bind.run('svc', 'bob', null, 'approval', 'operator')).toThrow();
      const grant = db.prepare("INSERT INTO service_dashboard_grants(binding_id,receipt_id,granted_by) VALUES(1,?,'alice')");
      expect(() => grant.run(99)).toThrow();
      grant.run(41);
      expect(() => grant.run(41)).toThrow();
      db.exec("UPDATE service_dashboard_grants SET revoked_at=CURRENT_TIMESTAMP");
      grant.run(41);
      db.exec("UPDATE service_dashboard_bindings SET revoked_at=CURRENT_TIMESTAMP;");
      expect(() => bind.run('svc', 'bob', null, 'new approval', 'operator')).toThrow();
      expect(() => db.exec("UPDATE service_dashboard_bindings SET scope='invalid' WHERE id=1")).toThrow();
      expect(() => db.exec("UPDATE service_dashboard_bindings SET scope='full-service' WHERE id=1")).toThrow();
      db.exec("UPDATE service_dashboard_bindings SET scope='full-service',scope_evidence='explicit historical and future approval' WHERE id=1");
      expect(() => db.exec("UPDATE service_dashboard_bindings SET scope='selected' WHERE id=1")).toThrow();
      db.exec("INSERT INTO users VALUES('org-svc'); INSERT INTO service_dashboard_principals VALUES('org-svc','org:1'); INSERT INTO service_dashboard_bindings(issuer_id,org_id,tenant_key,evidence,verified_by) VALUES('org-svc',1,'org:1','approval','operator');");
      db.exec("DELETE FROM organizations WHERE id=1;");
      expect(db.prepare("SELECT count(*) AS n FROM service_dashboard_bindings WHERE org_id=1").get().n).toBe(0);
      expect(() => db.exec("INSERT INTO service_dashboard_bindings(issuer_id,owner_id,tenant_key,evidence,verified_by) VALUES('org-svc','bob','user:bob','new approval','operator')")).toThrow();
      expect(db.prepare("SELECT tenant_key FROM service_dashboard_principals WHERE issuer_id='org-svc'").get().tenant_key).toBe("org:1");
      expect(db.prepare("SELECT count(*) AS n FROM attestation_receipts").get().n).toBe(1);
    } finally { db.close(); }
  });
});

