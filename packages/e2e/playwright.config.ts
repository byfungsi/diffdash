import { defineConfig } from "@playwright/test"

// Forced-host matrix scripts override this default to qualify Bun independently.
process.env.DIFFDASH_E2E_CORE_HOST ??= "utility"

export default defineConfig({
  testDir: "tests",
  outputDir: "test-results",
  timeout: 60_000,
  maxFailures: process.env.CI ? 1 : 0,
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
