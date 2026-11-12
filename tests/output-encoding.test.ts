import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import { createServer } from "node:http";
import { escapeMarkup, DOCUMENT_CSP } from "../server/outputEncoding";

const state = vi.hoisted(() => ({ userId: null as string | null }));
const storage = vi.hoisted(() => ({
  getAttestation: vi.fn(),
  getAttestations: vi.fn().mockResolvedValue([]),
  getAllAttestationsOrdered: vi.fn(),
  getApiKeyByHash: vi.fn(),
  updateApiKeyLastUsed: vi.fn(),
}));
vi.mock("../server/storage", () => ({ storage }));
vi.mock("../server/db", () => ({ pool: {}, db: {} }));
vi.mock("../server/middlewares/requireAuth", () => ({
  optionalAuth: (_req: any, _res: any, next: any) => next(),
  sessionUserId: () => state.userId,
  requireAuth: (req: any, _res: any, next: any) => { req.dbUser = { id: state.userId }; next(); },
}));
vi.mock("../server/crypto", async (original) => ({
  ...await original<typeof import("../server/crypto")>(),
  computeEntryHash: vi.fn().mockReturnValue("computed-hash"),
  verifySignature: vi.fn().mockReturnValue(false),
}));
vi.mock("../server/github", () => ({}));
vi.mock("../server/mcp", () => ({}));
vi.mock("../server/email", () => ({}));
vi.mock("../server/stripeAdmin", () => ({}));
vi.mock("../server/lifeosEntitlement", () => ({
  restrictLifeosServiceWrites: (_req: any, _res: any, next: any) => next(),
  proveLifeosControl: vi.fn().mockResolvedValue({ ok: false, reason: "test_without_lifeos_control" }),
  verifyLifeosGitState: vi.fn(),
  verifyLifeosInTransaction: vi.fn(),
}));

import { registerRoutes } from "../server/routes";
import { computeEntryHash } from "../server/crypto";

const attack = `"><script>alert('xss')</script><img src=x onerror="alert(1)">&`;
const receipt = () => ({
  id: 7, userId: "system", createdAt: new Date("2026-01-01T00:00:00Z"),
  fileName: "index.ts", filePath: "repo/index.ts", fileHash: "abc",
  modelName: "gpt-5", modelProvider: "OpenAI", countryOfOrigin: "US",
  detectedCountry: "US", complianceStatus: "verified", receiptVersion: "v1",
  entryHash: "entry-hash", prevEntryHash: null, signature: "sig", publicKey: "key",
});
let entry: Record<string, any>;
let app: express.Express;

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (state.userId) req.dbUser = { id: state.userId } as any;
    next();
  });
  await registerRoutes(createServer(app), app);
});

beforeEach(() => {
  state.userId = null;
  entry = receipt();
  storage.getAttestation.mockImplementation(async () => entry);
  storage.getAllAttestationsOrdered.mockImplementation(async () => [entry]);
});

function expectSafeDocument(response: supertest.Response, contentType: string) {
  // Superagent treats SVG images as binary rather than populating .text.
  if (Buffer.isBuffer(response.body)) response.text = response.body.toString("utf8");
  expect(response.status).toBe(200);
  expect(response.headers["content-type"]).toContain(contentType);
  expect(response.headers["content-security-policy"]).toBe(DOCUMENT_CSP);
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.text).not.toContain("<script>");
  expect(response.text).not.toContain("<img");
}

