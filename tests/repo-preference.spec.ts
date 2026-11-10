import { test, expect, signInTestUser } from "./clerk-fixture";

/**
 * Verifies that the backfill repo picker preference is persisted server-side
 * (via /api/preferences) and survives clearing localStorage — i.e. the
 * server value, not the browser cache, drives the picker after a reload.
 *
 * Auth and API responses are mocked; the /api/preferences mock is stateful
 * within the test so a PATCH persists across the reload.
 */

const MOCK_USER = {
  id: "test-user-1",
  email: "test@example.com",
  firstName: "Test",
  lastName: "User",
  profileImageUrl: null,
};

const MOCK_REPOS = [
  { id: 1, userId: "test-user-1", githubId: 101, name: "alpha", fullName: "tester/alpha", url: "https://github.com/tester/alpha", defaultBranch: "main", description: null, lastSyncedAt: null, createdAt: new Date().toISOString() },
  { id: 2, userId: "test-user-1", githubId: 102, name: "bravo", fullName: "tester/bravo", url: "https://github.com/tester/bravo", defaultBranch: "main", description: null, lastSyncedAt: null, createdAt: new Date().toISOString() },
];

const MOCK_RECEIPTS = [
  {
    id: 1,
    userId: "test-user-1",
    fileName: "server.ts",
    filePath: "server/server.ts",
    fileHash: "abc123",
    modelProvider: "Anthropic",
    modelName: "claude-opus-4",
    countryOfOrigin: "US",
    complianceStatus: "verified",
    attestationType: "origin",
    parentAttestationId: null,
    auditVerdict: null,
    signature: "sig",
    publicKey: "pk",
    prevEntryHash: null,
    entryHash: "entryhash1",
    receiptVersion: "v1",
    signedAt: new Date().toISOString(),
    gitCommitUrl: null,
    gitCommitMessage: null,
    metadata: null,
    createdAt: new Date().toISOString(),
    repositoryId: null,
  },
];

test.describe("Repo preference — server-side persistence", () => {
  test("picker reflects server-side preference after localStorage is cleared and page reloaded", async ({ page }) => {
    // Stateful server-side preference store, shared across reloads.
    const prefs: { defaultRepoId: string | null; lastActiveTab: string | null } = {
      defaultRepoId: null,
      lastActiveTab: null,
    };

    // Suppress the onboarding walkthrough overlay on every page load.
    await page.addInitScript(() => {
      localStorage.setItem("forgeproof_onboarding_complete", "true");
    });

    await page.route("**/api/me", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_USER) })
    );
    await page.route("**/api/attestations", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_RECEIPTS) })
    );
    await page.route("**/api/repositories", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_REPOS) })
    );
    await page.route("**/api/api-keys", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
    );
    await page.route("**/api/organizations", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
    );
    await page.route("**/api/audit-logs*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
    );
    await page.route("**/api/github/status", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ configured: true, connected: true }) })
    );
    await page.route("**/api/notifications/preferences", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ notificationEmail: null, notifyOnGitFailure: true }) })
    );
    await page.route("**/api/subscription*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plan: "free", status: "active", attestationCount: 1, attestationLimit: 100 }) })
    );
    await page.route("**/api/preferences", async (route) => {
      const method = route.request().method();
      if (method === "PATCH") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        if ("defaultRepoId" in body) prefs.defaultRepoId = (body.defaultRepoId as string) || null;
        if ("lastActiveTab" in body) prefs.lastActiveTab = (body.lastActiveTab as string) || null;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(prefs) });
    });
    // Catch-all for any other API calls the dashboard makes.
    await page.route("**/api/**", (route) => {
      if (route.request().url().match(/\/api\/(me|attestations|repositories|api-keys|organizations|audit-logs|github\/status|notifications\/preferences|subscription|preferences)/)) {
        return route.fallback();
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await signInTestUser(page);
    await page.goto("/dashboard");

    const picker = page.getByTestId("select-backfill-repo");
    await expect(picker).toBeVisible({ timeout: 15000 });
    await expect(picker).toContainText("Default repository");

    // Select repo "bravo" (id 2) — this PATCHes the server-side preference.
    await picker.click();
    await page.getByRole("option", { name: "bravo" }).click();
    await expect(picker).toContainText("bravo");
    await expect.poll(() => prefs.defaultRepoId).toBe("2");

    // Clear localStorage so only the server-side value can restore the choice.
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    // The picker must reflect the server-side value, not localStorage.
    await expect(picker).toBeVisible({ timeout: 15000 });
    await expect(picker).toContainText("bravo");
    const stored = await page.evaluate(() => localStorage.getItem("forgeproof.backfillRepoId"));
    expect(stored).toBe("2");
  });
});
