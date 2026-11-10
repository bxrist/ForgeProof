import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const capture = vi.hoisted(() => ({ where: vi.fn() }));
vi.mock("../server/db", () => ({
  db: { select: () => ({ from: () => ({
    where: (predicate: unknown) => {
      capture.where(predicate);
      return { orderBy: async () => [] };
    },
  }) }) },
  pool: {},
}));
import { DatabaseStorage } from "../server/legacySqlStorage";

describe("Parent-child storage boundary", () => {
  for (const owner of ["user-alice", "forgeproof-system"]) {
    it(`requires both parent ID and exact owner ${owner} in SQL`, async () => {
      await new DatabaseStorage().getAttestationsByParentId(42, owner);
      const query = new PgDialect().sqlToQuery(capture.where.mock.lastCall![0]);
      expect(query.sql).toMatch(/parent_attestation_id.*=.*and.*user_id.*=/);
      expect(query.params).toEqual([42, owner]);
    });
  }
});
