// Reconstruct existing evidence only. Never signs, submits receipts, or writes Git state.
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { load, parseSourceReference } from "../server/sourceManifest";

const reference = "github://bxrist/LifeOS/commit/a0da7e1ebb132171f6a673a0520b7ecca7cb90b0/lifeos-source-manifest.json";
const expected = "a4306dc82296ba73adb6d054906c82d38c4c0cab08c4b70cd2573c17415e3111";
const candidates = await load(parseSourceReference(reference)!);
const bytes = candidates.find(b => createHash("sha256").update(b).digest("hex") === expected);
if (!bytes) throw new Error("Reconstructed manifest does not match receipt #51; no artifact written");
const manifest = JSON.parse(bytes.toString("utf8"));
if (manifest.files.length !== 822) throw new Error("Unexpected inventory count");
await mkdir("server/evidence", { recursive: true });
await writeFile(`server/evidence/${expected}.json`, bytes, { mode: 0o600 });
console.log(JSON.stringify({ fileCount: manifest.files.length, manifestHash: expected, sourceCommit: manifest.commit }));
