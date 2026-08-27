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

  it("re-navigates to a selected file after the user scrolls away", async () => {
    expect.hasAssertions()
    await appBrowserScenario("fileTreeSelection")()
  })

  it("copies the current file path and exact new-side line from a diff context menu", async () => {
    expect.hasAssertions()
    await appBrowserScenario("diffLineContextMenu")()
  })

  it("expands unchanged lines and opens diff language locations in Code", async () => {
    expect.hasAssertions()
    await appBrowserScenario("diffLanguageNavigation")()
  })

  it("FUN-212 AC: owns viewport input through supersession, Escape, and stale completion", async () => {
    expect.hasAssertions()
    await appBrowserScenario("reviewNavigationLifecycle")()
  }, 45_000)

  it("uses native tree truncation for long file labels without overflowing review cards", async () => {
    expect.hasAssertions()
    await appBrowserScenario("longReviewPaths")()
  })

  it("eagerly loads complete review files through the Core session", async () => {
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

  it("bounds long review threads without blanking virtualized diffs", async () => {
    expect.hasAssertions()
    await appBrowserScenario("longThreadVirtualization")()
  }, 30_000)

  it("blurs an offscreen thread composer before handling review shortcuts", async () => {
    expect.hasAssertions()
    await appBrowserScenario("threadComposerShortcut")()
  }, 30_000)

  it("converges on the exact mounted thread line after virtualized layout changes", async () => {
    expect.hasAssertions()
    await appBrowserScenario("threadNavigationConvergence")()
  }, 30_000)

  it("keeps custom file headers below dynamic review chrome and within their cards", async () => {
    expect.hasAssertions()
    await appBrowserScenario("stickyDiffCardHeaders")()
  }, 30_000)

  it("wraps search backward across eagerly retained files", async () => {
    expect.hasAssertions()
    await appBrowserScenario("multiFileSearchWrap")()
  }, 45_000)

  it("keeps eager review files resident across navigation", async () => {
    expect.hasAssertions()
    await appBrowserScenario("snapshotPageResidency")()
  }, 45_000)

  it("finds and highlights exact case-insensitive substrings across diff lines", async () => {
    expect.hasAssertions()
    await appBrowserScenario("diffSearchSubstrings")()
  })

  it("FUN-213 AC: ignores delayed old queries and close-during-search completions", async () => {
    expect.hasAssertions()
    await appBrowserScenario("diffSearchLatestWork")()
  })

  it("starts search from the active file instead of the first file", async () => {
    expect.hasAssertions()
    await appBrowserScenario("diffSearchViewportAnchor")()
  })

  it("keeps paginated search cursors bound to the anchor captured when search opened", async () => {
    expect.hasAssertions()
    await appBrowserScenario("diffSearchImmutableAnchor")()
  })

  it("opens full-height attached thread panes and keeps unmappable threads available", async () => {
    expect.hasAssertions()
    await appBrowserScenario("reviewThreadSidebar")()
  })

  it("toggles viewed state for the file under the pointer", async () => {
    expect.hasAssertions()
    await appBrowserScenario("viewedShortcutPointerTarget")()
  })

  it("temporarily reveals hidden, filtered, and viewed files for search results", async () => {
    expect.hasAssertions()
    await appBrowserScenario("diffSearchVisibility")()
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

  it("retains viewed files and refreshes same-path worker output when hunk shapes change", async () => {
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

  it("loads the hosted overview before diff and submits provider actions", async () => {
    expect.hasAssertions()
    await appBrowserScenario("hostedReviewOverviewActions")()
  })

  it("returns to the hosted overview when the open pull request is selected again", async () => {
    expect.hasAssertions()
    await appBrowserScenario("hostedReviewReselection")()
  })

  it("updates an out-of-date hosted review branch and refreshes its overview", async () => {
    expect.hasAssertions()
    await appBrowserScenario("hostedReviewBranchUpdate")()
  })

  it("requires explicit confirmation before bypassing hosted merge rules", async () => {
    expect.hasAssertions()
    await appBrowserScenario("hostedReviewMergeBypass")()
  })

  it("disables merge and links to the provider when a hosted review conflicts", async () => {
    expect.hasAssertions()
    await appBrowserScenario("hostedReviewMergeConflicts")()
  })

  it("polls transient hosted merge readiness until GitHub resolves it", async () => {
    expect.hasAssertions()
    await appBrowserScenario("hostedReviewMergeStatusPolling")()
  })

  it("FUN-130 AC: uses provider terminology and hides unsupported review decisions", async () => {
    expect.hasAssertions()
    await appBrowserScenario("providerTerminology")()
  })
})
