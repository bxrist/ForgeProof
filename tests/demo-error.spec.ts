import { test, expect } from "@playwright/test";

// The retired DB-backed demo retried /api/demo/attestations and showed an
// offline banner. The isolated fixture demo must instead remain usable without
// that endpoint, with no production receipt reads or writes.
test.describe("Isolated demo — API independence and offline behavior", () => {
  const origin = "row-demo-attestation-illustration-origin";
  let receiptCalls: string[];
  test.beforeEach(async ({ page }) => {
    receiptCalls = [];
    await page.route(/\/api\/(?:demo|attestations|attest|receipt|verify)(?:\/|\?|$)/, route => {
      receiptCalls.push(`${route.request().method()} ${route.request().url()}`);
      return route.fulfill({ status: 503, body: "Production evidence unavailable" });
    });
  });
  test.afterEach(() => expect(receiptCalls).toEqual([]));

  test("shows all three clearly labeled fixtures with production APIs unavailable", async ({ page }) => {
    await page.goto("/demo");
    await expect(page.getByText("Isolated illustration · local fixtures only")).toBeVisible();
    await expect(page.locator('[data-testid^="row-demo-attestation-"]')).toHaveCount(3);
    for (const id of ["origin", "review", "refactor"]) {
      const row = page.getByTestId(`row-demo-attestation-illustration-${id}`);
      await expect(row).toContainText("Draft example");
      await expect(row).toContainText("origin UNKNOWN");
    }
  });

  test("completes signing, comparison and archive simulations without backend retries", async ({ page }) => {
    await page.goto("/demo");
    const row = page.getByTestId(origin);
    await row.getByRole("button", { name: "Simulate signing", exact: true }).click();
    await expect(row).toContainText("Signature simulated");
    await row.getByRole("button", { name: "Simulate comparison", exact: true }).click();
    await expect(row).toContainText("Simulated match");
    await row.getByRole("button", { name: "Simulate archive", exact: true }).click();
    await expect(row).toContainText("Archive simulated");
    await expect(row.getByRole("button", { name: "Illustration complete" })).toBeDisabled();
  });

  test("reset restores local drafts without creating or deleting real receipts", async ({ page }) => {
    await page.goto("/demo");
    await page.getByTestId(origin).getByRole("button", { name: "Simulate signing", exact: true }).click();
    await page.getByRole("button", { name: "Reset illustration" }).click();
    await expect(page.locator('[data-testid^="row-demo-attestation-"]')).toHaveCount(3);
    for (const id of ["origin", "review", "refactor"]) {
      await expect(page.getByTestId(`row-demo-attestation-illustration-${id}`)).toContainText("Draft example");
    }
    await page.reload();
    await expect(page.getByTestId(origin)).toContainText("Draft example");
  });

  test("local lifecycle and search remain interactive after going offline", async ({ page, context }) => {
    await page.goto("/demo");
    await expect(page.getByTestId(origin)).toBeVisible();
    await context.setOffline(true);
    try {
      await page.getByTestId(origin).getByRole("button", { name: "Simulate signing", exact: true }).click();
      await expect(page.getByTestId(origin)).toContainText("Signature simulated");
      await page.getByTestId("input-search").fill("nonexistent-example");
      await expect(page.getByText("No matching examples")).toBeVisible();
      await page.getByRole("button", { name: "Clear filters" }).click();
      await expect(page.getByTestId(origin)).toContainText("Signature simulated");
    } finally { await context.setOffline(false); }
  });

  test("reconnecting preserves local progress without refetching production evidence", async ({ page, context }) => {
    await page.goto("/demo");
    await expect(page.getByTestId(origin)).toBeVisible();
    await context.setOffline(true);
    try {
      await page.getByTestId(origin).getByRole("button", { name: "Simulate signing", exact: true }).click();
      await expect(page.getByTestId(origin)).toContainText("Signature simulated");
    } finally { await context.setOffline(false); }
    await page.reload();
    await expect(page.getByTestId(origin)).toContainText("Signature simulated");
    await page.getByTestId(origin).getByRole("button", { name: "Simulate comparison", exact: true }).click();
    await expect(page.getByTestId(origin)).toContainText("Simulated match");
  });
});
