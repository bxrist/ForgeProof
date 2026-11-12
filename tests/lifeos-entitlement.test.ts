import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import express from "express";
import supertest from "supertest";
import { createServer } from "node:http";
import * as backend from "../server/storageBackend";

const state = vi.hoisted(() => ({
  approval: null as any,
  key: null as any,
  user: null as any,
  sub: null as any,
  keys: [] as any[],
  row: null as any,
  query: vi.fn(),
  getOrCreateFreeSubscription: vi.fn(),
  updateApiKeyLastUsed: vi.fn(),
  provider: vi.fn(),
}));
vi.mock("../server/lifeosApproval", () => ({ get lifeosApproval() { return state.approval; } }));
vi.mock("../server/storage", () => ({
  storage: {
    getApiKeyByHash: vi.fn(async (hash: string) => state.key?.keyHash === hash ? state.key : undefined),
    getApiKeys: vi.fn(async () => state.keys),
    getUser: vi.fn(async (id: string) => id === "owner" ? { id } : state.user),
    getSubscription: vi.fn(async () => state.sub),
    getOrCreateFreeSubscription: state.getOrCreateFreeSubscription,
    updateApiKeyLastUsed: state.updateApiKeyLastUsed,
  },
}));
vi.mock("../server/db", () => ({
  pool: { connect: vi.fn(async () => ({ query: state.query, release: vi.fn() })) },
  db: { execute: vi.fn() },
}));
vi.mock("../server/crypto", async (original) => ({
  ...await original<any>(),
  getKeyPair: vi.fn(() => ({ publicKey: "fixture-public-key" })),
  hasPinnedDurableSigner: vi.fn(() => true),
  signData: vi.fn(() => "fixture-signature"),
}));
vi.mock("../server/middlewares/requireAuth", () => ({
  optionalAuth: (_req: any, _res: any, next: any) => next(),
  sessionUserId: (req: any) => req.dbUser?.id ?? null,
  requireAuth: (req: any, res: any, next: any) =>
    req.dbUser ? next() : res.status(401).json({ message: "Unauthorized" }),
}));
vi.mock("../server/stripeClient", () => ({
  getUncachableStripeClient: state.provider,
  getStripeSync: state.provider,
}));

import { registerRoutes } from "../server/routes";
import { proveLifeosControl, verifyLifeosInTransaction, requireLifeosProject } from "../server/lifeosEntitlement";
import { createCheckoutSession, createPortalSession, ensureStripeCustomer } from "../server/stripe";

const secret = "synthetic-test-key-not-a-real-credential";
const hash = createHash("sha256").update(secret).digest("hex");
const payload = {
  file_path: "fixture.txt", file_hash: "a".repeat(64),
  model_name: "fixture", model_provider: "fixture", country_of_origin: "US",
};
let app: express.Express;

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    if (req.headers["x-test-subject"]) req.dbUser = { id: req.headers["x-test-subject"] };
    next();
  });
  await registerRoutes(createServer(app), app);
});

beforeEach(() => {
  vi.clearAllMocks();
  state.approval = {
    service: "lifeos", userId: "lifeos-service-0a", apiKeyId: 9, apiKeyHash: hash,
    dedicated: true, approvedBySubject: "owner", approvedAt: "2026-01-01T00:00:00Z",
    approvalReference: "synthetic-owner-approval",
  };
  state.key = { id: 9, userId: "lifeos-service-0a", keyHash: hash, isActive: true, expiresAt: new Date(Date.now() + 60_000), permissions: ["attest:write"] };
  state.user = { id: "lifeos-service-0a", stripeCustomerId: null, githubToken: null };
  state.sub = null;
  state.keys = [state.key];
  state.row = { ...state.key, ...state.user, id: 9 };
  state.getOrCreateFreeSubscription.mockResolvedValue({ plan: "free", attestationLimit: 100 });
  state.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM api_keys")) return { rows: [state.row] };
    if (sql.includes("FROM subscriptions")) return { rows: state.sub ? [state.sub] : [] };
    if (sql.includes("UPDATE subscriptions")) return { rows: [{ id: 1 }] };
    if (sql.includes("INSERT INTO attestation_receipts")) return { rows: [{ id: 1, user_id: state.key.userId }] };
    return { rows: [] };
  });
});

