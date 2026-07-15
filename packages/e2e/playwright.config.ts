import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "tests",
  outputDir: "test-results",
  timeout: 60_000,
  workers: 1,
  projects: [
    {
      name: "desktop",
      testMatch: "desktop/**/*.spec.ts",
    },
    {
      name: "packaged",
      testMatch: "packaged/**/*.spec.ts",
    },
  ],
  use: {
    trace: "retain-on-failure",
  },
})
