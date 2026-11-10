import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import { createServer } from "http";
import { createHmac } from "node:crypto";

const authState = vi.hoisted(() => ({ userId: null as string | null }));
const payments = vi.hoisted(() => ({
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
}));
vi.mock("../server/stripe", () => payments);
const billingStorage = vi.hoisted(() => ({
  getOrCreateFreeSubscription: vi.fn(),
  getAttestations: vi.fn(),
  getUserOrganizations: vi.fn(),
  clearAllAttestations: vi.fn(),
  getLatestAttestation: vi.fn(),
  createAttestation: vi.fn(),
}));
const seed = vi.hoisted(() => ({ seedDatabase: vi.fn() }));
vi.mock("../server/seed", () => seed);
const adminMocks = vi.hoisted(() => ({
  getStripeReadiness: vi.fn(),
  reconcileStripe: vi.fn(),
  getConfiguredWebhookTargets: vi.fn(),
}));

vi.mock("../server/middlewares/requireAuth", () => ({
  optionalAuth: (_req: any, _res: any, next: any) => next(),
  sessionUserId: () => authState.userId,
  requireAuth: (req: any, res: any, next: any) => {
    if (!authState.userId) return res.status(401).json({ message: "Unauthorized" });
    req.dbUser = { id: authState.userId };
    next();
  },
}));
vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId, sessionClaims: { userId: authState.userId } }),
}));

vi.mock("../server/stripeAdmin", () => ({
  EXPECTED_STRIPE_ACCOUNT_ID: "acct_1UYEnEInfcuWjiUY",
  getStripeReadiness: adminMocks.getStripeReadiness,
  reconcileStripe: adminMocks.reconcileStripe,
  getConfiguredWebhookTargets: adminMocks.getConfiguredWebhookTargets,
}));

vi.mock("../server/storage", () => ({ storage: billingStorage }));
vi.mock("../server/db", () => ({ pool: { connect: vi.fn() }, db: {} }));
vi.mock("../server/crypto", () => ({
  sha256: vi.fn(),
  signData: vi.fn(),
  getKeyPair: vi.fn(),
  computeEntryHash: vi.fn(),
  generateApiKey: vi.fn(),
  verifySignature: vi.fn(),
}));
vi.mock("../server/github", () => ({
  fetchUserRepos: vi.fn(),
  fetchRepoFiles: vi.fn(),
  fetchFileContent: vi.fn(),
  fetchRepoCommits: vi.fn(),
  fetchCommitFiles: vi.fn(),
  commitAttestationToGit: vi.fn(),
}));
vi.mock("../server/mcp", () => ({ getMcpManifest: vi.fn(), handleMcpTool: vi.fn() }));
vi.mock("../server/email", () => ({ sendGitCommitFailureEmail: vi.fn() }));

import { registerRoutes } from "../server/routes";
import { getKeyPair } from "../server/crypto";

const readiness = {
  expectedAccountId: "acct_1UYEnEInfcuWjiUY",
  account: {
    id: "acct_1UYEnEInfcuWjiUY",
    detailsSubmitted: true,
    chargesEnabled: true,
    payoutsEnabled: true,
  },
  ready: true,
  checks: [],
  canReconcile: true,
};

let app: express.Express;

describe("commercial billing remains available", () => {
  it("keeps existing subscription entitlements and authenticated attestation reads available", async () => {
    authState.userId = "existing-user";
    const existing = { plan: "pro", stripeCustomerId: "cus_existing", stripeSubscriptionId: "sub_existing", attestationLimit: 10000, attestationCount: 42 };
    billingStorage.getOrCreateFreeSubscription.mockResolvedValue(existing);
    billingStorage.getAttestations.mockResolvedValue([]);
    const response = await supertest(app).get("/api/billing/subscription");
    expect(response.status).toBe(200);
    expect(response.body).toEqual(existing);
    expect((await supertest(app).get("/api/attestations")).status).toBe(200);
    authState.userId = null;
    expect((await supertest(app).get("/api/attestations")).status).toBe(401);
  });
  it("allows external customer checkout and portal without a global flag", async () => {
    authState.userId = "admin-subject";
    payments.createCheckoutSession.mockResolvedValue("https://checkout.example/session");
    payments.createPortalSession.mockResolvedValue("https://billing.example/session");
    for (const path of ["/api/billing/checkout", "/api/billing/portal"]) {
      const response = await supertest(app).post(path).send({ plan: "pro" });
      expect(response.status).toBe(200);
      expect(response.body.url).toMatch(/^https:/);
    }
    expect(payments.createCheckoutSession).toHaveBeenCalledWith("admin-subject", null, "pro", expect.any(String));
    expect(payments.createPortalSession).toHaveBeenCalledWith("admin-subject", expect.any(String));
  });
});

