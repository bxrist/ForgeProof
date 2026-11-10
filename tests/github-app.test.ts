import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { AppError, AppStore, record, unpack } from "../server/githubApp/store";
import { config, GitHubAppClient, type AppConfig } from "../server/githubApp/client";
import { registerGitHubAppRoutes } from "../server/githubApp/routes";
import { installKey, processEvent, purchaseKey } from "../server/githubApp/events";
import { classes, validateRecord } from "../server/git-store/schema.mjs";
import { ConflictError, type Replay } from "../server/git-store/store.mjs";

const cfg: AppConfig = { id: 11, clientId: "new-client", clientSecret: "fixture-only", privateKey: "",
  webhookSecret: "fixture-webhook", slug: "fixture-app", origin: "https://example.test" };
const snapshot = (id = 7) => ({ appId: 11, id, accountId: 99, accountLogin: "sample",
  status: "active", repositorySelection: "selected", repositories: [{ id: 8, fullName: "sample/source" }] });
function fixture() {
  const state: Replay = { records: Object.fromEntries(classes.map((k: string) => [k, {}])), versions: {}, events: [] } as any;
  state.records.users.alice = { id: "alice" }; state.records.users.bob = { id: "bob" };
  // Sentinels: none of the integration operations may mutate commercial/history classes.
  state.records.subscriptions["1"] = { id: 1, plan: "pro", stripeSubscriptionId: "unchanged" };
  state.records.receipts["1"] = { id: 1, original: "immutable historical bytes" };
  const service = {
    replay: async () => structuredClone(state),
    append: async ({ operations }: any) => {
      for (const op of operations) {
        if ((state.versions[`${op.kind}/${op.id}`] ?? null) !== op.expectedVersion) throw new ConflictError();
        validateRecord(op.kind, op.record);
      }
      for (const op of operations) {
        state.records[op.kind as keyof typeof state.records][op.id] = structuredClone(op.record);
        const key = `${op.kind}/${op.id}`;
        state.versions[key] = (state.versions[key] ?? 0) + 1;
      }
      return {} as any;
    },
  };
  const store = new AppStore(service as any);
  const client = { cfg, verifyApp: vi.fn(async () => ({})), installation: vi.fn(async () => ({ id: 7, app_id: 11 })),
    exchange: vi.fn(async () => "ephemeral"), verifyOwner: vi.fn(async () => ({})),
    snapshot: vi.fn(async () => snapshot()), jwt: () => "fixture-jwt",
    request: vi.fn(async () => ({ id: 99, marketplace_purchase: { plan: { id: 123 }, billing_cycle: "monthly" } })),
    installationToken: vi.fn(async () => "ephemeral-installation"),
  } as unknown as GitHubAppClient;
  const app = express();
  app.use(express.json({ verify: (req, _res, bytes) => { (req as any).rawBody = bytes; } }));
  registerGitHubAppRoutes(app, { store: () => store, client: () => client, auth: (req, res, next) => {
    const actor = req.get("x-test-actor");
    if (!actor) { res.status(401).end(); return; }
    req.dbUser = { id: actor } as any; next();
  } });
  const link = async (owner = "alice") => store.transact(() => ({
    rows: [record(installKey(11, 7), "installation", owner, snapshot())], result: undefined,
  }));
  const webhook = (event: string, payload: object, delivery = "delivery-one", valid = true) => {
    const raw = JSON.stringify(payload);
    return request(app).post("/api/github-app/webhook").set("Content-Type", "application/json")
      .set("x-github-event", event).set("x-github-delivery", delivery)
      .set("x-hub-signature-256", `sha256=${createHmac("sha256", valid ? cfg.webhookSecret : "wrong").update(raw).digest("hex")}`).send(raw);
  };
  return { store, state, client, app, link, webhook };
}
describe("GitHub App security and lifecycle", () => {
  it("rejects missing authentication and cross-origin mutations", async () => {
    const f = fixture();
    expect((await request(f.app).get("/api/github-app/status")).status).toBe(401);
    expect((await request(f.app).post("/api/github-app/connect").set("x-test-actor", "alice").set("origin", "https://evil.test")).status).toBe(403);
    expect(Object.keys(f.state.records.githubApp)).toHaveLength(0);
  });
  it("binds state to user, app, stage, expiry, and one use across store instances", async () => {
    const f = fixture(), token = await f.store.issue("alice", 11, "install");
    await expect(f.store.consume(token, "bob", 11, "install")).rejects.toThrow("Invalid or expired");
    await expect(f.store.consume(token, "alice", 12, "install")).rejects.toThrow("Invalid or expired");
    await expect(f.store.consume(token, "alice", 11, "authorize")).rejects.toThrow("Invalid or expired");
    await new AppStore(f.store.service).consume(token, "alice", 11, "install");
    await expect(f.store.consume(token, "alice", 11, "install")).rejects.toThrow("Invalid or expired");
    const expired = await f.store.issue("alice", 11, "install");
    const row = Object.values(f.state.records.githubApp).find(r => unpack(r).used === false)!;
    row.data = JSON.stringify({ ...unpack(row), expiresAt: 1 });
    await expect(f.store.consume(expired, "alice", 11, "install")).rejects.toThrow("Invalid or expired");
    expect(JSON.stringify(f.state)).not.toContain(token);
  });
  it("links only after App user authorization, isolates tenants and preserves OAuth/billing/history", async () => {
    const f = fixture(), state = await f.store.issue("alice", 11, "authorize", 7);
    const r = await request(f.app).get("/api/github-app/callback").query({ state, code: "test-code" }).set("x-test-actor", "alice");
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("/dashboard?github_app=connected");
    expect(f.client.verifyOwner).toHaveBeenCalledWith(7, "ephemeral");
    const alice = await request(f.app).get("/api/github-app/status").set("x-test-actor", "alice");
    const bob = await request(f.app).get("/api/github-app/status").set("x-test-actor", "bob");
    expect(alice.body.installations).toHaveLength(1); expect(bob.body.installations).toEqual([]);
    expect((await request(f.app).delete("/api/github-app/installations/7").set("x-test-actor", "bob").set("origin", cfg.origin)).status).toBe(404);
    const second = await f.store.issue("bob", 11, "authorize", 7);
    expect((await request(f.app).get("/api/github-app/callback").query({ state: second, code: "code" }).set("x-test-actor", "bob")).status).toBe(409);
    expect(f.state.records.receipts["1"].original).toBe("immutable historical bytes");
    expect(f.state.records.subscriptions["1"].stripeSubscriptionId).toBe("unchanged");
    expect(JSON.stringify(f.state)).not.toContain("ephemeral");
  });
  it("rejects forged signatures, wrong App IDs and changed-body delivery reuse", async () => {
    const f = fixture();
    const body = { action: "created", installation: { id: 7, app_id: 11, account: { id: 99 } } };
    expect((await f.webhook("installation", body, "one", false)).status).toBe(401);
    expect(f.client.verifyApp).not.toHaveBeenCalled();
    expect((await f.webhook("installation", { ...body, installation: { id: 7, app_id: 12 } }, "wrong")).status).toBe(403);
    expect((await f.webhook("installation", body, "one")).body.status).toBe("processed");
    expect((await f.webhook("installation", body, "one")).body.status).toBe("duplicate");
    expect((await f.webhook("installation", { ...body, action: "suspend" }, "one")).status).toBe(409);
  });
  it("handles repository removal and suspension by reconciling current GitHub access", async () => {
    const f = fixture(); await f.link();
    vi.mocked(f.client.snapshot).mockResolvedValueOnce({ ...snapshot(), repositories: [] } as any);
    expect((await f.webhook("installation_repositories", { action: "removed", installation: { id: 7, app_id: 11 } })).status).toBe(200);
    expect(unpack(f.state.records.githubApp[installKey(11, 7)]).repositories).toEqual([]);
    vi.mocked(f.client.snapshot).mockResolvedValueOnce({ ...snapshot(), status: "suspended", repositories: [] } as any);
    await f.webhook("installation", { action: "suspend", installation: { id: 7, app_id: 11 } }, "suspend");
    const row = f.state.records.githubApp[installKey(11, 7)];
    expect(row.ownerId).toBe("alice"); expect(unpack(row).status).toBe("suspended");
    expect((await request(f.app).get("/api/github-app/installations/7/repositories/8/contents").set("x-test-actor", "alice").query({ path: "a.ts", ref: "a".repeat(40) })).status).toBe(403);
  });
  it("deleted events revoke only after GitHub confirms absent; delayed events cannot override current state", async () => {
    const f = fixture(); await f.link();
    const body = { action: "deleted", installation: { id: 7, app_id: 11, account: { id: 99 } } };
    await f.webhook("installation", body);
    expect(unpack(f.state.records.githubApp[installKey(11, 7)]).status).toBe("active");
    vi.mocked(f.client.snapshot).mockRejectedValueOnce(new AppError(404, "absent"));
    await f.webhook("installation", body, "deleted");
    expect(unpack(f.state.records.githubApp[installKey(11, 7)]).status).toBe("deleted");
  });
  it("processes purchases, pending changes and cancellations without touching Stripe or granting billing", async () => {
    const f = fixture(); await f.link();
    const body = { action: "purchased", marketplace_purchase: { account: { id: 99 } } };
    expect((await f.webhook("marketplace_purchase", body)).body.billingActivated).toBe(false);
    expect(unpack(f.state.records.githubApp[purchaseKey(11, 99)]).planId).toBe(123);
    vi.mocked(f.client.request).mockResolvedValueOnce({ id: 99, marketplace_purchase: { plan: { id: 123 } },
      marketplace_pending_change: { plan: { id: 456 }, effective_date: "2027-01-01T00:00:00Z" } });
    await f.webhook("marketplace_purchase", { ...body, action: "pending_change" }, "pending");
    expect(unpack(f.state.records.githubApp[purchaseKey(11, 99)]).pendingPlanId).toBe(456);
    vi.mocked(f.client.request).mockRejectedValueOnce(new AppError(404, "not purchased"));
    await f.webhook("marketplace_purchase", { ...body, action: "cancelled" }, "cancel");
    expect(unpack(f.state.records.githubApp[purchaseKey(11, 99)]).status).toBe("cancelled");
    expect(f.state.records.subscriptions["1"]).toEqual({ id: 1, plan: "pro", stripeSubscriptionId: "unchanged" });
    expect(f.state.records.receipts["1"].original).toBe("immutable historical bytes");
  });
  it("does not acknowledge or persist failed reconciliation, allowing safe redelivery", async () => {
    const f = fixture();
    vi.mocked(f.client.request).mockRejectedValueOnce(new AppError(502, "unavailable"));
    const body = { action: "purchased", marketplace_purchase: { account: { id: 99 } } };
    expect((await f.webhook("marketplace_purchase", body)).status).toBe(502);
    expect(Object.keys(f.state.records.githubApp)).toHaveLength(0);
    expect((await f.webhook("marketplace_purchase", body)).body.status).toBe("processed");
  });
  it("prevents a stale reconciliation overwriting a concurrent link/refresh", async () => {
    const f = fixture(); await f.link();
    vi.mocked(f.client.snapshot).mockImplementationOnce(async () => {
      await f.store.transact(() => ({ rows: [record(installKey(11, 7), "installation", "alice", { ...snapshot(), status: "suspended", repositories: [] })], result: undefined }));
      return snapshot();
    });
    await expect(processEvent(f.store, f.client, "installation", "concurrent", Buffer.from(JSON.stringify({
      action: "unsuspend", installation: { id: 7, app_id: 11 },
    })))).rejects.toThrow("Concurrent");
    expect(unpack(f.state.records.githubApp[installKey(11, 7)]).status).toBe("suspended");
  });
  it("unlinks locally without uninstalling GitHub or retaining account access", async () => {
    const f = fixture(); await f.link();
    expect((await request(f.app).delete("/api/github-app/installations/7").set("x-test-actor", "alice").set("origin", cfg.origin)).body).toEqual({ unlinked: true, githubUninstalled: false });
    expect((await request(f.app).get("/api/github-app/status").set("x-test-actor", "alice")).body.installations).toEqual([]);
  });
  it("rechecks selected repository access and mints only a repository-scoped read token", async () => {
    const f = fixture(); await f.link();
    const url = "/api/github-app/installations/7/repositories/8/contents";
    const query = { path: "src/a.ts", ref: "a".repeat(40) };
    expect((await request(f.app).get(url).query(query).set("x-test-actor", "bob")).status).toBe(404);
    vi.mocked(f.client.snapshot).mockResolvedValueOnce({ ...snapshot(), repositories: [] } as any);
    expect((await request(f.app).get(url).query(query).set("x-test-actor", "alice")).status).toBe(403);
    expect(f.client.installationToken).not.toHaveBeenCalled();
    vi.mocked(f.client.request).mockResolvedValueOnce({ type: "file", path: "src/a.ts", encoding: "base64", size: 3, content: "YWJj", sha: "b".repeat(40) });
    const allowed = await request(f.app).get(url).query(query).set("x-test-actor", "alice");
    expect(allowed.status).toBe(200);
    expect(f.client.installationToken).toHaveBeenCalledWith(7, [8]);
    expect(allowed.body).not.toHaveProperty("token");
    expect((await request(f.app).get(url).query({ ...query, path: "../secret" }).set("x-test-actor", "alice")).status).toBe(400);
  });
  it("allows only one concurrent consumption of connection state", async () => {
    const f = fixture(), token = await f.store.issue("alice", 11, "authorize", 7);
    const results = await Promise.allSettled([f.store.consume(token, "alice", 11, "authorize"), new AppStore(f.store.service).consume(token, "alice", 11, "authorize")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  });
});
describe("separate App client", () => {
  it("fails closed without config and never borrows existing OAuth secrets", () => {
    expect(() => config({ GITHUB_CLIENT_ID: "old", GITHUB_CLIENT_SECRET: "old-secret" })).toThrow("not configured");
    const env: any = Object.fromEntries(Object.entries({ ID: "11", CLIENT_ID: "old", CLIENT_SECRET: "separate", PRIVATE_KEY: "key",
      WEBHOOK_SECRET: "secret", SLUG: "fixture", PUBLIC_ORIGIN: "https://example.test" }).map(([k, v]) => ["FORGEPROOF_GITHUB_APP_" + k, v]));
    expect(() => config({ ...env, GITHUB_CLIENT_ID: "old" })).toThrow("separate client ID");
  });
  it("checks App identity and rejects repository write permissions", async () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const c = new GitHubAppClient({ ...cfg, privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
      vi.fn(async () => new Response(JSON.stringify({ id: 11, client_id: "new-client", slug: "fixture-app", permissions: { contents: "write" } }))) as any);
    await expect(c.verifyApp()).rejects.toThrow("read-only");
  });
  it("limits minted installation tokens to read permissions and selected repository IDs", async () => {
    const f = fixture();
    const c = new GitHubAppClient(cfg);
    c.jwt = () => "fixture";
    c.request = vi.fn(async () => ({ token: "limited" }));
    await c.installationToken(7, [8]);
    expect(c.request).toHaveBeenCalledWith("/app/installations/7/access_tokens", "fixture",
      { permissions: { contents: "read", metadata: "read" }, repository_ids: [8] });
    expect(f.state.records.githubApp).toEqual({});
  });
  it("rejects a user with installation visibility but no account administration rights", async () => {
    const c = new GitHubAppClient(cfg);
    c.request = vi.fn(async path => path === "/user" ? { id: 1 } : path.startsWith("/user/installations")
      ? { installations: [{ id: 7, app_id: 11 }] } : { role: "member", state: "active", organization: { id: 99 } });
    c.installation = vi.fn(async () => ({ id: 7, account: { id: 99, login: "sample", type: "Organization" } }));
    await expect(c.verifyOwner(7, "user-token")).rejects.toThrow("administrator");
  });
  it("forbids secrets and billing activation in signed App records", () => {
    expect(() => validateRecord("githubApp", record("x", "purchase", null, { appId: 11, accountId: 99, status: "active",
      planId: 123, verifiedAt: new Date().toISOString(), billingActivated: true }))).toThrow();
    expect(() => validateRecord("githubApp", record("x", "state", "alice", { accessToken: "no" }))).toThrow();
  });
});
