import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  auth: {} as any, select: vi.fn(), insert: vi.fn(), row: { id: "legacy-subject" } as any,
}));
vi.mock("@clerk/express", () => ({ getAuth: () => state.auth }));
vi.mock("../server/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: (predicate: any) => {
      state.select(predicate);
      return { limit: async () => state.row ? [state.row] : [] };
    } }) }),
    insert: () => ({ values: (values: any) => {
      state.insert(values);
      return { onConflictDoNothing: () => ({ returning: async () => {
        state.row = { ...values, githubToken: null };
        return [state.row];
      } }) };
    } }),
  },
}));

import { requireAuth, optionalAuth, sessionUserId } from "../server/middlewares/requireAuth";
import { DatabaseStorage } from "../server/legacySqlStorage";
import { installApplicationStorage } from "../server/storageBackend";
const legacy = new DatabaseStorage();
installApplicationStorage(() => legacy, "postgres");

describe("Clerk local user bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.auth = { userId: "user_native", sessionClaims: { userId: "legacy-subject", email: "identity@example.com" } };
    state.row = { id: "legacy-subject", githubToken: "existing-app-state" };
  });

  it("keeps a migrated account and its app state under the legacy subject", async () => {
    const req = {} as any;
    const next = vi.fn();
    await requireAuth(req, {} as any, next);
    expect(sessionUserId(req)).toBe("legacy-subject");
    expect(req.dbUser).toEqual(state.row);
    expect(state.insert).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it("provisions only the ID for a new user, without syncing nullable identity fields", async () => {
    state.auth = { userId: "user_new", sessionClaims: { userId: "user_new", email: "identity@example.com" } };
    state.row = null;
    const req = {} as any;
    await requireAuth(req, {} as any, vi.fn());
    expect(state.insert).toHaveBeenCalledWith({ id: "user_new" });
    expect(req.dbUser.id).toBe("user_new");
  });

  it("rejects a signed-out request even if stale claims are present", async () => {
    state.auth.userId = null;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    await requireAuth({} as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(state.select).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("uses the native ID only when no external subject claim exists", () => {
    state.auth.sessionClaims = {};
    expect(sessionUserId({} as any)).toBe("user_native");
  });

  it("provisions a browser's first mixed API write, but leaves signed-out API clients alone", async () => {
    state.row = null;
    const req = {} as any;
    const next = vi.fn();
    await optionalAuth(req, {} as any, next);
    expect(req.dbUser.id).toBe("legacy-subject");
    state.auth.userId = null;
    vi.clearAllMocks();
    await optionalAuth({} as any, {} as any, next);
    expect(state.select).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });
});
