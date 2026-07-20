import { describe, expect, it } from "vitest"
import { appBrowserScenario } from "@/test/app-browser-support"

describe("App review browser interactions", () => {
  it("shows, closes, and links the sticky unlinked-repository banner", async () => {
    expect.hasAssertions()
    await appBrowserScenario("linkRepositoryBanner")()
  })

  it("dismisses an unlinked-repository banner without invoking the folder picker", async () => {
    expect.hasAssertions()
    await appBrowserScenario("dismissRepositoryBanner")()
  })

  it("keeps a file-tree selection stable while the diff pane scrolls", async () => {
    expect.hasAssertions()
    await appBrowserScenario("fileTreeSelection")()
  })

  it("loads bounded snapshot pages incrementally and fetches selected files on demand", async () => {
    expect.hasAssertions()
    await appBrowserScenario("incrementalSnapshotPages")()
  })

  it("reacquires the manifest and retries when a snapshot page expires", async () => {
    expect.hasAssertions()
    await appBrowserScenario("snapshotExpiryReload")()
  })

  it("keeps large diffs in memory while virtualizing their rendered lines", async () => {
    expect.hasAssertions()
    await appBrowserScenario("largeDiffVirtualization")()
  })

  it("removes stale trailing buffers after navigating across many wrapped files", async () => {
    expect.hasAssertions()
    await appBrowserScenario("wrappedFileBuffers")()
  })

  it("finds and highlights exact case-insensitive substrings across diff lines", async () => {
    expect.hasAssertions()
    await appBrowserScenario("diffSearchSubstrings")()
  })

  it("temporarily reveals hidden, filtered, and viewed files for search results", async () => {
    expect.hasAssertions()
    await appBrowserScenario("diffSearchVisibility")()
  })

  it("navigates to exact matches in virtualized lines", async () => {
    expect.hasAssertions()
    await appBrowserScenario("virtualizedSearch")()
  })

  it("converges on distant matches after wrapped lines change virtual heights", async () => {
    expect.hasAssertions()
    await appBrowserScenario("wrappedSearchConvergence")()
  })

  it("renders very large files without whole-file syntax highlighting", async () => {
    expect.hasAssertions()
    await appBrowserScenario("veryLargePlainDiff")()
  })

  it("keeps the current viewport anchored when a tall diff is marked viewed", async () => {
    expect.hasAssertions()
    await appBrowserScenario("viewedViewportAnchor")()
  })

  it("clamps to the closest viewport when all tall diffs are marked viewed", async () => {
    expect.hasAssertions()
    await appBrowserScenario("markAllViewedViewport")()
  })

  it("retains viewed files across pushes until their displayed patch changes", async () => {
    expect.hasAssertions()
    await appBrowserScenario("viewedAcrossPushes")()
  })

  it("rolls back viewed and expansion state when persistence rejects", async () => {
    expect.hasAssertions()
    await appBrowserScenario("viewedPersistenceRollback")()
  })

  it("opens local review navigation with walkthrough and no approve action", async () => {
    expect.hasAssertions()
    await appBrowserScenario("localReview")()
  })

  it("FUN-130 AC: uses provider terminology and hides unsupported review decisions", async () => {
    expect.hasAssertions()
    await appBrowserScenario("providerTerminology")()
  })
})
