import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.mjs",
  outputDir: "./output/playwright/test-results",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "output/playwright/report", open: "never" }]],
  use: {
    launchOptions: {
      slowMo: Number(process.env.IHEAR_E2E_SLOWMO || 0),
      // Avoid fractional viewport widths at CSS breakpoints with Windows display scaling.
      args: process.platform === "win32" ? ["--force-device-scale-factor=1"] : [],
    },
    baseURL: `http://127.0.0.1:${process.env.IHEAR_E2E_PORT || "3210"}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
