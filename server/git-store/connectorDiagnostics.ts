import { ReplitConnectors } from "@replit/connectors-sdk";
import { deploymentIdentityBroker, isReplitDeployment } from "./deploymentIdentity";

// No headers, values, URLs, identifiers, or exception text cross this boundary.
// Keep SDK identity selection and proxy implementation; observe only phases.
export class ObservedGitConnector extends ReplitConnectors {
  // Retry ownership belongs to GitHubTransport. In particular an SDK-internal
  // 401 replay must never duplicate a write or silently change attempt budgets.
  protected readonly retryUnauthorized = false;
  constructor(private readonly attempt: number) { super(); }
  private report(phase: string, category: string, started: number) {
    console.info("[git-connector]", JSON.stringify({
      phase, category, elapsedMs: Math.round(performance.now() - started),
      attempt: this.attempt,
    }));
  }
  protected async buildApiHeaders(): Promise<Record<string, string>> {
    const started = performance.now();
    try {
      // The SDK acquires a new identity for every Git request and shares a
      // five-second CLI/fallback deadline. Preserve SDK behavior in editor,
      // but use the bounded deployment broker when running in production.
      const headers = isReplitDeployment()
        ? await deploymentIdentityBroker.headers()
        : await super.buildApiHeaders();
      this.report("identity_headers", "success", started);
      return headers;
    } catch (error) {
      this.report("identity_headers", "UNKNOWN", started);
      throw error; // Preserve native denial/integrity identity and cause.
    }
  }
  protected async fetchApi(url: string, init: RequestInit): Promise<Response> {
    const started = performance.now();
    try {
      const response = await super.fetchApi(url, init);
      // Never replay a write after an authorization denial; only invalidate
      // the per-process token for a future independent request.
      if (isReplitDeployment() && (response.status === 401 || response.status === 403)) {
        deploymentIdentityBroker.invalidate();
      }
      const category = response.status === 401 || response.status === 403 ? "authorization_denied"
        : response.status === 429 ? "rate_limited"
        : response.status >= 500 ? "upstream_error"
        : response.ok ? "success" : "http_error";
      this.report("proxy_request", category, started);
      return response;
    } catch (error) {
      this.report("proxy_request", "UNKNOWN", started);
      throw error;
    }
  }
}
