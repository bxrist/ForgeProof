import { afterEach, describe, expect, it, vi } from "vitest";

const validApproval = {
  service: "lifeos",
  userId: "lifeos-service-0a",
  apiKeyId: 17,
  apiKeyHash: "a".repeat(64),
  dedicated: true,
  approvedBySubject: "existing-owner-1",
  approvedAt: "2026-11-04T12:00:00Z",
  approvalReference: "owner-ticket-17",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("LifeOS approval", () => {
  it.each(["57", "invalid"])("never loads legacy approval when Git selector %s is supplied", async selector => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LIFEOS_OWNER_APPROVAL_AUDIT_ID", selector);
    vi.stubEnv("LIFEOS_OWNER_APPROVAL_JSON", JSON.stringify(validApproval));
    vi.stubEnv("LIFEOS_OWNER_APPROVAL_FILE", "/obsolete/unreadable-approval.json");
    const { lifeosApproval } = await import("../server/lifeosApproval");
    expect(lifeosApproval).toBeNull();
  });
  it("accepts only a valid, separately owner-approved record", async () => {
    const { validateLifeosApproval } = await import("../server/lifeosApproval");
    expect(validateLifeosApproval(validApproval, Date.parse("2026-11-05T00:00:00Z"))).toMatchObject(validApproval);
  });

  it.each([
    ["null", null],
    ["wrong fixed subject", { ...validApproval, userId: "other" }],
    ["future timestamp", { ...validApproval, approvedAt: "2026-11-06T00:00:00Z" }],
    ["malformed key hash", { ...validApproval, apiKeyHash: "not-a-hash" }],
    ["self approval", { ...validApproval, approvedBySubject: "lifeos-service-0a" }],
  ])("rejects %s", async (_label, value) => {
    const { validateLifeosApproval } = await import("../server/lifeosApproval");
    expect(validateLifeosApproval(value, Date.parse("2026-11-05T00:00:00Z"))).toBeNull();
  });

  it("rejects environment activation outside production and dual settings", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LIFEOS_OWNER_APPROVAL_JSON", JSON.stringify(validApproval));
    expect((await import("../server/lifeosApproval")).lifeosApproval).toBeNull();
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LIFEOS_OWNER_APPROVAL_FILE", "/tmp/approval.json");
    expect((await import("../server/lifeosApproval")).lifeosApproval).toBeNull();
  });
  it("accepts explicit project scope without breaking legacy origin approval", async () => {
    const { validateLifeosApproval } = await import("../server/lifeosApproval");
    expect(validateLifeosApproval(validApproval)).not.toBeNull();
    expect(validateLifeosApproval({ ...validApproval, projects: ["owner/lifeos", "owner/another-project"] })?.projects)
      .toEqual(["owner/lifeos", "owner/another-project"]);
    for (const projects of [[], ["*"], ["../project"], ["owner/repo", "owner/repo"], "owner/repo"])
      expect(validateLifeosApproval({ ...validApproval, projects })).toBeNull();
  });
});