beforeAll(async () => {
  app = express();
  app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = buffer; } }));
  await registerRoutes(createServer(app), app);
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-webhook-secret");
  authState.userId = null;
  process.env.FORGEPROOF_ADMIN_USER_IDS = "admin-subject";
  process.env.FORGEPROOF_STRIPE_PRODUCTION_URL = "https://production.example";
  process.env.FORGEPROOF_STRIPE_DEVELOPMENT_URL = "https://development.example";
  adminMocks.getConfiguredWebhookTargets.mockReturnValue({
    targets: [
      { environment: "production", url: "https://production.example/api/stripe/webhook", origin: "https://production.example" },
      { environment: "development", url: "https://development.example/api/stripe/webhook", origin: "https://development.example" },
    ],
    currentEnvironment: "development",
    currentTarget: { environment: "development", url: "https://development.example/api/stripe/webhook", origin: "https://development.example" },
    checks: [],
  });
  adminMocks.getStripeReadiness.mockResolvedValue(readiness);
  adminMocks.reconcileStripe.mockResolvedValue({
    ...readiness,
    reconciliation: { status: "ok", operations: [] },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("destructive reseed access control", () => {
  const request = () => supertest(app).post("/api/admin/reseed");

  afterEach(() => {
    // Every rejected request must leave the ledger and seed data untouched.
    if (expect.getState().currentTestName?.includes("rejects")) {
      expect(billingStorage.clearAllAttestations).not.toHaveBeenCalled();
      expect(seed.seedDatabase).not.toHaveBeenCalled();
    }
  });

  it("rejects unauthenticated callers", async () => {
    expect((await request()).status).toBe(401);
  });

  it("rejects ordinary users and an absent admin allowlist", async () => {
    authState.userId = "ordinary-user";
    expect((await request()).status).toBe(403);
    authState.userId = "admin-subject";
    vi.stubEnv("FORGEPROOF_ADMIN_USER_IDS", "");
    expect((await request()).status).toBe(403);
  });

  it.each(["production", "", "staging"])("rejects reseeding in environment %j", async (environment) => {
    authState.userId = "admin-subject";
    vi.stubEnv("NODE_ENV", environment);
    expect((await request().set("Origin", "https://development.example")).status).toBe(403);
  });

  it("rejects missing, foreign, or cross-site origins", async () => {
    authState.userId = "admin-subject";
    expect((await request()).status).toBe(403);
    expect((await request().set("Origin", "https://attacker.example")).status).toBe(403);
    expect((await request().set("Origin", "https://development.example")
      .set("Sec-Fetch-Site", "cross-site")).status).toBe(403);
  });

  it.each(["development", "test"])("allows a trusted same-origin admin in %s", async (environment) => {
    authState.userId = "admin-subject";
    vi.stubEnv("NODE_ENV", environment);
    expect((await request().set("Origin", "https://development.example")).status).toBe(200);
    expect(billingStorage.clearAllAttestations).toHaveBeenCalledTimes(1);
    expect(seed.seedDatabase).toHaveBeenCalledTimes(1);
    expect(billingStorage.clearAllAttestations.mock.invocationCallOrder[0])
      .toBeLessThan(seed.seedDatabase.mock.invocationCallOrder[0]);
  });
});

describe("GitHub webhook authentication", () => {
  const payload = {
    repository: { full_name: "example/repo" },
    commits: [{ id: "abc123", message: "Change", author: { name: "Example" }, added: ["src/example.ts"] }],
  };
  const raw = JSON.stringify(payload, null, 2) + "\n";
  const signature = (body: string) => "sha256=" + createHmac("sha256", "test-webhook-secret").update(body).digest("hex");
  const request = () => supertest(app).post("/api/github/webhook")
    .set("Content-Type", "application/json").set("X-GitHub-Event", "push");

  afterEach(() => {
    if (expect.getState().currentTestName?.includes("rejects")) {
      expect(billingStorage.getLatestAttestation).not.toHaveBeenCalled();
      expect(billingStorage.createAttestation).not.toHaveBeenCalled();
    }
  });

  it.each([undefined, ""])("rejects an unconfigured secret %j", async (secret) => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", secret);
    expect((await request().set("X-Hub-Signature-256", signature(raw)).send(raw)).status).toBe(503);
  });

  it("rejects missing signatures", async () => {
    expect((await request().send(raw)).status).toBe(401);
  });

  it.each(["sha256=bad", "sha1=" + "a".repeat(64), "sha256=" + "z".repeat(64), "sha256=" + "0".repeat(64)])(
    "rejects malformed or incorrect signatures %s", async (header) => {
      expect((await request().set("X-Hub-Signature-256", header).send(raw)).status).toBe(401);
    },
  );

  it("rejects changed bytes even when the parsed JSON is identical", async () => {
    expect((await request().set("X-Hub-Signature-256", signature(JSON.stringify(payload))).send(raw)).status).toBe(401);
  });

  it("rejects a tampered payload", async () => {
    expect((await request().set("X-Hub-Signature-256", signature(raw))
      .send(raw.replace("example/repo", "attacker/repo"))).status).toBe(401);
  });

  it("accepts a correctly signed push using the original bytes", async () => {
    vi.mocked(getKeyPair).mockReturnValue({ publicKey: "test-public-key", privateKey: "test-private-key" });
    billingStorage.getLatestAttestation.mockResolvedValue(undefined);
    billingStorage.createAttestation.mockResolvedValue({ id: 1 });
    const response = await request().set("X-Hub-Signature-256", signature(raw)).send(raw);
    expect(response.status).toBe(200);
    expect(billingStorage.createAttestation).toHaveBeenCalledTimes(1);
    expect(billingStorage.createAttestation).toHaveBeenCalledWith(expect.objectContaining({
      userId: "webhook", filePath: "src/example.ts",
    }));
    expect(response.body.repo).toBe("example/repo");
    expect(response.body.receipts).toBe(1);
  });

  it("rejects signed requests when raw body capture is unavailable", async () => {
    const appWithoutRawBody = express();
    appWithoutRawBody.use(express.json());
    await registerRoutes(createServer(appWithoutRawBody), appWithoutRawBody);
    const response = await supertest(appWithoutRawBody).post("/api/github/webhook")
      .set("Content-Type", "application/json").set("X-GitHub-Event", "push")
      .set("X-Hub-Signature-256", signature(raw)).send(raw);
    expect(response.status).toBe(400);
  });

  it("accepts a signed ping without creating attestations", async () => {
    const response = await request().set("X-GitHub-Event", "ping")
      .set("X-Hub-Signature-256", signature(raw)).send(raw);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ event: "ping", status: "ignored" });
    expect(billingStorage.createAttestation).not.toHaveBeenCalled();
  });
});

