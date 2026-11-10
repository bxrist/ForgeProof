import { test, expect } from "@playwright/test";

test("public illustration is interactive and never reads or writes receipts", async ({ page }) => {
  const evidenceRequests: string[] = [];
  page.on("request", req => {
    if (/\/api\/(demo|attestations|v1\/attest|verify|receipt)/.test(req.url())) evidenceRequests.push(req.url());
  });
  await page.goto("/demo");
  await expect(page.getByText("Isolated illustration · local fixtures only")).toBeVisible();
  await page.getByRole("button", { name: "Simulate signing" }).first().click();
  await page.getByRole("link", { name: /request-policy.ts · origin/ }).click();
  await page.locator("textarea").fill("Changed after capture");
  await page.getByRole("button", { name: "Simulate comparison" }).click();
  await expect(page.getByText(/Simulated mismatch: text changed/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Simulate archive" })).toBeDisabled();
  await page.getByRole("button", { name: "Reset all examples" }).click();
  await page.getByRole("button", { name: "Simulate signing" }).click();
  await page.getByRole("button", { name: "Simulate comparison" }).click();
  await page.getByRole("button", { name: "Simulate archive" }).click();
  await expect(page.getByRole("button", { name: "Illustration complete" })).toBeDisabled();
  await page.getByRole("link", { name: "Open child review declaration" }).click();
  await expect(page.getByRole("link", { name: "Open parent declaration" })).toBeVisible();
  expect(evidenceRequests).toEqual([]);
});
