import { test, expect, signInTestUser } from "./clerk-fixture";

/**
 * Verifies the detail-page repo picker reconciliation logic:
 *
 * (a) A stale/deleted server repo ID falls back gracefully to "Default
 *     repository" and the server preference is cleared.
 *
 * (b) Repositories arriving before preferences (repos win the request race)
 *     does not clobber the server preference — the server value is applied
 *     once preferences load.
 */

const MOCK_USER = {
  id: "test-user-1",
  email: "test@example.com",
  firstName: "Test",
  lastName: "User",
  profileImageUrl: null,
};

// Two live repos — id 1 and 2.  Repo id 3 has been deleted.
const MOCK_REPOS = [
  {
    id: 1,
    userId: "test-user-1",
    githubId: 101,
    name: "alpha",
    fullName: "tester/alpha",
    url: "https://github.com/tester/alpha",
    defaultBranch: "main",
    description: null,
    lastSyncedAt: null,
    createdAt: new Date().toISOString(),
  },
  {
    id: 2,
    userId: "test-user-1",
    githubId: 102,
    name: "bravo",
    fullName: "tester/bravo",
    url: "https://github.com/tester/bravo",
    defaultBranch: "main",
    description: null,
    lastSyncedAt: null,
    createdAt: new Date().toISOString(),
  },
];

const MOCK_RECEIPT = {
  id: 42,
  userId: "test-user-1",
  fileName: "agent.ts",
  filePath: "src/agent.ts",
  fileHash: "deadbeef",
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
  entryHash: "entryhash42",
  receiptVersion: "v1",
  signedAt: new Date().toISOString(),
  gitCommitUrl: null,
  gitCommitMessage: null,
  metadata: null,
  createdAt: new Date().toISOString(),
  repositoryId: null,
  childAttestations: [],
};

/** Register all standard mocks except /api/preferences, which callers provide. */
async function setupCommonMocks(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    localStorage.setItem("forgeproof_onboarding_complete", "true");
  });

  await page.route("**/api/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_USER),
    })
  );
  await page.route("**/api/attestations/42", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_RECEIPT),
    })
  );
  await page.route("**/api/github/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ configured: true, connected: true }),
    })
  );
  await page.route("**/api/repositories", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_REPOS),
    })
  );
  await page.route("**/api/notifications/preferences", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ notificationEmail: null, notifyOnGitFailure: true }),
    })
  );
  await page.route("**/api/subscription*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ plan: "free", status: "active", attestationCount: 1, attestationLimit: 100 }),
    })
  );
  // Catch-all for any remaining API calls
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    if (
      url.match(
        /\/api\/(me|attestations\/42|github\/status|repositories|notifications\/preferences|subscription|preferences)/
      )
    ) {
      return route.fallback();
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
}

test.describe("Detail-page repo preference — race & reconciliation", () => {
  test("(a) stale server repo ID falls back to default and clears server preference", async ({ page }) => {
    // Server reports detailRepoId = "3" but repo 3 no longer exists in the repo list.
    const prefs: { detailRepoId: string | null } = { detailRepoId: "3" };
    const patchedValues: Array<string | null> = [];

    await setupCommonMocks(page);

    await page.route("**/api/preferences", async (route) => {
      const method = route.request().method();
      if (method === "PATCH") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        if ("detailRepoId" in body) {
          prefs.detailRepoId = (body.detailRepoId as string) || null;
          patchedValues.push(prefs.detailRepoId);
        }
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          defaultRepoId: null,
          detailRepoId: prefs.detailRepoId,
          lastActiveTab: null,
        }),
      });
    });

    await signInTestUser(page);
    await page.goto("/attestation/42");

    // The repo picker should be visible (receipt not yet committed, user owns it).
    const picker = page.getByTestId("select-commit-repo");
    await expect(picker).toBeVisible({ timeout: 15000 });

    // Because repo 3 is missing the picker should fall back to "Default repository".
    await expect(picker).toContainText("Default repository");

    // The server preference must have been cleared (PATCH with null).
    await expect.poll(() => patchedValues).toContain(null);
    expect(prefs.detailRepoId).toBeNull();

    // localStorage must also be cleared.
    const stored = await page.evaluate(() =>
      localStorage.getItem("forgeproof.detailRepoId")
    );
    expect(stored).toBeNull();
  });

  test("(b) repos arriving before preferences does not clobber the server preference", async ({ page }) => {
    // Start with stale localStorage value "99" (non-existent) and a server
    // preference of "2" (repo bravo, which is valid).
    // Repos respond instantly; preferences are deliberately delayed.
    // The stale localStorage value must NOT trigger a PATCH before prefs load.

    await page.addInitScript(() => {
      // Override the init script order: onboarding done + stale localStorage value.
      localStorage.setItem("forgeproof_onboarding_complete", "true");
      localStorage.setItem("forgeproof.detailRepoId", "99");
    });

    const prefs: { detailRepoId: string | null } = { detailRepoId: "2" };
    const patchedValues: Array<string | null> = [];
    let prefsRequestCount = 0;

    await page.route("**/api/me", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_USER),
      })
    );
    await page.route("**/api/attestations/42", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_RECEIPT),
      })
    );
    await page.route("**/api/github/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ configured: true, connected: true }),
      })
    );
    await page.route("**/api/repositories", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_REPOS),
      })
    );
    await page.route("**/api/notifications/preferences", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ notificationEmail: null, notifyOnGitFailure: true }),
      })
    );
    await page.route("**/api/subscription*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ plan: "free", status: "active", attestationCount: 1, attestationLimit: 100 }),
      })
    );

    await page.route("**/api/preferences", async (route) => {
      const method = route.request().method();
      prefsRequestCount++;
      if (method === "PATCH") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        if ("detailRepoId" in body) {
          prefs.detailRepoId = (body.detailRepoId as string) || null;
          patchedValues.push(prefs.detailRepoId);
        }
      }
      // Delay the preferences response to simulate repos winning the race.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          defaultRepoId: null,
          detailRepoId: prefs.detailRepoId,
          lastActiveTab: null,
        }),
      });
    });

    await page.route("**/api/**", (route) => {
      const url = route.request().url();
      if (
        url.match(
          /\/api\/(me|attestations\/42|github\/status|repositories|notifications\/preferences|subscription|preferences)/
        )
      ) {
        return route.fallback();
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await signInTestUser(page);
    await page.goto("/attestation/42");

    const picker = page.getByTestId("select-commit-repo");
    await expect(picker).toBeVisible({ timeout: 15000 });

    // After prefs load, the picker should show "bravo" (server value id=2).
    await expect(picker).toContainText("bravo", { timeout: 5000 });

    // The server preference must NOT have been cleared by the stale localStorage value.
    // patchedValues should be empty (no PATCH sent before or during reconciliation)
    // or — if the stale value triggered anything — it must not be null.
    const wronglyClearedBeforePrefs = patchedValues.some((v) => v === null);
    expect(wronglyClearedBeforePrefs).toBe(false);

    // localStorage must now reflect the server value.
    const stored = await page.evaluate(() =>
      localStorage.getItem("forgeproof.detailRepoId")
    );
    expect(stored).toBe("2");
  });
});
