import { describe, expect, it } from "vitest"
import { appBrowserScenario } from "@/test/app-browser-support"

describe("App onboarding browser interactions", () => {
  it("shows first-run onboarding and lets the user continue", async () => {
    expect.hasAssertions()
    await appBrowserScenario("firstRunOnboarding")()
  })

  it("shows the shell command when the CLI directory is not in PATH", async () => {
    expect.hasAssertions()
    await appBrowserScenario("cliPathSetup")()
  })

  it("persists an onboarding telemetry opt-out without sending events", async () => {
    expect.hasAssertions()
    await appBrowserScenario("onboardingTelemetryOptOut")()
  })

  it("shows a Home banner while setup requirements are missing", async () => {
    expect.hasAssertions()
    await appBrowserScenario("missingSetupHomeBanner")()
  })

  it("shows an actionable error for an unsupported GitHub CLI version", async () => {
    expect.hasAssertions()
    await appBrowserScenario("unsupportedGitHubCli")()
  })
})
