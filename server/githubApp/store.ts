import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ConflictError, type AppRecord, type Operation, type Replay } from "../git-store/store.mjs";
import type { GitStorage } from "../git-store/storage";
import { currentApplicationStorage } from "../storageBackend";

export class AppError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export type RecordRow = { id: string; category: string; ownerId: string | null; data: string; updatedAt: string };
export const unpack = (r?: AppRecord) => r ? JSON.parse(String(r.data)) : undefined;
export function record(id: string, category: string, ownerId: string | null, data: object): RecordRow {
  return { id, category, ownerId, data: JSON.stringify(data), updatedAt: new Date().toISOString() };
}
export class AppStore {
  constructor(readonly service: Pick<GitStorage["service"], "replay" | "append">) {}
  read() { return this.service.replay(); }
  async transact<T>(build: (state: Replay) => { rows: RecordRow[]; result: T }) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const state = await this.read();
      const { rows, result } = build(state);
      if (!rows.length) return result;
      const operations: Operation[] = rows.map(row => ({
        kind: "githubApp", id: row.id, action: "put",
        expectedVersion: state.versions[`githubApp/${row.id}`] ?? null, record: row,
      }));
      try {
        await this.service.append({ idempotencyKey: sha(`github-app:${randomUUID()}`), operations });
        return result;
      } catch (e) { if (!(e instanceof ConflictError) || attempt === 5) throw e; }
    }
    throw new Error("GitHub App transaction conflict");
  }
  async issue(ownerId: string, appId: number, stage: "install" | "authorize", installationId?: number) {
    const state = randomBytes(32).toString("hex");
    await this.transact(s => {
      if (!s.records.users[ownerId]) throw new AppError(403, "Account unavailable");
      return { rows: [record(`state-${sha(state)}`, "state", ownerId,
        { appId, stage, installationId: installationId ?? null, expiresAt: Date.now() + 600000, used: false })], result: undefined };
    });
    return state;
  }
  consume(value: string, ownerId: string, appId: number, stage: string) {
    if (!/^[a-f0-9]{64}$/.test(value)) throw new AppError(400, "Invalid or expired connection state");
    return this.transact(s => {
      const row = s.records.githubApp[`state-${sha(value)}`], data = unpack(row);
      if (!row || row.ownerId !== ownerId || data.appId !== appId || data.stage !== stage || data.used || data.expiresAt <= Date.now())
        throw new AppError(400, "Invalid or expired connection state");
      return { rows: [record(String(row.id), "state", ownerId, { ...data, used: true })], result: data };
    });
  }
}
export function appStore() {
  const storage = currentApplicationStorage() as GitStorage | undefined;
  if (!storage?.service) throw new AppError(503, "GitHub App integration requires the existing Git application store; no SQL migration is needed.");
  return new AppStore(storage.service);
}
