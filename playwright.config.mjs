import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.mjs",
  outputDir: "./output/playwright/test-results",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "output/playwright/report", open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${process.env.IHEAR_E2E_PORT || "3210"}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
