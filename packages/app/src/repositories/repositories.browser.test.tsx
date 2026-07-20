import { describe, expect, it } from "vitest"
import { appBrowserScenario } from "@/test/app-browser-support"

describe("App repositories browser interactions", () => {
  it("debounces remote repository search and sends the displayed owner set", async () => {
    expect.hasAssertions()
    await appBrowserScenario("remoteRepositorySearch")()
  })

  it("shows GitHub search failures instead of an empty result", async () => {
    expect.hasAssertions()
    await appBrowserScenario("repositorySearchFailure")()
  })

  it("does not render or query stale local-provider favorites", async () => {
    expect.hasAssertions()
    await appBrowserScenario("staleLocalFavorites")()
  })

  it("handles a repository link requested by the diffdash install command", async () => {
    expect.hasAssertions()
    await appBrowserScenario("cliLinkRepository")()
  })

  it("opens a repository PR list from the CLI command", async () => {
    expect.hasAssertions()
    await appBrowserScenario("cliRepositoryPullRequests")()
  })

  it("invalidates each repository mutation dependency once", async () => {
    expect.hasAssertions()
    await appBrowserScenario("repositoryInvalidation")()
  })
})
