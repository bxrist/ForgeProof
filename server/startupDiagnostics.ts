import { bootId } from "./bootIdentity.mjs";
import { IntegrityError } from "./git-store/store.mjs";

const codes = new Set(["GIT_RATE_LIMITED", "GIT_READ_DEADLINE", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED",
  "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET", "ABORT_ERR", "ERR_MODULE_NOT_FOUND"]);
type Phase = "listen" | "storage" | "routes" | "assets" | "ready" |
  "connector_import" | "connector_setup" | "connector_proxy";
function safeCode(error: unknown): string | null {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : null;
  return typeof code === "string" && codes.has(code) ? code : null;
}
function errorClass(error: unknown): string {
  if (error instanceof IntegrityError) return "IntegrityError";
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof RangeError) return "RangeError";
  return error instanceof Error ? "Error" : "Unknown";
}
export function reportStartupDiagnostic(phase: Phase, error?: unknown): void {
  const failed = error !== undefined;
  console.error("[startup-diagnostic]", JSON.stringify({
    bootId, phase, outcome: failed ? "failed" : "entered",
    category: !failed ? null : error instanceof IntegrityError ? "git_integrity"
      : safeCode(error) === "GIT_RATE_LIMITED" ? "git_rate_limited" : "initialization_error",
    errorClass: failed ? errorClass(error) : null,
    code: safeCode(error),
    causeCode: error instanceof Error ? safeCode(error.cause) : null,
  }));
}

// Preserve the original exception and retry semantics; diagnose only.
export async function diagnosticPhase<T>(phase: Phase, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { reportStartupDiagnostic(phase, error); throw error; }
}
