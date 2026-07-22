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
  test("auto-recovers when DB comes back after two 503s: retrying indicator shown then data appears", async ({
    page,
  }) => {
    let callCount = 0;

    await page.route(DEMO_API, async (route) => {
      callCount += 1;
      if (callCount <= 2) {
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

    await expect(page.getByTestId("demo-error-state")).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByTestId("demo-retrying-indicator")).toBeVisible({
      timeout: 5000,
    });

    await expect(page.getByTestId("demo-error-state")).not.toBeVisible({
      timeout: 15000,
    });

    await expect(
      page.getByTestId(`row-demo-attestation-${MOCK_RECEIPT[0].id}`)
    ).toBeVisible({ timeout: 10000 });
  });

  test("shows retrying indicator during auto-retries and manual Try Again button only after 3 failures", async ({
    page,
  }) => {
    await page.route(DEMO_API, (route) => {
      route.fulfill({ status: 503, body: "Service Unavailable" });
    });

    await page.goto("/demo");

    await expect(page.getByTestId("demo-error-state")).toBeVisible({
      timeout: 10000,
    });

    await expect(page.getByTestId("demo-retrying-indicator")).toBeVisible({
      timeout: 5000,
    });

    await expect(page.getByTestId("button-demo-retry")).not.toBeVisible();

    await expect(page.getByTestId("button-demo-retry")).toBeVisible({
      timeout: 15000,
    });

    await expect(page.getByTestId("demo-retrying-indicator")).not.toBeVisible();
  });

  test("manual Try Again button triggers successful recovery after auto-retries are exhausted", async ({
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

test.describe("Demo page — offline banner", () => {
  test("shows offline banner when connection drops and hides it when dismissed", async ({
    page,
    context,
  }) => {
    await page.route(DEMO_API, (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_RECEIPT),
      });
    });

    await page.goto("/demo");

    await expect(
      page.getByTestId(`row-demo-attestation-${MOCK_RECEIPT[0].id}`)
    ).toBeVisible({ timeout: 10000 });

    await expect(page.getByTestId("banner-offline")).not.toBeVisible();

    await context.setOffline(true);

    await expect(page.getByTestId("banner-offline")).toBeVisible({
      timeout: 5000,
    });

    await expect(page.getByTestId("banner-offline")).toContainText("offline");

    await expect(
      page.getByTestId("button-dismiss-offline-banner")
    ).toBeVisible();

    await page.getByTestId("button-dismiss-offline-banner").click();

    await expect(page.getByTestId("banner-offline")).not.toBeVisible();
  });

  test("auto-refetches and recovers data when connection returns", async ({
    page,
    context,
  }) => {
    await page.route(DEMO_API, (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_RECEIPT),
      });
    });

    await page.goto("/demo");

    await expect(
      page.getByTestId(`row-demo-attestation-${MOCK_RECEIPT[0].id}`)
    ).toBeVisible({ timeout: 10000 });

    await context.setOffline(true);

    await expect(page.getByTestId("banner-offline")).toBeVisible({
      timeout: 5000,
    });

    await context.setOffline(false);

    await expect(page.getByTestId("banner-offline")).not.toBeVisible({
      timeout: 5000,
    });

    await expect(
      page.getByTestId(`row-demo-attestation-${MOCK_RECEIPT[0].id}`)
    ).toBeVisible({ timeout: 10000 });
  });
});
