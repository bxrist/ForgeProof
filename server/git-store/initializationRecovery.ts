import { bootId } from "../bootIdentity.mjs";
import { GitReadUnavailableError } from "./github-store.mjs";

export function initializationRecoveryEnabled(env = process.env): boolean {
  const value = env.FORGEPROOF_GIT_INIT_RECOVERY;
  if (value !== undefined && value !== "true" && value !== "false")
    throw new Error("Invalid Git initialization recovery configuration");
  return value === "true";
}

/** Read-only replay only. Never wrap installation, custody, append or route setup.
 * The elapsed budget limits admission of retries, not the duration of a replay.
 * Await each attempt fully; a timed-out Promise.race must not orphan a replay.
 */
export async function replayDuringInitialization<T>(service: { replay(): Promise<T> }, enabled: boolean): Promise<T> {
  const started = performance.now();
  const attempts = enabled ? 3 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const state = await service.replay();
      console.info("[git-init]", JSON.stringify({ bootId, operation: "initial_replay", attempt,
        elapsedMs: Math.round(performance.now() - started), outcome: "verified" }));
      return state;
    } catch (error) {
      const transient = error instanceof GitReadUnavailableError;
      const delay = attempt * 500;
      const retry = transient && attempt < attempts && performance.now() - started + delay < 60000;
      console.info("[git-init]", JSON.stringify({ bootId, operation: "initial_replay", attempt,
        elapsedMs: Math.round(performance.now() - started),
        category: transient ? "transient_upstream_read" : "hard_failure",
        outcome: retry ? "retry_pending" : "failed" }));
      if (!retry) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error("Git initialization attempt limit");
}
