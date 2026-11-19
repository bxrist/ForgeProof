import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
const execFileAsync = promisify(execFile);
const CLI_MS = 5000, LOCAL_MS = 5000, CACHE_MS = 20000, MARGIN_MS = 30000;
const LOOPBACK = "http://127.0.0.1:1105/getIdentityToken";
type Stage = "cli" | "local" | "broker";
type Outcome = "success" | "timeout" | "connection_failure" | "http_5xx" | "authorization_denied" | "invalid_response" | "unavailable" | "shared" | "cache_hit";
export type IdentityTrace = (event: { stage: Stage; outcome: Outcome; elapsedMs: number; budgetMs?: number }) => void;
export type IdentityMethods = { cli(audience: string): Promise<string>; local(audience: string, budgetMs: number): Promise<string> };
class IdentityUnavailable extends Error {
  constructor(readonly category: Outcome) { super("Deployment identity unavailable"); this.name = "IdentityUnavailable"; }
}
const defaultReport: IdentityTrace = event => console.info("[git-identity]", JSON.stringify(event));
function audienceOf(env: NodeJS.ProcessEnv): string {
  const value = env.REPLIT_CONNECTORS_AUDIENCE;
  if (!value) return "https://connectors.replit.com";
  return /^https?:\/\//.test(value) ? value : "https://" + value;
}
function scopeOf(env: NodeJS.ProcessEnv): string {
  return JSON.stringify([env.REPLIT_DEPLOYMENT_ID, env.REPLIT_DEPLOYMENT_ENVIRONMENT, !!env.WEB_REPL_RENEWAL,
    !!env.REPLIT_CONRUN, env.REPLIT_CONNECTORS_AUDIENCE, env.REPLIT_CONNECTORS_HOSTNAME, env.REPLIT_CLI]);
}
export function isReplitDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.REPLIT_CONRUN && !!(env.REPLIT_DEPLOYMENT_ID ||
    env.REPLIT_DEPLOYMENT_ENVIRONMENT || env.WEB_REPL_RENEWAL);
}
async function cliMint(audience: string): Promise<string> {
  const { stdout } = await execFileAsync(process.env.REPLIT_CLI || "replit",
    ["identity", "create", "--audience", audience], { encoding: "utf8", timeout: CLI_MS, windowsHide: true });
  const token = stdout.trim();
  if (!token) throw new IdentityUnavailable("invalid_response");
  return token;
}
export async function localMint(audience: string, budgetMs: number): Promise<string> {
  const deadline = Date.now() + budgetMs;
  let category: Outcome = "unavailable";
  do {
    const remaining = Math.max(1, deadline - Date.now());
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), remaining);
    try {
      const response = await fetch(LOOPBACK, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audience }), signal: ctrl.signal,
      });
      if (response.status === 401 || response.status === 403) throw new IdentityUnavailable("authorization_denied");
      if (response.status >= 500) category = "http_5xx";
      else if (!response.ok) throw new IdentityUnavailable("unavailable");
      else {
        const data: unknown = await response.json().catch(() => null);
        if (!data || typeof data !== "object" || !("identityToken" in data) ||
          typeof (data as { identityToken: unknown }).identityToken !== "string" ||
          !(data as { identityToken: string }).identityToken.trim()) {
          throw new IdentityUnavailable("invalid_response");
        }
        return (data as { identityToken: string }).identityToken.trim();
      }
    } catch (error) {
      if (error instanceof IdentityUnavailable) {
        if (error.category !== "http_5xx") throw error;
        category = error.category;
      } else category = ctrl.signal.aborted ? "timeout" : "connection_failure";
    } finally { clearTimeout(timer); }
    const available = deadline - Date.now();
    if (available <= 0) break;
    await delay(Math.min(250, available));
  } while (Date.now() < deadline);
  throw new IdentityUnavailable(category);
}
function cacheUntil(token: string, now: number): number {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1].length > 16384) return 0;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object" || !("exp" in payload)) return 0;
    const exp = (payload as { exp: unknown }).exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) return 0;
    const until = Math.min(now + CACHE_MS, exp * 1000 - MARGIN_MS);
    return until > now ? until : 0;
  } catch { return 0; }
}
/** Shared across the SDK connector objects that are otherwise created per Git request. */
export class DeploymentIdentityBroker {
  private cached?: { scope: string; token: string; until: number };
  private running?: { scope: string; promise: Promise<string> };
  private revision = 0;
  constructor(private readonly methods: IdentityMethods = { cli: cliMint, local: localMint },
    private readonly now: () => number = Date.now, private readonly report: IdentityTrace = defaultReport) {}
  invalidate(): void { this.revision++; this.cached = undefined; }
  async headers(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
    const scope = scopeOf(env), now = this.now();
    if (this.cached?.scope === scope && this.cached.until > now) {
      this.report({ stage: "broker", outcome: "cache_hit", elapsedMs: 0 });
      return { "X-Replit-Token": "depl " + this.cached.token };
    }
    if (this.running?.scope === scope) {
      this.report({ stage: "broker", outcome: "shared", elapsedMs: 0 });
      return { "X-Replit-Token": "depl " + await this.running.promise };
    }
    const version = this.revision, audience = audienceOf(env);
    const work = async () => {
      let token: string | undefined;
      const startCli = performance.now();
      try {
        token = await this.methods.cli(audience);
        this.report({ stage: "cli", outcome: "success", elapsedMs: Math.round(performance.now() - startCli), budgetMs: CLI_MS });
      } catch (error) {
        const outcome: Outcome = error instanceof IdentityUnavailable ? error.category :
          typeof error === "object" && error !== null && "killed" in error && error.killed === true ? "timeout" : "unavailable";
        this.report({ stage: "cli", outcome, elapsedMs: Math.round(performance.now() - startCli), budgetMs: CLI_MS });
      }
      if (!token) {
        const startLocal = performance.now();
        try {
          token = await this.methods.local(audience, LOCAL_MS);
          this.report({ stage: "local", outcome: "success", elapsedMs: Math.round(performance.now() - startLocal), budgetMs: LOCAL_MS });
        } catch (error) {
          const outcome: Outcome = error instanceof IdentityUnavailable ? error.category : "unavailable";
          this.report({ stage: "local", outcome, elapsedMs: Math.round(performance.now() - startLocal), budgetMs: LOCAL_MS });
          throw new IdentityUnavailable(outcome);
        }
      }
      if (version === this.revision) {
        const until = cacheUntil(token, this.now());
        if (until) this.cached = { scope, token, until };
      }
      return token;
    };
    const promise = work();
    this.running = { scope, promise };
    try { return { "X-Replit-Token": "depl " + await promise }; }
    finally { if (this.running?.promise === promise) this.running = undefined; }
  }
}
export const deploymentIdentityBroker = new DeploymentIdentityBroker();