describe("HTML and XML output encoding", () => {
  it("encodes all five special characters, including pre-encoded entities", () => {
    expect(escapeMarkup(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    expect(escapeMarkup("&lt;script&gt;")).toBe("&amp;lt;script&amp;gt;");
    expect(escapeMarkup("OpenAI / Claude-3.5")).toBe("OpenAI / Claude-3.5");
  });

  it("encodes stored provider markup in the individual badge", async () => {
    entry.modelProvider = attack;
    const response = await supertest(app).get("/api/badge/7.svg");
    expectSafeDocument(response, "image/svg+xml");
    expect(response.text).toContain(`ForgeProof | ${escapeMarkup(attack)}`);
  });

  it("encodes stored provider markup in the repository badge", async () => {
    entry.modelProvider = attack;
    const response = await supertest(app).get("/api/badge/repo/repo.svg");
    expectSafeDocument(response, "image/svg+xml");
    expect(response.text).toContain(`1 attestations | ${escapeMarkup(attack)}`);
  });

  it.each([attack, "100%", "%2F", "repo & friends"])(
    "handles repository path %j without reflecting markup or decoding twice", async (repo) => {
      entry.filePath = `${repo}/index.ts`;
      const response = await supertest(app).get(`/api/badge/repo/${encodeURIComponent(repo)}.svg`);
      expectSafeDocument(response, "image/svg+xml");
      expect(response.text).toContain("1 attestations");
      expect(response.text).not.toContain(attack);
    },
  );

  it.each([
    "fileName", "filePath", "fileHash", "modelName", "modelProvider",
    "countryOfOrigin", "detectedCountry", "complianceStatus", "receiptVersion",
    "entryHash", "prevEntryHash", "signature", "publicKey",
  ])("encodes receipt field %s while verifying original, unmodified data", async (field) => {
    entry[field] = attack;
    const response = await supertest(app).get("/api/receipt/7/export");
    expectSafeDocument(response, "text/html");
    expect(response.text).toContain(escapeMarkup(attack));
    expect(computeEntryHash).toHaveBeenLastCalledWith(expect.objectContaining({
      fileHash: entry.fileHash, modelName: entry.modelName, modelProvider: entry.modelProvider,
    }));
  });

  it("preserves certificate content and print styles", async () => {
    const response = await supertest(app).get("/api/receipt/7/export");
    expectSafeDocument(response, "text/html");
    for (const content of ["index.ts", "OpenAI", "gpt-5", "@media print", "Genesis (first entry)"]) {
      expect(response.text).toContain(content);
    }
  });

  it("preserves ownership checks for non-public exports", async () => {
    entry.userId = "owner";
    expect((await supertest(app).get("/api/receipt/7/export")).status).toBe(401);
    state.userId = "other";
    expect((await supertest(app).get("/api/receipt/7/export")).status).toBe(403);
    state.userId = "owner";
    expectSafeDocument(await supertest(app).get("/api/receipt/7/export"), "text/html");
  });

  it("preserves missing-receipt and invalid-ID responses", async () => {
    for (const path of ["/api/badge/invalid.svg", "/api/receipt/invalid/export"]) {
      expect((await supertest(app).get(path)).status).toBe(400);
    }
    storage.getAttestation.mockResolvedValue(undefined);
    for (const path of ["/api/badge/7.svg", "/api/receipt/7/export"]) {
      expect((await supertest(app).get(path)).status).toBe(404);
    }
  });
});

describe("attestation model label validation", () => {
  it.each(["model_name", "model_provider"])("rejects markup in %s before persistence", async (field) => {
    state.userId = "owner";
    const response = await supertest(app).post("/api/v1/attest").send({
      file_path: "index.ts", file_hash: "abc", model_name: "gpt-5",
      model_provider: "OpenAI", country_of_origin: "US", [field]: attack,
    });
    expect(response.status).toBe(400);
    expect(response.body.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: [field] }),
    ]));
  });

  it.each(["gpt-5", "claude-3.5-sonnet", "org/model:v1@2026", "模型 (Preview)+1"])(
    "accepts normal model label %s", async (model) => {
      state.userId = "owner";
      const response = await supertest(app).post("/api/v1/attest").send({
        file_path: "index.ts", file_hash: "abc", model_name: model,
        model_provider: "OpenAI", country_of_origin: "US", attestation_type: "review",
      });
      // Reaches the next business rule rather than failing model validation.
      expect(response.body.message).toBe("parentAttestationId is required for non-origin attestation types");
    },
  );

  it.each(["openai", "claude", "replit"])("rejects unsafe labels in the %s agent endpoint", async (agent) => {
    storage.getApiKeyByHash.mockResolvedValue({ id: 1, userId: "owner", isActive: true, permissions:["attest:read","attest:write"] });
    for (const field of ["model_name", "model_provider"]) {
      const response = await supertest(app).post(`/api/v1/agents/${agent}`)
        .set("Authorization", "Bearer test-key").send({
          files: [{ file_path: "index.ts", file_hash: "abc" }],
          model_name: "gpt-5", model_provider: "OpenAI", country_of_origin: "US", [field]: attack,
        });
      expect(response.status).toBe(400);
      expect(response.body.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: [field] }),
      ]));
    }
  });
});
