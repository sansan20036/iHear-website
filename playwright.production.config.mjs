import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/production",
  testMatch: "**/*.production.mjs",
  outputDir: "./output/playwright-production/test-results",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["html", { outputFolder: "output/playwright-production/report", open: "never" }]],
  use: {
    baseURL: "https://www.ihearus.org",
    browserName: "chromium",
    storageState: { cookies: [], origins: [] },
    serviceWorkers: "block",
    locale: "en-US",
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      slowMo: Number(process.env.IHEAR_E2E_SLOWMO || 0),
      args: process.platform === "win32" ? ["--force-device-scale-factor=1"] : [],
    },
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "mobile-390", use: { viewport: { width: 390, height: 844 } } },
    { name: "mobile-320", use: { viewport: { width: 320, height: 720 } } },
  ],
});
