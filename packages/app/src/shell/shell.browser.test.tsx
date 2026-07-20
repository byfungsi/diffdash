import { describe, expect, it } from "vitest"
import { appBrowserScenario } from "@/test/app-browser-support"

describe("App shell browser interactions", () => {
  it("asks before downloading an update and restarts only after it is ready", async () => {
    expect.hasAssertions()
    await appBrowserScenario("updateDownloadRestart")()
  })

  it("uses a generic title for failures outside the update check", async () => {
    expect.hasAssertions()
    await appBrowserScenario("updateFailureTitle")()
  })

  it("opens a numbered PR from the CLI command", async () => {
    expect.hasAssertions()
    await appBrowserScenario("cliNumberedPullRequest")()
  })

  it("shows the actionable repository reason for a failed PR CLI command", async () => {
    expect.hasAssertions()
    await appBrowserScenario("cliPullRequestFailure")()
  })

  it("opens a fetched branch comparison from the diff CLI command", async () => {
    expect.hasAssertions()
    await appBrowserScenario("cliBranchComparison")()
  })

  it("shows a clear error when a CLI comparison branch has no common ancestor", async () => {
    expect.hasAssertions()
    await appBrowserScenario("cliBranchNoAncestor")()
  })
})
