import { createPrivateKey, sign } from "node:crypto";
import { AppError } from "./store";

export type AppConfig = { id: number; clientId: string; clientSecret: string; privateKey: string; webhookSecret: string; slug: string; origin: string };
export function config(env = process.env): AppConfig {
  const prefix = "FORGEPROOF_GITHUB_APP_";
  const values = ["ID", "CLIENT_ID", "CLIENT_SECRET", "PRIVATE_KEY", "WEBHOOK_SECRET", "SLUG", "PUBLIC_ORIGIN"].map(k => env[prefix + k]);
  if (values.some(v => !v)) throw new AppError(503, "Separate GitHub App registration is not configured. Existing OAuth remains available.");
  const [id, clientId, clientSecret, privateKey, webhookSecret, slug, origin] = values as string[];
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)) || !/^[a-z0-9-]+$/.test(slug) ||
      !/^https:\/\/[^/]+$/.test(origin) || new URL(origin).username || new URL(origin).password)
    throw new AppError(503, "Invalid GitHub App configuration");
  if (clientId === env.GITHUB_CLIENT_ID) throw new AppError(503, "GitHub App must use a separate client ID from existing OAuth");
  return { id: Number(id), clientId, clientSecret, privateKey: privateKey.replace(/\\n/g, "\n"), webhookSecret, slug, origin };
}
export class GitHubAppClient {
  constructor(readonly cfg: AppConfig, readonly transport: typeof fetch = fetch) {}
  jwt() {
    const now = Math.floor(Date.now() / 1000);
    const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: this.cfg.clientId })}`;
    const key = createPrivateKey(this.cfg.privateKey);
    if (key.asymmetricKeyType !== "rsa") throw new AppError(503, "GitHub App requires its own RSA private key");
    return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
  }
  async request(path: string, token: string, body?: object) {
    const res = await this.transport(`https://api.github.com${path}`, {
      method: body ? "POST" : "GET", signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new AppError(res.status === 404 ? 404 : 502, "GitHub could not verify access");
    return res.json();
  }
  async verifyApp() {
    const app = await this.request("/app", this.jwt());
    if (app.id !== this.cfg.id || app.slug !== this.cfg.slug || app.client_id !== this.cfg.clientId)
      throw new AppError(503, "GitHub App ID, slug, client ID and signing key do not match");
    // No repository write privileges or unrelated organization permissions.
    for (const [name, value] of Object.entries(app.permissions ?? {}))
      if (!["contents", "metadata", "members"].includes(name) || value !== "read")
        throw new AppError(503, "GitHub App permissions exceed the supported read-only configuration");
    if (app.permissions?.contents !== "read") throw new AppError(503, "GitHub App requires Contents read permission");
    return app;
  }
  async exchange(code: string) {
    const res = await this.transport("https://github.com/login/oauth/access_token", {
      method: "POST", signal: AbortSignal.timeout(15000), headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, code, redirect_uri: `${this.cfg.origin}/api/github-app/callback` }),
    });
    const data = await res.json();
    if (!res.ok || !data.access_token || data.error) throw new AppError(400, "GitHub App authorization failed");
    return String(data.access_token);
  }
  async installation(id: number) {
    const data = await this.request(`/app/installations/${id}`, this.jwt());
    if (data.app_id !== this.cfg.id || data.id !== id) throw new AppError(403, "Wrong GitHub App installation");
    return data;
  }
  async verifyOwner(id: number, token: string) {
    const user = await this.request("/user", token);
    // This user must have access to this installation through THIS App.
    let found = false;
    for (let page = 1; page <= 100; page++) {
      const list = await this.request(`/user/installations?per_page=100&page=${page}`, token);
      found ||= list.installations.some((i: any) => i.id === id && i.app_id === this.cfg.id);
      if (found || list.installations.length < 100) break;
    }
    if (!found) throw new AppError(403, "GitHub installation access denied");
    const installation = await this.installation(id);
    if (installation.suspended_at) throw new AppError(403, "GitHub installation suspended");
    if (installation.account.type === "User") {
      if (installation.account.id !== user.id) throw new AppError(403, "Only the GitHub account owner may link this installation");
    } else if (installation.account.type === "Organization") {
      const membership = await this.request(`/user/memberships/orgs/${encodeURIComponent(installation.account.login)}`, token);
      if (membership.state !== "active" || membership.role !== "admin" || membership.organization?.id !== installation.account.id)
        throw new AppError(403, "An organization administrator must link this installation");
    } else throw new AppError(403, "Unsupported installation account");
    return installation;
  }
  async installationToken(id: number, repositoryIds?: number[]) {
    const token = await this.request(`/app/installations/${id}/access_tokens`, this.jwt(), {
      permissions: { contents: "read", metadata: "read" }, ...(repositoryIds ? { repository_ids: repositoryIds } : {}),
    });
    if (typeof token.token !== "string" || !token.token) throw new AppError(502, "GitHub did not issue an installation token");
    return token.token;
  }
  async snapshot(id: number) {
    const installation = await this.installation(id);
    const repositories: { id: number; fullName: string }[] = [];
    if (!installation.suspended_at) {
      const token = await this.installationToken(id);
      for (let page = 1; page <= 100; page++) {
        const list = await this.request(`/installation/repositories?per_page=100&page=${page}`, token);
        repositories.push(...list.repositories.map((r: any) => ({ id: r.id, fullName: r.full_name })));
        if (list.repositories.length < 100) break;
        if (page === 100) throw new AppError(502, "Repository inventory exceeds supported limit");
      }
    }
    return { appId: this.cfg.id, id, accountId: installation.account.id, accountLogin: installation.account.login,
      status: installation.suspended_at ? "suspended" : "active", repositorySelection: installation.repository_selection, repositories };
  }
}