describe("LifeOS request-scoped owner-approved proof", () => {
  it("denies possession without explicit owner approval", async () => {
    state.approval = null;
    await expect(proveLifeosControl(`Bearer ${secret}`)).rejects.toThrow();
    expect(state.query).not.toHaveBeenCalled();
  });
  it.each([undefined, "Bearer wrong-key", "Basic arbitrary"])("denies missing/wrong proof %s", async (header) => {
    await expect(proveLifeosControl(header)).rejects.toThrow();
  });
  it.each(["revoked", "expired", "no-expiry", "wrong-owner", "wrong-id", "no-write-scope", "extra-scope"])("denies %s key", async (kind) => {
    if (kind === "revoked") state.key.isActive = false;
    if (kind === "expired") state.key.expiresAt = new Date(0);
    if (kind === "no-expiry") state.key.expiresAt = null;
    if (kind === "wrong-owner") state.key.userId = "external";
    if (kind === "wrong-id") state.key.id = 10;
    if (kind === "no-write-scope") state.key.permissions = ["attest:read"];
    if (kind === "extra-scope") state.key.permissions = ["attest:write", "attest:read"];
    await expect(proveLifeosControl(`Bearer ${secret}`)).rejects.toThrow();
  });
  it.each(["paid", "customer", "shared-key", "self-approval", "missing-approval", "future-approval"])("denies unsafe binding: %s", async (kind) => {
    if (kind === "paid") state.sub = { plan: "pro", stripeSubscriptionId: "sub_fixture" };
    if (kind === "customer") state.user.stripeCustomerId = "cus_fixture";
    if (kind === "shared-key") state.keys.push({ id: 10, isActive: true });
    if (kind === "self-approval") state.approval.approvedBySubject = "lifeos-service-0a";
    if (kind === "missing-approval") state.approval.approvalReference = "";
    if (kind === "future-approval") state.approval.approvedAt = "2999-01-01";
    await expect(proveLifeosControl(`Bearer ${secret}`)).rejects.toThrow();
  });
  it("accepts valid owner approval plus key possession and transaction recheck", async () => {
    const proof = await proveLifeosControl(`Bearer ${secret}`);
    await expect(verifyLifeosInTransaction({ query: state.query }, proof, "lifeos-service-0a")).resolves.toBeUndefined();
    expect(state.query.mock.calls[0][0]).toContain("FOR SHARE");
  });
  it("rejects fabricated proof and cross-principal reuse", async () => {
    const proof = await proveLifeosControl(`Bearer ${secret}`);
    await expect(verifyLifeosInTransaction({ query: state.query }, { ...proof }, "lifeos-service-0a")).rejects.toThrow();
    await expect(verifyLifeosInTransaction({ query: state.query }, proof, "external")).rejects.toThrow();
  });
  it("fails closed if key is revoked between authentication and insertion", async () => {
    const proof = await proveLifeosControl(`Bearer ${secret}`);
    state.row.isActive = false;
    await expect(verifyLifeosInTransaction({ query: state.query }, proof, "lifeos-service-0a")).rejects.toThrow();
  });
  it("fails closed if an extra permission is added before insertion", async () => {
    const proof = await proveLifeosControl(`Bearer ${secret}`);
    state.row.permissions = ["attest:write", "attest:admin"];
    await expect(verifyLifeosInTransaction({ query: state.query }, proof, "lifeos-service-0a")).rejects.toThrow();
  });
  it("fails closed if a commercial association appears before insertion", async () => {
    const proof = await proveLifeosControl(`Bearer ${secret}`);
    state.sub = { plan: "free", stripeCustomerId: "cus_fixture" };
    await expect(verifyLifeosInTransaction({ query: state.query }, proof, "lifeos-service-0a")).rejects.toThrow();
  });
});

