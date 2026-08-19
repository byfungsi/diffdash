import { DiffFileVisibility } from "@diffdash/domain/diff"
import { ReviewSnapshotFileInventory } from "@diffdash/domain/review-context"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ReviewFileId, ReviewFilePatchHash, ReviewKey } from "@diffdash/domain/review-identity"
import { FileReviewNavigationTarget } from "@diffdash/domain/review-navigation"
import { describe, expect, it, vi } from "vitest"

import type { ResolvedReviewNavigationTarget } from "./review-navigation"
import { ReviewNavigationAnchorRegistry, reviewFileAnchorKey } from "./review-navigation-anchors"
import { ReviewViewportNavigationBridge } from "./review-viewport-navigation"

const noop = (): void => undefined

describe("ReviewViewportNavigationBridge", () => {
  it("reacquires a file anchor replaced during focus", async () => {
    const fileId = ReviewFileId.make("file:src/app.ts")
    const file = ReviewSnapshotFileInventory.make({
      fileId,
      patchHash: ReviewFilePatchHash.make("1234567890abcdef"),
      reviewKey: ReviewKey.make("src/app.ts"),
      path: RepositoryRelativePath.make("src/app.ts"),
      oldPath: null,
      status: "modified",
      visibility: DiffFileVisibility.cases.Visible.make({}),
      additions: 1,
      deletions: 1,
      hunkCount: 1,
    })
    const target = FileReviewNavigationTarget.make({ fileId })
    const resolved: ResolvedReviewNavigationTarget & {
      readonly file: ReviewSnapshotFileInventory
      readonly linePoint: null
      readonly threadAnchor: null
      readonly threadId: null
      readonly persistedTarget: null
    } = {
      target,
      file,
      fileId,
      anchorKey: reviewFileAnchorKey(fileId),
      linePoint: null,
      threadAnchor: null,
      threadId: null,
      persistedTarget: null,
    }
    const anchors = new ReviewNavigationAnchorRegistry()
    const bridge = new ReviewViewportNavigationBridge(anchors)
    let firstConnected = true
    let releaseFirst = noop
    const replacementFocus = vi.fn<() => boolean>(() => true)
    const firstFocus = vi.fn<() => boolean>(() => {
      firstConnected = false
      releaseFirst()
      anchors.registerAnchor(resolved.anchorKey, {
        measure: () => new DOMRect(),
        focus: replacementFocus,
        isConnected: () => true,
      })
      return false
    })
    releaseFirst = anchors.registerAnchor(resolved.anchorKey, {
      measure: () => new DOMRect(),
      focus: firstFocus,
      isConnected: () => firstConnected,
    })
    const abort = new AbortController()
    const initialAnchor = await bridge.waitForAnchor(resolved, abort.signal)

    await bridge.focus(initialAnchor, abort.signal)

    expect(firstFocus).toHaveBeenCalledOnce()
    expect(replacementFocus).toHaveBeenCalledOnce()
    abort.abort()
    anchors.dispose()
  })
})
