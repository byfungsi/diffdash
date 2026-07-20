import { describe, expect, it } from "vitest"
import { appBrowserScenario } from "@/test/app-browser-support"

describe("App settings browser interactions", () => {
  it("applies the configured appearance without rendering a theme selector", async () => {
    expect.hasAssertions()
    await appBrowserScenario("appearance")()
  })

  it("agent settings and review action menus support keyboard dismissal and focus return", async () => {
    expect.hasAssertions()
    await appBrowserScenario("agentMenusKeyboard")()
  })

  it("restores confirmed walkthrough settings when persistence fails", async () => {
    expect.hasAssertions()
    await appBrowserScenario("walkthroughSettingsPersistence")()
  })

  it("keeps the newest optimistic settings while older persistence settles", async () => {
    expect.hasAssertions()
    await appBrowserScenario("rapidSettingsOrdering")()
  })
})
