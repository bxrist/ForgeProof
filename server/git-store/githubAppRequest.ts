import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Init = { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; diagnosticAttempt?: number };
const denied = () => Object.assign(new Error("GitHub App authorization/configuration denied"), { code: "GIT_APP_AUTHORIZATION" });
const oid = /^[a-f0-9]{40}$/;

/** Dedicated project identity only; no PAT, CLI identity, connector or auth replay. */
export function createGitHubAppRequest(env = process.env, fetcher: typeof fetch = fetch) {
  if (env.FORGEPROOF_GIT_TRANSPORT !== "github-app") throw denied();
  const id = (s: string | undefined) => {
    if (!s || !/^[1-9][0-9]*$/.test(s) || !Number.isSafeInteger(Number(s))) throw denied();
    return Number(s);
  };
  const app = id(env.FORGEPROOF_GIT_APP_ID);
  const installation = id(env.FORGEPROOF_GIT_APP_INSTALLATION_ID);
  const repositoryId = id(env.FORGEPROOF_GIT_APP_REPOSITORY_ID);
  const repository = env.FORGEPROOF_GIT_GITHUB_REPOSITORY ?? "";
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(repository)) throw denied();
  const tenant = env.FORGEPROOF_GIT_TENANT;
  const stream = env.FORGEPROOF_GIT_STREAM;
  if (![tenant, stream].every(s => s && /^[A-Za-z0-9_-]+$/.test(s))) throw denied();
  const base = `/repos/${repository}`;
  const eventRef = `heads/forgeproof/${tenant}/${stream}`;
  const vaultPrefix = `heads/forgeproof-vault/${tenant}/`;
  const allowedRef = (ref: string) => ref === eventRef || (ref.startsWith(vaultPrefix) && oid.test(ref.slice(vaultPrefix.length)));
  const pem = env.FORGEPROOF_GIT_APP_PRIVATE_KEY;
  const credential = env.FORGEPROOF_GIT_APP_KEY_CREDENTIAL;
  const directory = env.CREDENTIALS_DIRECTORY;
  if (Boolean(pem) === Boolean(credential)) throw denied();
  if (credential && (!/^[A-Za-z0-9_-]+$/.test(credential) || !directory?.startsWith("/"))) throw denied();
  // Snapshot only the explicit reference, never enumerate credentials directories.
  const key = () => {
    try {
      const value = pem ?? readFileSync(join(directory!, credential!), "utf8");
      if (value.length > 32768) throw denied();
      const k = createPrivateKey(value);
      if (k.asymmetricKeyType !== "rsa" || (k.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw denied();
      return k;
    } catch { throw denied(); }
  };
  key(); // Missing/malformed credentials fail at selection time.
  let cached: { value: string; expiry: number } | undefined;
  let pending: { promise: Promise<{ value: string; expiry: number }>; controller: AbortController; users: number } | undefined;
  let cooldown = 0;
  // Only numeric rate metadata is allowed to cross the sanitized boundary.
  const rateHeaders = (headers: Headers) => {
    const safe = new Headers();
    for (const name of ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
      const value = headers.get(name);
      if (value && /^\d{1,12}$/.test(value)) safe.set(name, value);
    }
    return safe;
  };
  const limited = (response: Response) => response.status === 429 || response.status === 403 &&
    (response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0");
  const bodyLimited = async (response: Response) => {
    const reader = response.body?.getReader();
    if (!reader) return false;
    // Inspect only a small, complete JSON body; never retain or expose error text.
    const bytes = new Uint8Array(4096);
    let length = 0;
    try {
      while (length < bytes.length) {
        const chunk = await reader.read();
        if (chunk.done) {
          const message = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)))?.message;
          return typeof message === "string" &&
            /^(You have exceeded a secondary rate limit\.|API rate limit exceeded(?: for |\.))/.test(message);
        }
        if (chunk.value.length > bytes.length - length) return false;
        bytes.set(chunk.value, length);
        length += chunk.value.length;
      }
      return false;
    } catch { return false; }
    finally { void reader.cancel().catch(() => {}); }
  };
  const rememberLimit = (response: Response) => {
    if (limited(response)) {
      const retry = Number(response.headers.get("retry-after") ?? 0) * 1000;
      const reset = response.headers.get("x-ratelimit-remaining") === "0"
        ? Number(response.headers.get("x-ratelimit-reset") ?? 0) * 1000 - Date.now() : 0;
      cooldown = Math.max(cooldown, Date.now() + Math.max(60000, retry, reset));
    }
  };
  const wait = async <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => {
    if (signal.aborted) {
      void operation.catch(() => {});
      throw denied();
    }
    let abort: () => void = () => {};
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        abort = () => reject(denied());
        signal.addEventListener("abort", abort, { once: true });
      })]);
    } finally { signal.removeEventListener("abort", abort); }
  };
  const send = async (path: string, token: string, init: RequestInit, signal?: AbortSignal) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      if (combined.aborted) throw denied();
      const operation = async () => {
        if (combined.aborted) throw denied();
        const response = await fetcher(`https://api.github.com${path}`, { ...init, redirect: "error", signal: combined,
          headers: { accept: "application/vnd.github+json", "content-type": "application/json",
            "x-github-api-version": "2022-11-28", "user-agent": "ForgeProof-Git-App",
            authorization: `Bearer ${token}` } });
        if (response.status >= 300) {
          const headers = rateHeaders(response.headers);
          if (response.status === 403 && !limited(response) && await bodyLimited(response)) {
            headers.set("retry-after", "60");
          }
          void response.body?.cancel().catch(() => {});
          const sanitized = new Response("{}", { status: response.status, headers });
          rememberLimit(sanitized);
          return sanitized;
        }
        const text = await response.text();
        JSON.parse(text); // Malformed JSON must never leak raw response excerpts.
        return new Response(text, { status: response.status });
      };
      return await wait(Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(denied()); }, 30000);
      })]), combined);
    } catch { throw denied(); } // Never propagate fetch errors containing headers or URLs.
    finally { clearTimeout(timer); }
  };
  const json = async (path: string, token: string, status: number, init: RequestInit = {}, signal?: AbortSignal) => {
    const response = await send(path, token, init, signal);
    try {
      if (response.status !== status) throw denied();
      return await response.json();
    } catch { throw denied(); }
  };
  const repoMatches = (r: any) => r?.id === repositoryId && r?.full_name === repository && r?.private === true;
  const mint = async (signal: AbortSignal) => {
    const start = Date.now();
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const payload = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: Math.floor(start / 1000) - 60, exp: Math.floor(start / 1000) + 540, iss: String(app) })}`;
    const jwt = `${payload}.${sign("RSA-SHA256", Buffer.from(payload), key()).toString("base64url")}`;
    const binding = await json(`${base}/installation`, jwt, 200, {}, signal);
    if (binding?.id !== installation || binding.app_id !== app || binding.account?.login !== repository.split("/")[0] || binding.suspended_at !== null) throw denied();
    const result = await json(`/app/installations/${installation}/access_tokens`, jwt, 201, {
      method: "POST", body: JSON.stringify({ repository_ids: [repositoryId], permissions: { contents: "write" } }),
    }, signal);
    const expiry = Date.parse(result?.expires_at);
    if (typeof result?.token !== "string" || !result.token || /\s/.test(result.token) ||
        !Number.isFinite(expiry) || expiry <= Date.now() + 60000 || expiry > Date.now() + 3600000 ||
        result.permissions?.contents !== "write" || Object.entries(result.permissions).some(([k, v]) => k !== "contents" && !(k === "metadata" && v === "read")) ||
        !Array.isArray(result.repositories) || result.repositories.length !== 1 || !repoMatches(result.repositories[0])) throw denied();
    const accessible = await json("/installation/repositories?per_page=100", result.token, 200, {}, signal);
    if (accessible?.total_count !== 1 || accessible.repositories?.length !== 1 || !repoMatches(accessible.repositories[0])) throw denied();
    const target = await json(base, result.token, 200, {}, signal);
    if (!repoMatches(target) || Date.now() >= expiry - 60000) throw denied();
    return { value: result.token, expiry: Math.min(expiry, start + 3600000) };
  };
  return async (path: string, init: Init): Promise<Response> => {
    if (init.signal?.aborted) throw denied();
    const method = init.method ?? "GET";
    const suffix = path.startsWith(base + "/") ? path.slice(base.length) : "";
    let valid = false;
    if (method === "GET") {
      valid = /^\/git\/(blobs|trees|commits)\/[a-f0-9]{40}$/.test(suffix) ||
        (suffix.startsWith("/git/ref/") && allowedRef(suffix.slice(9)));
    } else if (method === "POST") {
      valid = ["/git/blobs", "/git/trees", "/git/commits"].includes(suffix);
      if (suffix === "/git/refs") {
        try { const b = JSON.parse(init.body!); valid = b.ref?.startsWith("refs/") && allowedRef(b.ref.slice(5)) && oid.test(b.sha); } catch { throw denied(); }
      }
    } else if (method === "PATCH" && suffix.startsWith("/git/refs/")) {
      try { const b = JSON.parse(init.body!); valid = allowedRef(suffix.slice(10)) && b.force === false && oid.test(b.sha); } catch { throw denied(); }
    }
    if (!valid || init.headers && Object.keys(init.headers).some(k => !["accept", "content-type"].includes(k.toLowerCase()))) throw denied();
    if (Date.now() < cooldown) return new Response("{}", { status: 429,
      headers: { "retry-after": String(Math.ceil((cooldown - Date.now()) / 1000)) } });
    if (!cached || Date.now() >= cached.expiry - 60000) {
      if (!pending) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        const signal = controller.signal;
        const acquisition = { controller, users: 0, promise: wait(mint(signal), signal) };
        acquisition.promise = acquisition.promise.then(token => {
          if (signal.aborted) throw denied();
          cached = token;
          return token;
        }).finally(() => {
          clearTimeout(timer);
          if (pending === acquisition) pending = undefined;
        });
        pending = acquisition;
      }
      const acquisition = pending;
      acquisition.users++;
      try { await wait(acquisition.promise, init.signal ?? new AbortController().signal); }
      finally {
        if (--acquisition.users === 0 && pending === acquisition) {
          pending = undefined;
          acquisition.controller.abort();
        }
      }
    }
    const active = cached;
    if (!active || init.signal?.aborted || Date.now() >= active.expiry - 60000) throw denied();
    const response = await send(path, active.value, { method, body: init.body }, init.signal);
    if (init.signal?.aborted || Date.now() >= active.expiry) { if (cached === active) cached = undefined; throw denied(); }
    if (!limited(response) && [401, 403].includes(response.status) && cached === active) cached = undefined;
    // Preserve transport-owned read retries, missing refs and CAS conflicts;
    // discard all error bodies so upstream diagnostics cannot expose raw data.
    const expected = method === "GET" ? [200, 404] : method === "POST" ? [201, 409, 422] : [200, 409, 422];
    if (!expected.includes(response.status) && ![401, 403, 429, 502, 503, 504].includes(response.status)) throw denied();
    if (response.status >= 400) return new Response("{}", { status: response.status,
      headers: rateHeaders(response.headers) });
    return response;
  };
}
