import { describe, expect, it } from "vitest"
import { appBrowserScenario } from "@/test/app-browser-support"

describe("App settings browser interactions", () => {
  it("applies independent JSON app and code themes without rendering a selector", async () => {
    expect.hasAssertions()
    await appBrowserScenario("appearance")()
  })

  it("persists explicit diff layouts and resolves Auto from the available width", async () => {
    expect.hasAssertions()
    await appBrowserScenario("diffViewSettings")()
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
