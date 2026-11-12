/**
 * Access-control tests for GET /api/attestations/:id/lineage
 *
 * Convention: vitest + supertest for server-route tests.
 * Auth and storage are mocked; no real DB or OIDC connections are made.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";
import { createServer } from "http";
import type { Request, Response, NextFunction } from "express";

// ─── Mutable auth ref (must be declared before vi.mock factories run) ─────────
const authCtx = vi.hoisted(() => ({ userId: null as string | null }));

// ─── Mock: auth middleware ────────────────────────────────────────────────────
vi.mock("../server/middlewares/requireAuth", () => ({
  optionalAuth: (_req: any, _res: any, next: any) => next(),
  sessionUserId: () => authCtx.userId,
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    if (!authCtx.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    (req as any).dbUser = { id: authCtx.userId };
    next();
  },
}));

// ─── Mock: storage ───────────────────────────────────────────────────────────
const mockStorage = vi.hoisted(() => ({
  getAttestation: vi.fn(),
  getAttestations: vi.fn(),
  getAttestationsByFilePath: vi.fn(),
  getAttestationsByParentId: vi.fn(),
  // stubs for methods routes.ts may touch during setup/teardown
  getApiKeyByHash: vi.fn().mockResolvedValue(null),
  updateApiKeyLastUsed: vi.fn().mockResolvedValue(undefined),
  getOrCreateFreeSubscription: vi.fn(),
  createAuditLog: vi.fn().mockResolvedValue({}),
}));

vi.mock("../server/storage", () => ({ storage: mockStorage }));

const memberDb = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), connect: vi.fn() }));

// ─── Mock: db pool (only used by createAttestationReceipt, not lineage) ───────
vi.mock("../server/db", () => ({
  pool: { connect: memberDb.connect },
  db: {},
}));

// ─── Mock: crypto helpers (not exercised by lineage endpoint) ─────────────────
vi.mock("../server/crypto", () => ({
  sha256: vi.fn((s: string) => s),
  signData: vi.fn(() => "sig"),
  getKeyPair: vi.fn(() => ({ publicKey: "pk", privateKey: "sk" })),
  computeEntryHash: vi.fn(() => "entryhash"),
  generateApiKey: vi.fn(() => ({ key: "k", hash: "h", prefix: "pre" })),
  verifySignature: vi.fn(() => true),
}));

// ─── Mock: github, mcp, email (not exercised by lineage endpoint) ─────────────
vi.mock("../server/github", () => ({
  fetchUserRepos: vi.fn(),
  fetchRepoFiles: vi.fn(),
  fetchFileContent: vi.fn(),
  fetchRepoCommits: vi.fn(),
  fetchCommitFiles: vi.fn(),
  commitAttestationToGit: vi.fn(),
}));

vi.mock("../server/mcp", () => ({
  getMcpManifest: vi.fn(() => ({})),
  handleMcpTool: vi.fn(),
}));

vi.mock("../server/email", () => ({
  sendGitCommitFailureEmail: vi.fn(),
}));

// ─── Shared fixture data ──────────────────────────────────────────────────────

function makeAttestation(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    userId: "user-alice",
    orgId: null,
    repositoryId: null,
    fileHash: "hash-abc",
    fileName: "model.py",
    filePath: "src/model.py",
    modelName: "gpt-4",
    modelProvider: "OpenAI",
    countryOfOrigin: "US",
    detectedCountry: "US",
    complianceStatus: "verified",
    attestationType: "origin",
    parentAttestationId: null,
    auditVerdict: null,
    auditDetails: null,
    signature: "sig",
    publicKey: "pk",
    prevEntryHash: null,
    entryHash: "entry-1",
    receiptVersion: "v1",
    signedAt: "2024-01-01T00:00:00.000Z",
    gitCommitUrl: null,
    gitCommitMessage: null,
    metadata: null,
    createdAt: new Date("2024-01-01"),
    ...overrides,
  };
}

// ─── App bootstrap (once per file) ───────────────────────────────────────────
let app: express.Express;

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (authCtx.userId) (req as any).dbUser = { id: authCtx.userId };
    next();
  });
  const httpServer = createServer(app);
  const { registerRoutes } = await import("../server/routes");
  await registerRoutes(httpServer, app);
});

beforeEach(() => {
  vi.clearAllMocks();
  authCtx.userId = null;
  // Default stubs (individual tests override as needed)
  mockStorage.getAttestation.mockResolvedValue(undefined);
  mockStorage.getAttestations.mockResolvedValue([]);
  mockStorage.getAttestationsByFilePath.mockResolvedValue([]);
  mockStorage.getAttestationsByParentId.mockReset().mockResolvedValue([]);
});

describe("Parent links and provenance graph authorization", () => {
  for (const owner of ["user-bob", "forgeproof-system"]) {
    for (const type of ["origin", "refactor", "review", "security_audit"]) {
      it(`rejects ${type} links to ${owner}, including origin-parent bypass`, async () => {
        authCtx.userId = "user-alice";
        mockStorage.getAttestation.mockResolvedValue(makeAttestation({ userId: owner }));
        const res = await supertest(app).post("/api/v1/attest").send({
          file_path: "test.py", file_hash: "a".repeat(64),
          model_name: "Claude", model_provider: "Anthropic", country_of_origin: "US",
          attestation_type: type, parent_attestation_id: 1, audit_verdict: "secure",
        });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe("Parent attestation not found");
        expect(mockStorage.getOrCreateFreeSubscription).not.toHaveBeenCalled();
      });
    }
  }

  it("rejects a free API key linking another owner's receipt", async () => {
    mockStorage.getApiKeyByHash.mockResolvedValueOnce({ id: 1, userId: "user-alice", isActive: true, permissions:["attest:read","attest:write"] });
    mockStorage.getAttestation.mockResolvedValue(makeAttestation({ userId: "user-bob" }));
    const res = await supertest(app).post("/api/v1/attest").set("Authorization", "Bearer test").send({
      file_path: "test.py", file_hash: "a".repeat(64), model_name: "Claude",
      model_provider: "Anthropic", country_of_origin: "US",
      attestation_type: "review", parent_attestation_id: 1,
    });
    expect(res.status).toBe(400);
    expect(mockStorage.getOrCreateFreeSubscription).not.toHaveBeenCalled();
  });

  it("denies anonymous and different-owner private chain reads", async () => {
    mockStorage.getAttestation.mockResolvedValue(makeAttestation());
    expect((await supertest(app).get("/api/v1/attestation/1/chain")).status).toBe(403);
    authCtx.userId = "user-bob";
    expect((await supertest(app).get("/api/v1/attestation/1/chain")).status).toBe(403);
    expect(mockStorage.getAttestationsByParentId).not.toHaveBeenCalled();
  });

  it("allows owner chains but stops at historical foreign parents", async () => {
    authCtx.userId = "user-alice";
    mockStorage.getAttestation.mockImplementation(async (id) => id === 1
      ? makeAttestation({ parentAttestationId: 2 })
      : makeAttestation({ id: 2, userId: "user-bob" }));
    const res = await supertest(app).get("/api/v1/attestation/1/chain");
    expect(res.status).toBe(200);
    expect(res.body.rootId).toBe(1);
    expect(res.body.attestations).toHaveLength(1);
    expect(mockStorage.getAttestationsByParentId).toHaveBeenCalledWith(1, "user-alice");
  });

  it("keeps public demo graphs and details scoped to system receipts", async () => {
    mockStorage.getAttestation.mockResolvedValue(makeAttestation({ userId: "forgeproof-system" }));
    expect((await supertest(app).get("/api/v1/attestation/1/chain")).status).toBe(200);
    expect((await supertest(app).get("/api/demo/attestations/1")).status).toBe(200);
    expect(mockStorage.getAttestationsByParentId).toHaveBeenCalledWith(1, "forgeproof-system");
  });

  it.each(["forgeproof-system", "user-alice"])("allowlists chain output for %s just like lookup", async (owner) => {
    if (owner !== "forgeproof-system") authCtx.userId = owner;
    const root = makeAttestation({
      userId: owner, metadata: { session_id: "private-session" },
      auditDetails: "private audit", gitCommitMessage: "private commit",
    });
    const child = makeAttestation({ id: 2, userId: owner, parentAttestationId: 1 });
    mockStorage.getAttestation.mockResolvedValue(root);
    mockStorage.getAttestationsByParentId.mockImplementation(async (id) => id === 1 ? [child] : []);

    const lookup = await supertest(app).get("/api/lookup?q=1");
    const chain = await supertest(app).get("/api/v1/attestation/1/chain");
    expect(lookup.status).toBe(200);
    expect(chain.status).toBe(200);
    expect(chain.body.chainLength).toBe(2);
    expect(chain.body.attestations[0]).toEqual(lookup.body);
    const allowedKeys = [
      "id", "fileName", "filePath", "fileHash", "entryHash", "prevEntryHash",
      "signatureValid", "hashMatch", "complianceStatus", "detectedCountry",
      "countryOfOrigin", "modelName", "modelProvider", "signature", "publicKey",
      "receiptVersion", "createdAt", "signedAt",
    ].sort();
    for (const entry of chain.body.attestations) {
      expect(Object.keys(entry).sort()).toEqual(allowedKeys);
    }
    expect(JSON.stringify(chain.body)).not.toContain("private");
  });

  it("never includes or traverses foreign children, even from legacy mixed graphs", async () => {
    mockStorage.getAttestation.mockResolvedValue(makeAttestation({ userId: "forgeproof-system" }));
    mockStorage.getAttestationsByParentId.mockResolvedValueOnce([
      makeAttestation({ id: 2, userId: "user-bob", parentAttestationId: 1 }),
      makeAttestation({ id: 3, userId: "forgeproof-system", parentAttestationId: 1 }),
    ]);
    const res = await supertest(app).get("/api/v1/attestation/1/chain");
    expect(res.status).toBe(200);
    expect(res.body.attestations.map((entry: any) => entry.id)).toEqual([1, 3]);
    expect(res.body.chainLength).toBe(2);
    expect(mockStorage.getAttestationsByParentId.mock.calls).toEqual([
      [1, "forgeproof-system"], [3, "forgeproof-system"],
    ]);
  });

  it("scopes private detail children to the receipt owner", async () => {
    authCtx.userId = "user-alice";
    mockStorage.getAttestation.mockResolvedValue(makeAttestation());
    expect((await supertest(app).get("/api/attestations/1")).status).toBe(200);
    expect(mockStorage.getAttestationsByParentId).toHaveBeenCalledWith(1, "user-alice");
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/attestations/:id/lineage — access control", () => {
  it("1. Owner can fetch lineage for their own attestation", async () => {
    authCtx.userId = "user-alice";

    const attestation = makeAttestation({ id: 10, userId: "user-alice" });
    const lineageItems = [
      makeAttestation({ id: 5, userId: "user-alice", filePath: "src/model.py", createdAt: new Date("2024-01-01") }),
      makeAttestation({ id: 10, userId: "user-alice", filePath: "src/model.py", createdAt: new Date("2024-03-01") }),
    ];

    mockStorage.getAttestation.mockResolvedValue(attestation);
    mockStorage.getAttestations.mockResolvedValue(lineageItems);

    const res = await supertest(app).get("/api/attestations/10/lineage");

    expect(res.status).toBe(200);
    expect(res.body.filePath).toBe("src/model.py");
    expect(res.body.lineage).toHaveLength(2);
    expect(mockStorage.getAttestations).toHaveBeenCalledWith("user-alice");
  });

  it("2. Accessible demo receipts do not become another issuer's logical history", async () => {
    authCtx.userId = "user-alice";

    const attestation = makeAttestation({ id: 20, userId: "user-alice", filePath: "src/demo.py" });
    const lineageItems = [
      makeAttestation({ id: 1, userId: "forgeproof-system", filePath: "src/demo.py", createdAt: new Date("2023-06-01") }),
      makeAttestation({ id: 20, userId: "user-alice",        filePath: "src/demo.py", createdAt: new Date("2024-01-01") }),
    ];

    mockStorage.getAttestation.mockResolvedValue(attestation);
    mockStorage.getAttestations.mockResolvedValue(lineageItems);

    const res = await supertest(app).get("/api/attestations/20/lineage");

    expect(res.status).toBe(200);
    const userIds = res.body.lineage.map((r: any) => r.userId);
    expect(userIds).not.toContain("forgeproof-system");
    expect(userIds).toContain("user-alice");
  });

  it("3. A different user requesting another user's attestation lineage gets 403", async () => {
    authCtx.userId = "user-bob";

    // The root attestation belongs to alice
    const aliceAttestation = makeAttestation({ id: 30, userId: "user-alice" });
    mockStorage.getAttestation.mockResolvedValue(aliceAttestation);

    const res = await supertest(app).get("/api/attestations/30/lineage");

    expect(res.status).toBe(403);
    // Storage lineage query must NOT have been called
    expect(mockStorage.getAttestationsByFilePath).not.toHaveBeenCalled();
  });

  it("4. Lineage for a shared file path excludes other users' private receipts", async () => {
    authCtx.userId = "user-alice";

    const attestation = makeAttestation({ id: 40, userId: "user-alice", filePath: "shared/lib.py" });
    // Storage layer is responsible for filtering; it must receive alice's userId so it
    // can apply the (userId = alice OR userId = forgeproof-system) predicate.
    // The mock returns only the items that pass that filter — simulating correct DB behaviour.
    const filteredLineage = [
      makeAttestation({ id: 2,  userId: "forgeproof-system", filePath: "shared/lib.py", createdAt: new Date("2023-01-01") }),
      makeAttestation({ id: 40, userId: "user-alice",        filePath: "shared/lib.py", createdAt: new Date("2024-01-01") }),
    ];
    // bob's receipt (id: 99) is NOT in the returned slice — it was excluded by DB query.

    mockStorage.getAttestation.mockResolvedValue(attestation);
    mockStorage.getAttestations.mockResolvedValue(filteredLineage);

    const res = await supertest(app).get("/api/attestations/40/lineage");

    expect(res.status).toBe(200);
    // Verify the route passed alice's userId to the storage filter
    expect(mockStorage.getAttestations).toHaveBeenCalledWith("user-alice");
    // Accessible system receipts still belong to a distinct issuer's history.
    const returnedUserIds: string[] = res.body.lineage.map((r: any) => r.userId);
    expect(returnedUserIds).toEqual(["user-alice"]);
    // bob's receipt must not appear
    const ids: number[] = res.body.lineage.map((r: any) => r.id);
    expect(ids).not.toContain(99);
  });

  it("5. Lineage is ordered oldest-to-newest (ascending by id)", async () => {
    authCtx.userId = "user-alice";

    const attestation = makeAttestation({ id: 50, userId: "user-alice", filePath: "src/train.py" });
    // Storage returns items already sorted asc by id (mirrors getAttestationsByFilePath ordering)
    const orderedLineage = [
      makeAttestation({ id: 3,  userId: "user-alice", filePath: "src/train.py", createdAt: new Date("2023-03-01") }),
      makeAttestation({ id: 12, userId: "user-alice", filePath: "src/train.py", createdAt: new Date("2023-06-15") }),
      makeAttestation({ id: 50, userId: "user-alice", filePath: "src/train.py", createdAt: new Date("2024-01-01") }),
    ];

    mockStorage.getAttestation.mockResolvedValue(attestation);
    mockStorage.getAttestations.mockResolvedValue([...orderedLineage].reverse());

    const res = await supertest(app).get("/api/attestations/50/lineage");

    expect(res.status).toBe(200);
    const ids: number[] = res.body.lineage.map((r: any) => r.id);
    // Must be strictly ascending
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
    expect(ids[0]).toBe(3);
    expect(ids[ids.length - 1]).toBe(50);
  });

  it("returns 401 when unauthenticated", async () => {
    authCtx.userId = null;
    const res = await supertest(app).get("/api/attestations/1/lineage");
    expect(res.status).toBe(401);
  });

  it("returns 404 when attestation does not exist", async () => {
    authCtx.userId = "user-alice";
    mockStorage.getAttestation.mockResolvedValue(undefined);
    const res = await supertest(app).get("/api/attestations/9999/lineage");
    expect(res.status).toBe(404);
  });
});

describe("Public chain rate limiting", () => {
  it("shares the 300-request verification budget and blocks before storage access", async () => {
    const first = await supertest(app).get("/api/v1/attestation/invalid/chain");
    expect(first.status).toBe(400);
    expect(first.headers["ratelimit-limit"]).toBe("300");
    const remaining = Number(first.headers["ratelimit-remaining"]);
    expect(Number.isInteger(remaining)).toBe(true);
    for (let i = 0; i < remaining; i++) {
      expect((await supertest(app).get("/api/v1/attestation/invalid/chain")).status).toBe(400);
    }
    const blocked = await supertest(app).get("/api/v1/attestation/1/chain");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ message: "Too many verification requests." });
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(mockStorage.getAttestation).not.toHaveBeenCalled();
    expect((await supertest(app).get("/api/lookup?q=1")).status).toBe(429);
  });
});

// Invoke real route handlers directly as well, so authorization remains testable
// in restricted runners where Supertest cannot open a listening socket.
async function directDashboard(path: string, id: number, subject = "user-alice") {
  const layer = (app as any).router.stack.find((entry: any) => entry.route?.path === path);
  const handler = layer.route.stack.at(-1).handle;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn(), type: vi.fn().mockReturnThis(), setHeader: vi.fn() };
  await handler({ params: { id: String(id) }, dbUser: { id: subject } }, res);
  return res;
}
describe("service dashboard route boundaries without network", () => {
  it("denies an ungranted service receipt's detail and lineage", async () => {
    mockStorage.getAttestation.mockResolvedValue(makeAttestation({ id: 41, userId: "service-a" }));
    for (const route of ["/api/attestations/:id", "/api/attestations/:id/lineage"]) {
      const res = await directDashboard(route, 41);
      expect(res.status).toHaveBeenCalledWith(403);
    }
    expect(mockStorage.getAttestationsByFilePath).not.toHaveBeenCalled();
  });
  it("embeds only explicitly visible children from the same issuer", async () => {
    const parent = makeAttestation({ id: 41, userId: "service-a" });
    const visibleChild = makeAttestation({ id: 42, userId: "service-a", parentAttestationId: 41 });
    mockStorage.getAttestation.mockResolvedValue(parent);
    mockStorage.getAttestations.mockResolvedValue([parent, visibleChild,
      makeAttestation({ id: 44, userId: "service-b", parentAttestationId: 41 })]);
    const res = await directDashboard("/api/attestations/:id", 41);
    expect(res.json).toHaveBeenCalledWith({ ...parent, childAttestations: [visibleChild] });
    expect(mockStorage.getAttestationsByParentId).not.toHaveBeenCalled();
  });
  it("scopes service lineage to both viewer authority and actual issuer", async () => {
    const parent = makeAttestation({ id: 41, userId: "service-a" });
    mockStorage.getAttestation.mockResolvedValue(parent);
    mockStorage.getAttestations.mockResolvedValue([parent]);
    mockStorage.getAttestationsByFilePath.mockResolvedValue([parent]);
    const res = await directDashboard("/api/attestations/:id/lineage", 41);
    expect(mockStorage.getAttestations).toHaveBeenCalledWith("user-alice");
    expect(mockStorage.getAttestationsByFilePath).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ lineage: [parent] }));
  });
  it("exports authorized service receipts and denies the same receipt after revocation", async () => {
    const parent = makeAttestation({ id: 41, userId: "service-a" });
    authCtx.userId = "user-alice";
    mockStorage.getAttestation.mockResolvedValue(parent);
    mockStorage.getAttestations.mockResolvedValue([parent]);
    const allowed = await directDashboard("/api/receipt/:id/export", 41);
    expect(allowed.status).not.toHaveBeenCalled();
    expect(allowed.send).toHaveBeenCalledWith(expect.stringContaining("<!DOCTYPE html>"));
    mockStorage.getAttestations.mockResolvedValue([]);
    expect((await directDashboard("/api/receipt/:id/export", 41)).status).toHaveBeenCalledWith(403);
  });
  it("rechecks grants on a subsequent detail request after revoke", async () => {
    const parent = makeAttestation({ id: 41, userId: "service-a" });
    mockStorage.getAttestation.mockResolvedValue(parent);
    mockStorage.getAttestations.mockResolvedValue([parent]);
    expect((await directDashboard("/api/attestations/:id", 41)).status).not.toHaveBeenCalled();
    mockStorage.getAttestations.mockResolvedValue([]);
    expect((await directDashboard("/api/attestations/:id", 41)).status).toHaveBeenCalledWith(403);
  });
  it.each(["user-alice", "forgeproof-system"])("keeps existing %s detail behavior", async issuer => {
    const parent = makeAttestation({ userId: issuer });
    mockStorage.getAttestation.mockResolvedValue(parent);
    expect((await directDashboard("/api/attestations/:id", 1)).json).toHaveBeenCalledWith({ ...parent, childAttestations: [] });
    expect(mockStorage.getAttestationsByParentId).toHaveBeenCalledWith(1, issuer);
  });
});

describe("service grants remain read only without network", () => {
  it("does not grant Git write authority to a dashboard viewer", async () => {
    const parent = makeAttestation({ id: 41, userId: "service-a" });
    mockStorage.getAttestation.mockResolvedValue(parent);
    mockStorage.getAttestations.mockResolvedValue([parent]);
    const res = await directDashboard("/api/attestations/:id/git-commit", 41);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});


describe("organization authority without network", () => {
  beforeEach(() => {
    memberDb.connect.mockImplementation(async () => ({ query: memberDb.query, release: memberDb.release }));
  });
  it.each([
    { owner: "other", membership: "owner", role: "member", allowed: false },
    { owner: "other", membership: "member", role: "member", allowed: false },
    { owner: "other", membership: "admin", role: "admin", allowed: false },
    { owner: "other", membership: "admin", role: "member", allowed: true },
    { owner: "user-alice", membership: "member", role: "admin", allowed: true },
  ])("checks locked actual owner/current admin: $membership / $role", async ({ owner, membership, role, allowed }) => {
    memberDb.query.mockReset().mockImplementation(async (sql: string) => ({ rows:
      sql.includes("SELECT owner_id") ? [{ owner_id: owner }] :
      sql.includes("SELECT role") ? [{ role: membership }] :
      sql.includes("INSERT") ? [{ id: 9 }] : [] }));
    const layer = (app as any).router.stack.find((entry: any) => entry.route?.path === "/api/organizations/:id/members" && entry.route.methods.post);
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    await layer.route.stack.at(-1).handle({ params: { id: "1" }, dbUser: { id: "user-alice" }, body: { userId: "new-member", role } }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(memberDb.query.mock.calls.some(([sql]) => sql.includes("INSERT"))).toBe(allowed);
    expect(memberDb.query).toHaveBeenCalledWith("SELECT role FROM org_members WHERE org_id=$1 AND user_id=$2 FOR UPDATE", [1, "user-alice"]);
    expect(memberDb.query).toHaveBeenCalledWith(allowed ? "COMMIT" : "ROLLBACK");
    if (!allowed) expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe("membership transaction connection lifecycle", () => {
  beforeEach(() => {
    mockStorage.createAuditLog.mockReset().mockResolvedValue({});
  });
  const invoke = async (newUserId = "new-member", json = vi.fn()) => {
    const layer = (app as any).router.stack.find((entry: any) => entry.route?.path === "/api/organizations/:id/members" && entry.route.methods.post);
    const res = { status: vi.fn().mockReturnThis(), json };
    const next = vi.fn();
    await layer.route.stack.at(-1).handle({ params: { id: "1" }, dbUser: { id: "user-alice" }, body: { userId: newUserId, role: "member" } }, res, next);
    return { res, next };
  };
  const resultFor = (sql: string) => ({ rows:
    sql.includes("SELECT owner_id") ? [{ owner_id: "user-alice" }] :
    sql.includes("INSERT INTO org_members") ? [{ id: 9 }] : [] });

  it("completes concurrent requests on a single-connection pool and commits every audit before releasing", async () => {
    let busy = false;
    const waiters: Array<() => void> = [];
    const events: string[][] = [];
    const audits: unknown[][] = [];
    let maxQueued = 0;
    memberDb.connect.mockImplementation(async () => {
      if (busy) {
        await new Promise<void>(resolve => {
          waiters.push(resolve);
          maxQueued = Math.max(maxQueued, waiters.length);
        });
      } else busy = true;
      const sequence: string[] = [];
      events.push(sequence);
      let released = false;
      return {
        query: async (sql: string, values?: unknown[]) => {
          expect(released).toBe(false);
          sequence.push(sql);
          if (sql.includes("INSERT INTO audit_logs")) audits.push(values!);
          return resultFor(sql);
        },
        release: () => {
          expect(released).toBe(false);
          released = true;
          sequence.push("RELEASE");
          const waiter = waiters.shift();
          if (waiter) waiter();
          else busy = false;
        },
      };
    });
    // Fail fast on the old second-checkout path instead of hanging the test forever.
    mockStorage.createAuditLog.mockImplementationOnce(async () => {
      throw new Error(busy ? "Pool exhausted: audit attempted a second checkout" : "Audit escaped membership transaction");
    });
    const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => invoke(`new-${i}`)));
    expect(maxQueued).toBe(5);
    for (const { res, next } of responses) {
      expect(next).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ id: 9 });
    }
    expect(memberDb.connect).toHaveBeenCalledTimes(6);
    expect(mockStorage.createAuditLog).not.toHaveBeenCalled();
    expect(audits).toEqual(Array.from({ length: 6 }, (_, i) => [
      "user-alice", "org.member_added", "organization", "1", JSON.stringify({ addedUserId: `new-${i}`, role: "member" }),
    ]));
    for (const sequence of events) {
      expect(sequence[0]).toBe("BEGIN");
      expect(sequence.at(-3)).toContain("INSERT INTO audit_logs");
      expect(sequence.slice(-2)).toEqual(["COMMIT", "RELEASE"]);
      expect(sequence).not.toContain("ROLLBACK");
    }
    expect(busy).toBe(false);
  });

  it.each(["BEGIN", "INSERT INTO org_members", "INSERT INTO audit_logs", "COMMIT"])("propagates %s failures, rolls back only active transactions, and releases once", async failureAt => {
    const error = new Error(`${failureAt} failed`);
    memberDb.connect.mockResolvedValue({ query: memberDb.query, release: memberDb.release });
    memberDb.query.mockReset().mockImplementation(async (sql: string) => {
      if (sql.startsWith(failureAt)) throw error;
      return resultFor(sql);
    });
    const { res, next } = await invoke();
    expect(next).toHaveBeenCalledExactlyOnceWith(error);
    expect(res.json).not.toHaveBeenCalled();
    expect(memberDb.query.mock.calls.filter(([sql]) => sql === "ROLLBACK")).toHaveLength(failureAt === "BEGIN" ? 0 : 1);
    if (failureAt !== "COMMIT") expect(memberDb.query).not.toHaveBeenCalledWith("COMMIT");
    expect(memberDb.release).toHaveBeenCalledTimes(1);
  });

  it("forwards response errors after commit without rolling back and releases once", async () => {
    const error = new Error("response failed");
    memberDb.connect.mockResolvedValue({ query: memberDb.query, release: memberDb.release });
    memberDb.query.mockReset().mockImplementation(async (sql: string) => resultFor(sql));
    const { next } = await invoke("new-member", vi.fn(() => { throw error; }));
    expect(next).toHaveBeenCalledExactlyOnceWith(error);
    expect(memberDb.query).toHaveBeenCalledWith("COMMIT");
    expect(memberDb.query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(memberDb.release).toHaveBeenCalledTimes(1);
  });

  it("preserves transaction and rollback errors while releasing once", async () => {
    const error = new Error("audit failed");
    const rollbackError = new Error("rollback failed");
    memberDb.connect.mockResolvedValue({ query: memberDb.query, release: memberDb.release });
    memberDb.query.mockReset().mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO audit_logs")) throw error;
      if (sql === "ROLLBACK") throw rollbackError;
      return resultFor(sql);
    });
    const { next } = await invoke();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeInstanceOf(AggregateError);
    expect(next.mock.calls[0][0].errors).toEqual([error, rollbackError]);
    expect(memberDb.query).not.toHaveBeenCalledWith("COMMIT");
    expect(memberDb.release).toHaveBeenCalledTimes(1);
  });
});
