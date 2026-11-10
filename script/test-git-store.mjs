import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";

// DB-free tests must not inherit a workspace connection (or print it on failure).
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (name === "DATABASE_URL" || name.startsWith("PG")) delete env[name];
}
const files = (await readdir("tests"))
  .filter(name => /^(git-|full-state-|sealed-|protected-|snapshot-protected|migration-readiness).*\.test\.mjs$/.test(name))
  .sort().map(name => `tests/${name}`);
const child = spawn(process.execPath, ["--import", "tsx", "--test",
  "--test-concurrency=2", ...files], { env, stdio: "inherit" });
child.once("error", () => { process.exitCode = 1; });
child.once("exit", code => { process.exitCode = code ?? 1; });
process.once("SIGTERM", () => child.kill("SIGTERM"));
process.once("SIGINT", () => child.kill("SIGINT"));
