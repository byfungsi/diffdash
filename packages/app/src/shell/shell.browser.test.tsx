import { describe, expect, it } from "vitest"
import { appBrowserScenario } from "@/test/app-browser-support"

describe("App shell browser interactions", () => {
  it("renders full-width workbench chrome and opens global navigation from its centered command field", async () => {
    expect.hasAssertions()
    await appBrowserScenario("workbenchTitlebar")()
  })

  it("shows a retryable error instead of onboarding when application state is unavailable", async () => {
    expect.hasAssertions()
    await appBrowserScenario("appStateRecovery")()
  })

  it("cancels or completes project opening through the accessible remote chooser", async () => {
    expect.hasAssertions()
    await appBrowserScenario("projectOpenChooser")()
  })

  it("browses, opens, rejects, and refreshes checkout files in the Code ribbon", async () => {
    expect.hasAssertions()
    await appBrowserScenario("codeRibbon")()
  })

  it("links a remote-only project from the Code ribbon and loads its checkout", async () => {
    expect.hasAssertions()
    await appBrowserScenario("codeRibbonLink")()
  })

  it("relinks a checkout that is no longer available", async () => {
    expect.hasAssertions()
    await appBrowserScenario("codeRibbonRelink")()
  })

  it("opens files and searches file contents from Code shortcuts", async () => {
    expect.hasAssertions()
    await appBrowserScenario("codeRibbonShortcuts")()
  })

  it("restores a selected review while keeping Reviews active", async () => {
    expect.hasAssertions()
    await appBrowserScenario("projectStateRestoration")()
  })

  it("keeps a user review selection made while workspace restoration is loading", async () => {
    expect.hasAssertions()
    await appBrowserScenario("projectRestoreRace")()
  })

  it("shows a clean working tree independently from an empty hosted review list", async () => {
    expect.hasAssertions()
    await appBrowserScenario("cleanProjectReviews")()
  })

  it("does not render an empty hosted state when the provider fails", async () => {
    expect.hasAssertions()
    await appBrowserScenario("failedProjectReviews")()
  })

  it("opens the complete macOS shortcut reference from Home and restores focus", async () => {
    expect.hasAssertions()
    await appBrowserScenario("shortcutReferenceHome")()
  })

  it("opens the Windows shortcut reference from an editable Review control", async () => {
    expect.hasAssertions()
    await appBrowserScenario("shortcutReferenceReview")()
  })

  it("toggles the project sidebar with Cmd+B from an editable control", async () => {
    expect.hasAssertions()
    await appBrowserScenario("toggleSidebarShortcut")()
  })

  it("opens the macOS shortcut reference from the Home titlebar and restores focus", async () => {
    expect.hasAssertions()
    await appBrowserScenario("shortcutReferenceTitlebarHome")()
  })

  it("opens the Windows shortcut reference from the Review titlebar and restores focus", async () => {
    expect.hasAssertions()
    await appBrowserScenario("shortcutReferenceTitlebarReview")()
  })

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

  it("does not misroute a repository comparison before its source layer is available", async () => {
    expect.hasAssertions()
    await appBrowserScenario("cliRepositoryComparison")()
  })
})
