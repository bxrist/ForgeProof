import { test, expect, signInTestUser } from "./clerk-fixture";

/**
 * Verifies that the dashboard remembers the last-active tab through the
 * server-side /api/preferences endpoint (lastActiveTab): switching tabs
 * PATCHes the preference, and a reload restores the tab from the GET
 * response — not from any browser-local state.
 */

const MOCK_USER = {
  id: "test-user-1",
  email: "test@example.com",
  firstName: "Test",
  lastName: "User",
  profileImageUrl: null,
};

test.describe("Dashboard — last-active tab persistence", () => {
  test("switching tabs saves the preference and a reload restores it from the server", async ({ page }) => {
    // Stateful server-side preference store shared across reloads.
    const prefs: { defaultRepoId: string | null; lastActiveTab: string | null } = {
      defaultRepoId: null,
      lastActiveTab: null,
    };
    const patchedTabs: string[] = [];

    await page.addInitScript(() => {
      localStorage.setItem("forgeproof_onboarding_complete", "true");
    });

    await page.route("**/api/me", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_USER) })
    );
    await page.route("**/api/preferences", async (route) => {
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        if ("defaultRepoId" in body) prefs.defaultRepoId = (body.defaultRepoId as string) || null;
        if ("lastActiveTab" in body) {
          prefs.lastActiveTab = (body.lastActiveTab as string) || null;
          if (typeof body.lastActiveTab === "string") patchedTabs.push(body.lastActiveTab);
        }
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(prefs) });
    });
    // Everything else the dashboard fetches gets an empty-but-valid response.
    await page.route("**/api/**", (route) => {
      const url = route.request().url();
      if (url.includes("/api/me") || url.match(/\/api\/preferences(\?|$)/)) return route.fallback();
      const isList = /\/api\/(attestations|repositories|api-keys|organizations|audit-logs)/.test(url);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: isList ? "[]" : "{}",
      });
    });

    await signInTestUser(page);
    await page.goto("/dashboard");

    // Defaults to Attestations when no server preference exists.
    await expect(page.getByTestId("tab-attestations")).toHaveAttribute("data-state", "active", { timeout: 15000 });

    // Switch to the Activity Log tab — this must PATCH the server preference.
    await page.getByTestId("tab-activity-log").click();
    await expect(page.getByTestId("tab-activity-log")).toHaveAttribute("data-state", "active");
    await expect.poll(() => prefs.lastActiveTab).toBe("activity-log");
    expect(patchedTabs).toContain("activity-log");

    // Clear browser-local state and reload: the server value must restore the tab.
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    await expect(page.getByTestId("tab-activity-log")).toHaveAttribute("data-state", "active", { timeout: 15000 });
    await expect(page.getByTestId("tab-attestations")).toHaveAttribute("data-state", "inactive");
  });
});
