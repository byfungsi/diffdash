import { describe, expect, it } from "vitest"
import { appBrowserScenario } from "@/test/app-browser-support"

describe("Review virtualization budgets and navigation", () => {
  it("keeps continuous fast scrolling within the review rendering budget", async () => {
    expect.hasAssertions()
    await appBrowserScenario("fastScrollPerformance")()
  }, 30_000)

  it("removes stale trailing buffers after navigating across many wrapped files", async () => {
    expect.hasAssertions()
    await appBrowserScenario("wrappedFileBuffers")()
  }, 45_000)

  it("navigates to exact matches in virtualized lines", async () => {
    expect.hasAssertions()
    await appBrowserScenario("virtualizedSearch")()
  })

  it("converges on distant matches after wrapped lines change virtual heights", async () => {
    expect.hasAssertions()
    await appBrowserScenario("wrappedSearchConvergence")()
  })
})
