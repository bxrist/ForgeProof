import { test, expect } from "@playwright/test";

const DEMO_API = "**/api/demo/attestations";

const MOCK_RECEIPT = [
  {
    id: 1,
    fileName: "server.ts",
    filePath: "server/server.ts",
    fileHash: "abc123def456",
    modelProvider: "Anthropic",
    modelName: "claude-opus-4",
    countryOfOrigin: "US",
    complianceStatus: "verified",
    createdAt: new Date().toISOString(),
    repoName: "forgeproof",
    branchName: "main",
    signature: "ed25519sig",
    signedAt: new Date().toISOString(),
    gitCommitUrl: null,
    commitMessage: null,
    previousHash: null,
    chainHash: "chain123",
    receiptVersion: "v1",
    repositoryId: null,
  },
];

test.describe("Demo page — error state and retry", () => {
  test("shows error UI when API returns 503 and retry button appears after auto-retries exhaust", async ({
    page,
  }) => {
    await page.route(DEMO_API, (route) => {
      route.fulfill({ status: 503, body: "Service Unavailable" });
    });

    await page.goto("/demo");

    await expect(page.getByTestId("demo-error-state")).toBeVisible({
      timeout: 10000,
    });

    await expect(page.getByTestId("button-demo-retry")).toBeVisible({
      timeout: 15000,
    });
  });

  test("retry button triggers a successful recovery when the API comes back", async ({
    page,
  }) => {
    let callCount = 0;

    await page.route(DEMO_API, async (route) => {
      callCount += 1;
      if (callCount <= 4) {
        await route.fulfill({ status: 503, body: "Service Unavailable" });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_RECEIPT),
        });
      }
    });

    await page.goto("/demo");

    await expect(page.getByTestId("button-demo-retry")).toBeVisible({
      timeout: 15000,
    });

    await page.getByTestId("button-demo-retry").click();

    await expect(page.getByTestId("demo-error-state")).not.toBeVisible({
      timeout: 15000,
    });

    await expect(
      page.getByTestId(`row-demo-attestation-${MOCK_RECEIPT[0].id}`)
    ).toBeVisible({ timeout: 10000 });
  });
});
