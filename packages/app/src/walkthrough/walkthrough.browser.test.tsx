import { describe, expect, it } from "vitest"
import { appBrowserScenario } from "@/test/app-browser-support"

describe("App walkthrough browser interactions", () => {
  it("disables the walkthrough tab when no coding agent is installed", async () => {
    expect.hasAssertions()
    await appBrowserScenario("walkthroughNoAgent")()
  })

  it("preserves an unavailable explicit provider route and shows its probe reason", async () => {
    expect.hasAssertions()
    await appBrowserScenario("unavailableProviderRoute")()
  })

  it("enables an explicitly selected provider outside automatic routing", async () => {
    expect.hasAssertions()
    await appBrowserScenario("explicitProviderRouting")()
  })

  it("explains sampled coverage for unusually large walkthroughs", async () => {
    expect.hasAssertions()
    await appBrowserScenario("sampledWalkthrough")()
  })
})