describe("Stripe admin authorization and confirmation gates", () => {
  it("requires an authenticated trusted session subject", async () => {
    const unauthenticated = await supertest(app).get("/api/admin/stripe/readiness");
    expect(unauthenticated.status).toBe(401);

    authState.userId = "ordinary-user";
    const untrusted = await supertest(app).get("/api/admin/stripe/readiness");
    expect(untrusted.status).toBe(403);
    expect(adminMocks.getStripeReadiness).not.toHaveBeenCalled();
  });

  it("requires same-origin HTTPS and explicit Dashboard preservation confirmation", async () => {
    authState.userId = "admin-subject";

    const missingOrigin = await supertest(app)
      .post("/api/admin/stripe/reconcile")
      .send({ preservationConfirmed: true, expectedAccountId: readiness.expectedAccountId });
    expect(missingOrigin.status).toBe(403);
    expect(adminMocks.reconcileStripe).not.toHaveBeenCalled();

    const missingConfirmation = await supertest(app)
      .post("/api/admin/stripe/reconcile")
      .set("Origin", "https://development.example")
      .send({ expectedAccountId: readiness.expectedAccountId });
    expect(missingConfirmation.status).toBe(400);
    expect(adminMocks.reconcileStripe).not.toHaveBeenCalled();
  });

  it("rejects a body account mismatch before readiness or provider work", async () => {
    authState.userId = "admin-subject";
    const response = await supertest(app)
      .post("/api/admin/stripe/reconcile")
      .set("Origin", "https://development.example")
      .send({ preservationConfirmed: true, expectedAccountId: "acct_wrong" });

    expect(response.status).toBe(400);
    expect(adminMocks.getStripeReadiness).not.toHaveBeenCalled();
    expect(adminMocks.reconcileStripe).not.toHaveBeenCalled();
  });

  it("runs reconciliation only after all gates pass", async () => {
    authState.userId = "admin-subject";
    const response = await supertest(app)
      .post("/api/admin/stripe/reconcile")
      .set("Origin", "https://development.example")
      .send({ preservationConfirmed: true, expectedAccountId: readiness.expectedAccountId });

    expect(response.status).toBe(200);
    expect(adminMocks.getStripeReadiness).toHaveBeenCalledTimes(1);
    expect(adminMocks.reconcileStripe).toHaveBeenCalledTimes(1);
  });
});