describe("LifeOS isolation from commercial billing", () => {
  it("checks project authorization using the existing binding and authentic proof", async () => {
    state.approval.projects = ["fixture/lifeos"];
    const proof = await proveLifeosControl(`Bearer ${secret}`);
    expect(() => requireLifeosProject(proof, "fixture/lifeos")).not.toThrow();
    expect(() => requireLifeosProject(proof, "another/project")).toThrow();
    expect(() => requireLifeosProject({ ...proof }, "fixture/lifeos")).toThrow();
    state.approval.projects = undefined;
    expect(() => requireLifeosProject(proof, "fixture/lifeos")).toThrow();
  });
  it("offers read-only scope verification without leaking the key or approval hash", async () => {
    state.approval.projects = ["fixture/lifeos"];
    const result = await supertest(app).get("/api/lifeos/authorization").set("Authorization", `Bearer ${secret}`);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ authorized: true, projects: ["fixture/lifeos"], lifecycleEnabled: false });
    expect(JSON.stringify(result.body)).not.toContain(hash);
    expect(state.query).not.toHaveBeenCalled();
    expect((await supertest(app).get("/api/lifeos/authorization")).status).toBe(403);
  });
  it("does not silently ignore lifecycle evidence on an unconfigured project or SQL runtime", async () => {
    const lifecycle = { project: "fixture/lifeos", stage: "source-write", parents: [], observedAt: "2026-11-10T00:00:00Z" };
    expect((await supertest(app).post("/api/lifeos/attest").set("Authorization", `Bearer ${secret}`)
      .send({ ...payload, lifecycle })).status).toBe(403);
    state.approval.projects = ["fixture/lifeos"];
    expect((await supertest(app).post("/api/lifeos/attest").set("Authorization", `Bearer ${secret}`)
      .send({ ...payload, lifecycle })).status).toBe(503);
    expect(state.query).not.toHaveBeenCalled();
    expect(state.getOrCreateFreeSubscription).not.toHaveBeenCalled();
  });
  it("routes scoped lifecycle issuance through Git with transactional key and project revalidation", async () => {
    state.approval.projects = ["fixture/lifeos"];
    const lifecycle = { project: "fixture/lifeos", stage: "source-write", parents: [], observedAt: "2026-11-10T00:00:00Z" };
    const issue = vi.fn(async (_src, _signer, _id, validate, input) => {
      await validate({ records: { users: { owner: { id: "owner" }, "lifeos-service-0a": state.user },
        apiKeys: { [state.key.id]: state.key }, subscriptions: {} } });
      return { id: 123, lifecycleEvidence: { payload: input } };
    });
    const fakeGit = { issueAttestationWithSigner: issue, custody: { matches: vi.fn(async () => true) } };
    const spy = vi.spyOn(backend, "currentApplicationStorage").mockReturnValue(fakeGit as any);
    try {
      const response = await supertest(app).post("/api/lifeos/attest").set("Authorization", `Bearer ${secret}`)
        .send({ ...payload, lifecycle });
      expect(response.status).toBe(201);
      expect(response.body.lifecycleEvidence.payload).toEqual(lifecycle);
      expect(response.body.metering).toBe("internal");
      expect(state.query).not.toHaveBeenCalled();
      expect(state.getOrCreateFreeSubscription).not.toHaveBeenCalled();
      const mismatch = await supertest(app).post("/api/lifeos/attest").set("Authorization", `Bearer ${secret}`)
        .send({ ...payload, lifecycle: { ...lifecycle, model: { name: "different", provider: "fixture" } } });
      expect(mismatch.status).toBe(400);
      expect(issue).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });
  it("logs only safe stage timings for failed issuance", async () => {
    const issue = vi.fn(async () => { throw new Error(`private-provider-detail:${secret}:${hash}`); });
    const spy = vi.spyOn(backend, "currentApplicationStorage").mockReturnValue({
      issueAttestationWithSigner: issue, custody: { matches: vi.fn(async () => true) },
    } as any);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await supertest(app).post("/api/lifeos/attest")
        .set("Authorization", `Bearer ${secret}`).send(payload);
      expect(response.status).toBe(500);
      expect(issue).toHaveBeenCalledOnce();
      const call = warning.mock.calls.find(args => args[0] === "[lifeos] Request timing");
      expect(call).toBeDefined();
      const timing = JSON.parse(String(call![1]));
      expect(timing).toEqual({
        stage: "issuance", status: 500, category: "internal_failure",
        totalMs: expect.any(Number), proofMs: expect.any(Number), issuanceMs: expect.any(Number),
      });
      expect(JSON.stringify(call)).not.toContain(secret);
      expect(JSON.stringify(call)).not.toContain(hash);
      expect(JSON.stringify(call)).not.toContain("private-provider-detail");
    } finally { spy.mockRestore(); warning.mockRestore(); }
  });
  it("exposes verified lifecycle evidence separately and fails closed on missing or invalid evidence", async () => {
    const read = vi.fn(async () => ({ verified: true, parentsVerified: true }));
    const spy = vi.spyOn(backend, "currentApplicationStorage").mockReturnValue({ getPublicLifecycleEvidence: read } as any);
    try {
      expect((await supertest(app).get("/api/verify/entry/123/lifecycle")).body).toEqual({ verified: true, parentsVerified: true });
      read.mockResolvedValueOnce(undefined as any);
      expect((await supertest(app).get("/api/verify/entry/123/lifecycle")).status).toBe(404);
      read.mockRejectedValueOnce(new Error("PRIVATE INTERNAL DETAIL"));
      const invalid = await supertest(app).get("/api/verify/entry/123/lifecycle");
      expect(invalid.status).toBe(422);
      expect(invalid.body.verified).toBe(false);
      expect(invalid.text).not.toContain("PRIVATE INTERNAL DETAIL");
      expect((await supertest(app).get("/api/verify/entry/123bad/lifecycle")).status).toBe(400);
    } finally { spy.mockRestore(); }
  });
  it("creates an internal receipt without touching subscriptions or Stripe", async () => {
    const response = await supertest(app).post("/api/lifeos/attest")
      .set("Authorization", `Bearer ${secret}`).send(payload);
    expect(response.status).toBe(201);
    expect(response.body.metering).toBe("internal");
    expect(state.getOrCreateFreeSubscription).not.toHaveBeenCalled();
    expect(state.query.mock.calls.some(([sql]) => sql.includes("UPDATE subscriptions"))).toBe(false);
    expect(state.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO attestation_receipts"))).toBe(true);
    expect(state.provider).not.toHaveBeenCalled();
  });
  it("does not exempt an external customer's ordinary receipt despite spoofed metadata", async () => {
    state.key.userId = "external";
    state.user = { id: "external" };
    const response = await supertest(app).post("/api/v1/attest")
      .set("Authorization", `Bearer ${secret}`).send({ ...payload, metadata: { source: "lifeos", metering: "internal" } });
    expect(response.status).toBe(201);
    expect(state.getOrCreateFreeSubscription).toHaveBeenCalledWith("external");
    expect(state.query.mock.calls.some(([sql]) => sql.includes("UPDATE subscriptions"))).toBe(true);
  });
  it("preserves external quota rejection even with an internal metering claim", async () => {
    state.key.userId = "external";
    state.user = { id: "external" };
    state.query.mockResolvedValue({ rows: [] });
    const response = await supertest(app).post("/api/v1/attest")
      .set("Authorization", `Bearer ${secret}`).send({ ...payload, metadata: { metering: "internal" } });
    expect(response.status).toBe(402);
    expect(state.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO attestation_receipts"))).toBe(false);
  });
  it("rolls back before insertion if the proof becomes invalid inside the transaction", async () => {
    state.row.isActive = false;
    const response = await supertest(app).post("/api/lifeos/attest")
      .set("Authorization", `Bearer ${secret}`).send(payload);
    expect(response.status).toBe(403);
    expect(state.query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
    expect(state.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO attestation_receipts"))).toBe(false);
    expect(state.getOrCreateFreeSubscription).not.toHaveBeenCalled();
  });
  it("does not exempt a session or another principal through the dedicated endpoint", async () => {
    expect((await supertest(app).post("/api/lifeos/attest").set("x-test-subject", "lifeos-service-0a").send(payload)).status).toBe(403);
    state.key.userId = "external";
    expect((await supertest(app).post("/api/lifeos/attest").set("Authorization", `Bearer ${secret}`).send(payload)).status).toBe(403);
    expect(state.query).not.toHaveBeenCalled();
  });
  it.each(["/api/v1/attest", "/api/mcp/tools", "/api/billing/checkout", "/api/billing/portal", "/api/api-keys"])("rejects service writes through %s", async (path) => {
    expect((await supertest(app).post(path).set("Authorization", `Bearer ${secret}`).send(payload)).status).toBe(403);
    expect((await supertest(app).post(path).set("x-test-subject", "lifeos-service-0a").send(payload)).status).toBe(403);
    expect(state.query).not.toHaveBeenCalled();
    expect(state.provider).not.toHaveBeenCalled();
  });
  it("also blocks direct payment service calls for the nominated principal", async () => {
    await expect(createCheckoutSession("lifeos-service-0a", null, "pro", "https://example.com")).rejects.toThrow();
    await expect(createPortalSession("lifeos-service-0a", "https://example.com")).rejects.toThrow();
    await expect(ensureStripeCustomer("lifeos-service-0a", null)).rejects.toThrow();
    expect(state.provider).not.toHaveBeenCalled();
  });
  it("rejects cross-tenant lineage inputs without inserting a receipt", async () => {
    const result = await supertest(app).post("/api/lifeos/attest")
      .set("Authorization", `Bearer ${secret}`).send({ ...payload, parent_attestation_id: 12 });
    expect(result.status).toBe(400);
    expect(state.query).not.toHaveBeenCalled();
  });
});
