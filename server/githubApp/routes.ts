import type { Express, RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../middlewares/requireAuth";
import { AppError, AppStore, appStore, record, unpack } from "./store";
import { config, GitHubAppClient } from "./client";
import { installKey, positiveId, processEvent, purchaseKey, verifyWebhook } from "./events";

type Dependencies = { store: () => AppStore; client: () => GitHubAppClient; auth: RequestHandler };
export function registerGitHubAppRoutes(app: Express, deps: Dependencies = {
  store: appStore, client: () => new GitHubAppClient(config()), auth: requireAuth,
}) {
  const limiter = rateLimit({ windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false });
  const wrap = (fn: (req: any, res: any) => Promise<any>): RequestHandler => async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try { await fn(req, res); }
    catch (e) {
      res.status(e instanceof AppError ? e.status : 503).json({
        message: e instanceof AppError ? e.message : "GitHub App operation unavailable. Existing OAuth and billing are unchanged.",
      });
    }
  };
  const owned = async (store: AppStore, appId: number, id: number, owner: string) => {
    const state = await store.read();
    const row = state.records.githubApp[installKey(appId, id)];
    if (!row || row.ownerId !== owner) throw new AppError(404, "Installation not linked to this account");
    return { row, state, data: unpack(row) };
  };
  const sameOrigin = (req: any, client: GitHubAppClient) => {
    if (req.get("origin") !== client.cfg.origin) throw new AppError(403, "Same-origin request required");
  };
  const summary = (s: Awaited<ReturnType<AppStore["read"]>>, row: any) => {
    const data = unpack(row);
    return { ...data, marketplace: unpack(s.records.githubApp[purchaseKey(data.appId, data.accountId)]) ?? null };
  };
  app.get("/api/github-app/status", deps.auth, wrap(async (req, res) => {
    let client: GitHubAppClient;
    try { client = deps.client(); }
    catch (e) { return res.json({ configured: false, available: false, installations: [], message: e instanceof AppError ? e.message : "GitHub App configuration unavailable" }); }
    let store: AppStore;
    try { store = deps.store(); } catch { return res.json({ configured: true, available: false, installations: [], message: "GitHub App linking uses the Git application store; it is unavailable in this legacy SQL preview." }); }
    const s = await store.read();
    const installations = Object.values(s.records.githubApp).filter(r =>
      r.category === "installation" && r.ownerId === req.dbUser.id && unpack(r).appId === client.cfg.id).map(r => summary(s, r));
    res.json({ configured: true, available: true, installations,
      message: "Configuration present; credentials are verified with GitHub when connecting. Marketplace records never change Stripe billing." });
  }));
  app.post("/api/github-app/connect", deps.auth, limiter, wrap(async (req, res) => {
    const client = deps.client(), store = deps.store();
    sameOrigin(req, client);
    await client.verifyApp();
    const state = await store.issue(req.dbUser.id, client.cfg.id, "install");
    res.json({ url: `https://github.com/apps/${client.cfg.slug}/installations/new?state=${state}` });
  }));
  app.get("/api/github-app/setup", deps.auth, limiter, wrap(async (req, res) => {
    const client = deps.client(), store = deps.store();
    await client.verifyApp();
    const id = positiveId(req.query.installation_id);
    // Marketplace-initiated installs may lack our initial state. They still
    // require a new user-bound authorization round trip and verified ownership.
    if (req.query.state) await store.consume(String(req.query.state), req.dbUser.id, client.cfg.id, "install");
    await client.installation(id); // Never trust the setup query's App identity.
    const state = await store.issue(req.dbUser.id, client.cfg.id, "authorize", id);
    const params = new URLSearchParams({ client_id: client.cfg.clientId, state,
      redirect_uri: `${client.cfg.origin}/api/github-app/callback` });
    res.redirect(`https://github.com/login/oauth/authorize?${params}`);
  }));
  app.get("/api/github-app/callback", deps.auth, limiter, wrap(async (req, res) => {
    const client = deps.client(), store = deps.store();
    await client.verifyApp();
    const state = await store.consume(String(req.query.state ?? ""), req.dbUser.id, client.cfg.id, "authorize");
    if (typeof req.query.code !== "string" || req.query.code.length > 512) throw new AppError(400, "Missing authorization code");
    const userToken = await client.exchange(req.query.code);
    await client.verifyOwner(state.installationId, userToken);
    // User token is intentionally neither persisted nor exposed.
    const before = await store.read();
    const data = await client.snapshot(state.installationId);
    const key = installKey(client.cfg.id, data.id);
    await store.transact(s => {
      if (!s.records.users[req.dbUser.id]) throw new AppError(403, "Account unavailable");
      if (s.versions[`githubApp/${key}`] !== before.versions[`githubApp/${key}`]) throw new AppError(409, "Installation changed; reconnect");
      for (const row of Object.values(s.records.githubApp)) {
        const other = unpack(row);
        if (row.category === "installation" && other.appId === client.cfg.id && other.accountId === data.accountId &&
            row.ownerId && row.ownerId !== req.dbUser.id) throw new AppError(409, "GitHub account installation is already linked to another ForgeProof customer");
      }
      if (data.status !== "active") throw new AppError(403, "Installation is not active");
      return { rows: [record(key, "installation", req.dbUser.id, data)], result: undefined };
    });
    res.redirect("/dashboard?github_app=connected");
  }));
  app.post("/api/github-app/installations/:id/refresh", deps.auth, limiter, wrap(async (req, res) => {
    const store = deps.store(), client = deps.client(), id = positiveId(req.params.id);
    sameOrigin(req, client);
    const before = await owned(store, client.cfg.id, id, req.dbUser.id);
    await client.verifyApp();
    let data;
    try { data = await client.snapshot(id); }
    catch (e) {
      if (!(e instanceof AppError) || e.status !== 404) throw e;
      data = { ...before.data, status: "deleted", repositories: [] };
    }
    await store.transact(s => {
      if (s.versions[`githubApp/${before.row.id}`] !== before.state.versions[`githubApp/${before.row.id}`]) throw new AppError(409, "Installation changed; refresh again");
      return { rows: [record(String(before.row.id), "installation", req.dbUser.id, data)], result: undefined };
    });
    res.json(data);
  }));
  app.delete("/api/github-app/installations/:id", deps.auth, limiter, wrap(async (req, res) => {
    const store = deps.store(), client = deps.client(), id = positiveId(req.params.id);
    sameOrigin(req, client);
    await store.transact(s => {
      const key = installKey(client.cfg.id, id), row = s.records.githubApp[key];
      if (!row || row.ownerId !== req.dbUser.id) throw new AppError(404, "Installation not linked to this account");
      return { rows: [record(key, "installation", null, { ...unpack(row), status: "unlinked", repositories: [] })], result: undefined };
    });
    res.json({ unlinked: true, githubUninstalled: false });
  }));
  app.get("/api/github-app/installations/:id/repositories/:repoId/contents", deps.auth, limiter, wrap(async (req, res) => {
    const client = deps.client(), store = deps.store(), id = positiveId(req.params.id), repoId = positiveId(req.params.repoId);
    const before = await owned(store, client.cfg.id, id, req.dbUser.id);
    if (before.data.status !== "active") throw new AppError(403, "Installation is not active");
    await client.verifyApp();
    // Revalidate with GitHub on every read: stale webhook state cannot grant access.
    const snapshot = await client.snapshot(id);
    const repo = snapshot.repositories.find(r => r.id === repoId);
    if (!repo || snapshot.status !== "active") throw new AppError(403, "Repository access denied");
    const path: string = typeof req.query.path === "string" ? req.query.path : "";
    const ref: string = typeof req.query.ref === "string" ? req.query.ref : "";
    if (!/^[a-f0-9]{40}$/.test(ref) || path.split("/").some(p => !p || p === "." || p === "..") || /[\\\x00-\x1f]/.test(path))
      throw new AppError(400, "An immutable commit and valid file path are required");
    const token = await client.installationToken(id, [repoId]);
    const file = await client.request(`/repos/${repo.fullName}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`, token);
    const after = await owned(store, client.cfg.id, id, req.dbUser.id);
    if (after.data.status !== "active" ||
        after.state.versions[`githubApp/${after.row.id}`] !== before.state.versions[`githubApp/${before.row.id}`])
      throw new AppError(409, "Installation access changed during the read; retry");
    if (file.type !== "file" || file.encoding !== "base64" || file.size > 1024 * 1024) throw new AppError(400, "Only files up to 1 MiB are supported");
    res.json({ path: file.path, sha: file.sha, size: file.size, encoding: "base64", content: file.content });
  }));
  app.post("/api/github-app/webhook", limiter, wrap(async (req, res) => {
    const client = deps.client();
    verifyWebhook(req.rawBody, req.headers["x-hub-signature-256"], client.cfg.webhookSecret);
    res.json(await processEvent(deps.store(), client, String(req.headers["x-github-event"] ?? ""),
      String(req.headers["x-github-delivery"] ?? ""), req.rawBody));
  }));
}
