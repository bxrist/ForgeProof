import { defineConfig, devices } from "@playwright/test";
import { spawnSync } from "node:child_process";

// Nix's packaged browser includes its runtime libraries. Other environments
// can use Playwright's downloaded browser or an explicitly selected binary.
const systemChromium = spawnSync("which", ["chromium"], { encoding: "utf8" });
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  (systemChromium.status === 0 ? systemChromium.stdout.trim() : undefined);

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  outputDir: "./generated-artifacts/playwright-results",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
  use: {
    launchOptions: { executablePath },
    baseURL: "http://localhost:5000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
