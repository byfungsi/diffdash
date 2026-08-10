/* oxlint-disable eslint/no-await-in-loop, eslint/no-underscore-dangle -- Navigation retries and stabilization passes are deliberately sequential; domain unions use Effect-compatible _tag discriminants. */
import type { ParsedDiffFile } from "@diffdash/domain/diff"
import { projectDiffHunkLines } from "@diffdash/domain/diff-hunk-lines"
import type {
  ReviewSnapshotFileInventory,
  ReviewSnapshotManifest,
} from "@diffdash/domain/review-context"
import { ReviewFileId, type ReviewSnapshotId } from "@diffdash/domain/review-identity"
import type {
  RangeReviewNavigationTarget,
  ReviewLinePoint,
  ReviewNavigationInput,
  ReviewNavigationTarget,
} from "@diffdash/domain/review-navigation"
import type { ReviewThreadAnchor, ReviewThreadDetails } from "@diffdash/domain/review-thread"
import type { ReviewSnapshotSearchMatch } from "@diffdash/protocol/review-snapshot"
import type { TransportError } from "@diffdash/protocol/transport-error"
import type { RefObject } from "react"
import { Match, Result, Schema } from "effect"

import { findRenderedDiffLine } from "./review-rendered-line"
import {
  type MountedReviewAnchor,
  type ResolvedReviewNavigationTarget,
  ReviewNavigationSnapshotExpiredError,
  ReviewNavigationUnavailableError,
  type ReviewViewportBridge,
} from "./review-navigation"
import { ReviewNavigationAnchorRegistry, reviewFileAnchorKey } from "./review-navigation-anchors"
import type { DiffVirtualizer, VirtualizedFileDiff } from "./pierre"
import type { ReviewSearchHighlightManager } from "./review-search-highlights"
import type { ReviewSnapshotPageReader } from "./review-snapshot-page-session"

/** Runtime Pierre registration retained only by the viewport execution plane. */
export interface ReviewDiffRegistration {
  readonly generation: number
  readonly host: HTMLElement
  readonly instance: VirtualizedFileDiff<TransportError>
  readonly rendered: boolean
}

/** Latest React-owned resources read imperatively by one stable viewport bridge. */
export interface ReviewViewportNavigationBindings {
  readonly manifest: ReviewSnapshotManifest
  readonly containerRef: RefObject<HTMLDivElement | null>
  readonly stickyChromeRef: RefObject<HTMLDivElement | null>
  readonly pages: ReviewSnapshotPageReader
  readonly diffRegistrations: ReadonlyMap<string, ReviewDiffRegistration>
  readonly diffVirtualizer: DiffVirtualizer
  readonly searchHighlights: ReviewSearchHighlightManager
  readonly searchOccurrences: readonly ReviewSnapshotSearchMatch[]
  readonly threads: readonly ReviewThreadDetails[]
  readonly requestReconciliation: (reviewKey: string) => number | null
  readonly prepareFile: (file: ReviewSnapshotFileInventory, input: ReviewNavigationInput) => void
  readonly activateWindow: () => Promise<void>
}

interface LocalResolvedReviewNavigationTarget extends ResolvedReviewNavigationTarget {
  readonly file: ReviewSnapshotFileInventory
  readonly linePoint: ReviewLinePoint | null
  readonly threadAnchor: ReviewThreadAnchor | null
  readonly threadId: string | null
}

const EAGER_PLACEHOLDER_MARGIN = 600
const STABLE_FRAME_COUNT = 3

/** Imperative DOM/Pierre execution plane for the renderer-local review navigator. */
export class ReviewViewportNavigationBridge implements ReviewViewportBridge {
  readonly #anchors: ReviewNavigationAnchorRegistry
  readonly #resolvedAnchors = new WeakMap<object, LocalResolvedReviewNavigationTarget>()
  readonly #localTargets = new WeakMap<
    ResolvedReviewNavigationTarget,
    LocalResolvedReviewNavigationTarget
  >()
  readonly #reconciliations = new Map<
    string,
    { readonly generation: number; readonly passes: number }
  >()
  #bindings: ReviewViewportNavigationBindings | null = null

  constructor(anchors: ReviewNavigationAnchorRegistry) {
    this.#anchors = anchors
  }

  /** Replaces render-owned bindings without replacing the bridge or its epoch. */
  readonly update = (bindings: ReviewViewportNavigationBindings) => {
    this.#bindings = bindings
  }

  /** Resolves a semantic target strictly inside the active manifest. */
  readonly resolveTarget = async (
    target: ReviewNavigationTarget,
    signal: AbortSignal,
  ): Promise<LocalResolvedReviewNavigationTarget> => {
    this.#throwIfAborted(signal)
    const bindings = this.#current()
    if (
      Match.valueTags(target, {
        extension: () => true,
        thread: () => false,
        file: () => false,
        hunk: () => false,
        line: () => false,
        range: () => false,
      })
    ) {
      throw new ReviewNavigationUnavailableError("extensionUnavailable")
    }

    const threadTarget = Match.valueTags(target, {
      thread: (value) => value,
      extension: () => null,
      file: () => null,
      hunk: () => null,
      line: () => null,
      range: () => null,
    })
    if (threadTarget !== null) {
      const details = bindings.threads.find(
        (candidate) => candidate.thread.id === threadTarget.threadId,
      )
      const anchor = details?.thread.activeAnchor ?? null
      if (
        details === undefined ||
        details.thread.repoId !== bindings.manifest.projectId ||
        details.thread.reviewKey !== bindings.manifest.reviewKey ||
        details.thread.currentBaseRevision !== bindings.manifest.baseRevision ||
        details.thread.currentHeadRevision !== bindings.manifest.headRevision ||
        anchor === null
      ) {
        throw new ReviewNavigationUnavailableError("targetOutdated")
      }
      const file = bindings.manifest.files.find(
        (candidate) => candidate.fileId === anchor.fileId && candidate.path === anchor.filePath,
      )
      if (file === undefined) throw new ReviewNavigationUnavailableError("targetOutdated")
      const resolved = {
        target,
        file,
        fileId: file.fileId,
        anchorKey: `thread:${threadTarget.threadId}`,
        linePoint: {
          hunkId: anchor.hunkId,
          hunkFingerprint: anchor.hunkFingerprint,
          side: anchor.side,
          lineNumber: anchor.lineNumber,
        },
        threadAnchor: anchor,
        threadId: threadTarget.threadId,
      }
      this.#localTargets.set(resolved, resolved)
      return resolved
    }

    const fileTarget = Match.valueTags(target, {
      file: (value) => value,
      hunk: (value) => value,
      line: (value) => value,
      range: (value) => value,
      extension: () => null,
      thread: () => null,
    })
    if (fileTarget === null) throw new ReviewNavigationUnavailableError("targetNotFound")
    const file = bindings.manifest.files.find((candidate) => candidate.fileId === fileTarget.fileId)
    if (file === undefined) throw new ReviewNavigationUnavailableError("targetNotFound")
    const resolved = {
      target,
      file,
      fileId: file.fileId,
      anchorKey: targetAnchorKey(fileTarget),
      linePoint: Match.valueTags(fileTarget, {
        line: ({ point }) => point,
        range: ({ start }) => start,
        file: () => null,
        hunk: () => null,
      }),
      threadAnchor: null,
      threadId: null,
    }
    this.#localTargets.set(resolved, resolved)
    return resolved
  }

  /** Loads and validates the exact parsed resource required by a resolved target. */
  readonly loadTarget = async (target: ResolvedReviewNavigationTarget, signal: AbortSignal) => {
    const resolved = this.#localTarget(target)
    const bindings = this.#current()
    const result = await bindings.pages.loadFiles([resolved.file.fileId])
    this.#throwIfAborted(signal)
    const status = result.statuses.get(resolved.file.fileId)
    const file = bindings.pages.getFile(resolved.file.fileId)
    if (status === "expired") throw new ReviewNavigationSnapshotExpiredError()
    if (status === "tooLarge") {
      if (
        Match.valueTags(resolved.target, {
          file: () => true,
          thread: () => false,
          extension: () => false,
          hunk: () => false,
          line: () => false,
          range: () => false,
        })
      )
        return
      throw new ReviewNavigationUnavailableError("fileContentUnavailable")
    }
    if (status === "failed") {
      const cause = result.failureCauses.get(resolved.file.fileId)
      if (cause !== undefined) throw cause
    }
    if (status !== "loaded" || file === null)
      throw new Error(`Unable to load ${resolved.file.fileId}`)
    this.#validateParsedTarget(file, resolved)
  }

  /** Waits for the canonical manifest atom refresh and returns its exact identity. */
  readonly reacquireSnapshot = (
    expectedSnapshotId: ReviewSnapshotId,
    signal: AbortSignal,
  ): Promise<ReviewSnapshotId> =>
    this.#current().pages.waitForManifestReplacement(expectedSnapshotId, signal)

  /** Applies request-owned selection and surface preparation. */
  readonly prepareSurface = async (
    target: ResolvedReviewNavigationTarget,
    input: ReviewNavigationInput,
    signal: AbortSignal,
  ) => {
    this.#throwIfAborted(signal)
    const resolved = this.#localTarget(target)
    this.#current().prepareFile(resolved.file, input)
    await nextFrame(signal)
  }

  /** Waits for a registered file, line, range, hunk, or thread target. */
  readonly waitForAnchor = async (target: ResolvedReviewNavigationTarget, signal: AbortSignal) => {
    const resolved = this.#localTarget(target)
    if (
      Match.valueTags(resolved.target, {
        file: () => true,
        thread: () => false,
        extension: () => false,
        hunk: () => false,
        line: () => false,
        range: () => false,
      })
    ) {
      const anchor = await this.#anchors.waitForAnchor(
        reviewFileAnchorKey(resolved.file.fileId),
        signal,
      )
      this.#resolvedAnchors.set(anchor, resolved)
      return anchor
    }

    const fileAnchor = await this.#anchors.waitForAnchor(
      reviewFileAnchorKey(resolved.file.fileId),
      signal,
    )
    this.#align(fileAnchor, "start", this.#globalStickyHeight())
    for (;;) {
      this.#throwIfAborted(signal)
      const mounted = this.#mountContentAnchor(resolved)
      if (mounted !== null) {
        this.#reconciliations.delete(resolved.anchorKey)
        const release = this.#anchors.registerAnchor(resolved.anchorKey, mounted)
        const anchor = this.#anchors.getAnchor(resolved.anchorKey)
        if (anchor !== null) {
          this.#resolvedAnchors.set(anchor, resolved)
          signal.addEventListener("abort", release, { once: true })
          return anchor
        }
        release()
      }
      this.#primeContentAnchor(resolved)
      await nextFrame(signal)
    }
  }

  readonly #localTarget = (
    target: ResolvedReviewNavigationTarget,
  ): LocalResolvedReviewNavigationTarget => {
    const resolved = this.#localTargets.get(target)
    if (resolved !== undefined) return resolved
    if (isLocalResolvedReviewNavigationTarget(target)) return target
    throw new ReviewNavigationUnavailableError("targetNotFound")
  }

  /** Positions the mounted target and waits for relevant preceding/eager resources. */
  readonly position = async (
    anchor: MountedReviewAnchor,
    input: ReviewNavigationInput,
    signal: AbortSignal,
  ) => {
    const resolved = this.#resolved(anchor)
    if (input.behavior.alignment === "start") {
      await this.#settleRelevantFileLoads(resolved, anchor, signal)
    }
    this.#align(anchor, input.behavior.alignment, this.#targetStickyHeight(resolved))
  }

  /** Activates DiffDash through the preload boundary before target focus. */
  readonly activateWindow = async (signal: AbortSignal) => {
    this.#throwIfAborted(signal)
    await this.#current().activateWindow()
    this.#throwIfAborted(signal)
  }

  /** Applies actual keyboard focus without allowing native focus scrolling. */
  readonly focus = async (anchor: MountedReviewAnchor, signal: AbortSignal) => {
    const resolved = this.#resolved(anchor)
    let currentAnchor = anchor
    for (;;) {
      this.#throwIfAborted(signal)
      if (!currentAnchor.isConnected()) {
        currentAnchor = await this.waitForAnchor(resolved, signal)
        continue
      }
      if (currentAnchor.focus === undefined) {
        throw new ReviewNavigationUnavailableError("notFocusable")
      }
      if (!currentAnchor.focus()) {
        if (!currentAnchor.isConnected()) continue
        throw new ReviewNavigationUnavailableError("notFocusable")
      }
      await nextFrame(signal)
      if (currentAnchor.isConnected()) return
    }
  }

  /** Verifies stable geometry and deep focus, compensating for late layout changes. */
  readonly verify = async (
    anchor: MountedReviewAnchor,
    input: ReviewNavigationInput,
    signal: AbortSignal,
  ) => {
    const resolved = this.#resolved(anchor)
    let currentAnchor = anchor
    let stableFrames = 0
    let previousHeight = -1
    while (stableFrames < STABLE_FRAME_COUNT) {
      this.#throwIfAborted(signal)
      if (!currentAnchor.isConnected()) {
        currentAnchor = await this.waitForAnchor(resolved, signal)
        await this.position(currentAnchor, input, signal)
        if (input.behavior.focus === "target") await this.focus(currentAnchor, signal)
        stableFrames = 0
        previousHeight = -1
        continue
      }
      const container = this.#container()
      const beforeTop = currentAnchor.measure().top
      const stickyHeight = this.#targetStickyHeight(resolved)
      this.#align(currentAnchor, input.behavior.alignment, stickyHeight)
      const afterTop = currentAnchor.measure().top
      const focusMatches =
        input.behavior.focus === "preserve" ||
        (currentAnchor.ownsFocus?.(deepActiveElement()) ??
          anchorOwnsDeepFocus(currentAnchor, deepActiveElement()))
      const geometryMatches =
        this.#alignmentDrift(currentAnchor, input.behavior.alignment, stickyHeight) <= 1
      const stable =
        geometryMatches &&
        focusMatches &&
        Math.abs(afterTop - beforeTop) <= 1 &&
        previousHeight === container.scrollHeight
      stableFrames = stable ? stableFrames + 1 : 0
      previousHeight = container.scrollHeight
      await nextFrame(signal)
    }
  }

  readonly #validateParsedTarget = (
    file: ParsedDiffFile,
    resolved: LocalResolvedReviewNavigationTarget,
  ) => {
    const target = resolved.target
    Match.valueTags(target, {
      file: () => undefined,
      thread: () => {
        const anchor = resolved.threadAnchor
        if (anchor === null || !parsedFileContainsThreadAnchor(file, anchor)) {
          throw new ReviewNavigationUnavailableError("targetOutdated")
        }
      },
      extension: () => {
        throw new ReviewNavigationUnavailableError("extensionUnavailable")
      },
      hunk: (hunkTarget) => {
        const expectedHunk = file.hunks.find(
          (hunk) =>
            hunk.id === hunkTarget.hunkId && hunk.fingerprint === hunkTarget.hunkFingerprint,
        )
        if (expectedHunk === undefined) throw new ReviewNavigationUnavailableError("targetOutdated")
      },
      line: ({ point }) => {
        if (!parsedFileContainsPoint(file, point)) {
          throw new ReviewNavigationUnavailableError("targetOutdated")
        }
      },
      range: ({ start, end }) => {
        if ([start, end].some((point) => !parsedFileContainsPoint(file, point))) {
          throw new ReviewNavigationUnavailableError("targetOutdated")
        }
      },
    })
  }

  readonly #mountContentAnchor = (
    resolved: LocalResolvedReviewNavigationTarget,
  ): Omit<MountedReviewAnchor, "generation"> | null => {
    const bindings = this.#current()
    const registration = bindings.diffRegistrations.get(resolved.file.reviewKey)
    if (registration === undefined || !registration.rendered || !registration.host.isConnected) {
      return null
    }
    const point = resolvedPoint(bindings.pages.getFile(resolved.file.fileId), resolved)
    if (point === null) return null
    if (
      Match.valueTags(resolved.target, {
        range: () => true,
        file: () => false,
        thread: () => false,
        extension: () => false,
        hunk: () => false,
        line: () => false,
      })
    ) {
      const activeElement = bindings.searchHighlights.getActiveMatchElement()
      const activeRect = bindings.searchHighlights.getActiveMatchRect()
      if (activeElement !== null && activeRect !== null) {
        return focusableAnchor(activeElement, () => bindings.searchHighlights.getActiveMatchRect())
      }
    }
    const line = findRenderedDiffLine(
      registration.host,
      registration.instance,
      point.lineNumber,
      point.side === "old" ? "deletions" : "additions",
    )
    if (line === null) return null

    if (
      Match.valueTags(resolved.target, {
        thread: () => true,
        file: () => false,
        extension: () => false,
        hunk: () => false,
        line: () => false,
        range: () => false,
      })
    ) {
      const card = registration.host.closest<HTMLElement>("[data-review-file-id]")
      const panel =
        card === null
          ? null
          : ([...card.querySelectorAll<HTMLElement>("[data-review-thread-id]")].find(
              (candidate) => candidate.dataset.reviewThreadId === resolved.threadId,
            ) ?? null)
      if (panel === null) return null
      return {
        measure: () => line.getBoundingClientRect(),
        focus: () => focusThreadPanel(panel),
        ownsFocus: (active) => active !== null && (active === panel || panel.contains(active)),
        isConnected: () => line.isConnected && panel.isConnected,
      }
    }

    return focusableAnchor(line)
  }

  readonly #primeContentAnchor = (resolved: LocalResolvedReviewNavigationTarget) => {
    const bindings = this.#current()
    const registration = bindings.diffRegistrations.get(resolved.file.reviewKey)
    if (registration === undefined || !registration.host.isConnected) return
    const point = resolvedPoint(bindings.pages.getFile(resolved.file.fileId), resolved)
    if (point === null) return
    const rangeTarget = Match.valueTags(resolved.target, {
      range: (value) => value,
      file: () => null,
      thread: () => null,
      extension: () => null,
      hunk: () => null,
      line: () => null,
    })
    const searchOccurrence =
      rangeTarget !== null
        ? (bindings.searchOccurrences.find((occurrence) =>
            rangeMatchesOccurrence(rangeTarget, occurrence),
          ) ?? null)
        : null
    const searchPosition =
      searchOccurrence === null ? null : bindings.searchHighlights.getScrollTarget(searchOccurrence)
    const position =
      searchPosition ??
      registration.instance.getLinePosition(
        point.lineNumber,
        point.side === "old" ? "deletions" : "additions",
      )
    if (position !== undefined) {
      const container = this.#container()
      const stickyHeight = this.#targetStickyHeight(resolved)
      const viewportHeight = Math.max(1, container.clientHeight - stickyHeight)
      const top =
        bindings.diffVirtualizer.getOffsetInScrollContainer(
          searchPosition?.host ?? registration.host,
        ) +
        position.top -
        stickyHeight -
        (viewportHeight - position.height) / 2
      setProgrammaticScrollTop(container, top)
    }
    registration.instance.syncVirtualizedTop()
    bindings.diffVirtualizer.markDOMDirty()
    bindings.diffVirtualizer.requestHeightReconcile(registration.instance)
    const reconciliation = this.#reconciliations.get(resolved.anchorKey)
    if (
      reconciliation === undefined ||
      (registration.generation > reconciliation.generation && reconciliation.passes < 2)
    ) {
      const generation = bindings.requestReconciliation(resolved.file.reviewKey)
      if (generation !== null) {
        this.#reconciliations.set(resolved.anchorKey, {
          generation,
          passes: (reconciliation?.passes ?? 0) + 1,
        })
      }
    }
  }

  readonly #settleRelevantFileLoads = async (
    resolved: LocalResolvedReviewNavigationTarget,
    anchor: MountedReviewAnchor,
    signal: AbortSignal,
  ) => {
    let previousEagerKey = ""
    for (;;) {
      this.#throwIfAborted(signal)
      this.#align(anchor, "start", this.#targetStickyHeight(resolved))
      const bindings = this.#current()
      const targetIndex = bindings.manifest.files.findIndex(
        (file) => file.fileId === resolved.file.fileId,
      )
      const precedingLoads = [...bindings.pages.getProjection().loadingFileIds].filter(
        (fileId) =>
          bindings.manifest.files.findIndex((file) => file.fileId === fileId) < targetIndex,
      )
      const eagerIds = eagerPlaceholderFileIds(this.#container(), bindings.manifest.files)
      const eagerKey = eagerIds.join("\u0000")
      if (eagerIds.length > 0) {
        await bindings.pages.loadFiles(eagerIds)
        previousEagerKey = eagerKey
        await nextFrame(signal)
        continue
      }
      if (precedingLoads.length > 0 || previousEagerKey !== eagerKey) {
        previousEagerKey = eagerKey
        await nextFrame(signal)
        continue
      }
      if (!this.#fileSurfaceSettled(resolved)) {
        this.#primeFileSurface(resolved)
        await nextFrame(signal)
        continue
      }
      return
    }
  }

  readonly #fileSurfaceSettled = (resolved: LocalResolvedReviewNavigationTarget) => {
    const bindings = this.#current()
    const file = bindings.pages.getFile(resolved.file.fileId)
    if (file === null || file.status === "binary" || file.hunks.length === 0) return true
    const registration = bindings.diffRegistrations.get(resolved.file.reviewKey)
    return (
      registration !== undefined &&
      registration.rendered &&
      registration.host.isConnected &&
      (registration.host.shadowRoot?.querySelector("[data-line]") ?? null) !== null
    )
  }

  readonly #primeFileSurface = (resolved: LocalResolvedReviewNavigationTarget) => {
    const bindings = this.#current()
    const registration = bindings.diffRegistrations.get(resolved.file.reviewKey)
    if (registration === undefined || !registration.host.isConnected) return
    registration.instance.syncVirtualizedTop()
    bindings.diffVirtualizer.markDOMDirty()
    bindings.diffVirtualizer.requestHeightReconcile(registration.instance)
    const anchorKey = reviewFileAnchorKey(resolved.file.fileId)
    const reconciliation = this.#reconciliations.get(anchorKey)
    if (
      reconciliation === undefined ||
      (registration.generation > reconciliation.generation && reconciliation.passes < 2)
    ) {
      const generation = bindings.requestReconciliation(resolved.file.reviewKey)
      if (generation !== null) {
        this.#reconciliations.set(anchorKey, {
          generation,
          passes: (reconciliation?.passes ?? 0) + 1,
        })
      }
    }
  }

  readonly #align = (
    anchor: MountedReviewAnchor,
    alignment: ReviewNavigationInput["behavior"]["alignment"],
    stickyHeight: number,
  ) => {
    const container = this.#container()
    const containerRect = container.getBoundingClientRect()
    const targetRect = anchor.measure()
    const visibleTop = containerRect.top + stickyHeight
    const visibleBottom = containerRect.bottom
    let drift = 0
    if (alignment === "start") drift = targetRect.top - visibleTop
    else if (alignment === "center") {
      drift = targetRect.top + targetRect.height / 2 - (visibleTop + visibleBottom) / 2
    } else if (targetRect.top < visibleTop) drift = targetRect.top - visibleTop
    else if (targetRect.bottom > visibleBottom) drift = targetRect.bottom - visibleBottom
    if (Math.abs(drift) <= 0.5) return drift

    const previousScrollTop = container.scrollTop
    setProgrammaticScrollTop(container, previousScrollTop + drift)
    const residualDrift = drift - (container.scrollTop - previousScrollTop)
    const atScrollBoundary =
      container.scrollTop <= 0 ||
      container.scrollTop >= container.scrollHeight - container.clientHeight - 1
    // Exact centering is impossible at a scroll boundary; full visibility is the stable outcome.
    return atScrollBoundary && targetRect.top >= visibleTop && targetRect.bottom <= visibleBottom
      ? 0
      : residualDrift
  }

  readonly #alignmentDrift = (
    anchor: MountedReviewAnchor,
    alignment: ReviewNavigationInput["behavior"]["alignment"],
    stickyHeight: number,
  ) => Math.abs(this.#align(anchor, alignment, stickyHeight))

  readonly #resolved = (anchor: MountedReviewAnchor) => {
    const resolved = this.#resolvedAnchors.get(anchor)
    if (resolved === undefined) throw new Error("Mounted navigation anchor lost its target")
    return resolved
  }

  readonly #current = () => {
    if (this.#bindings === null) throw new Error("Review viewport bridge is detached")
    return this.#bindings
  }

  readonly #container = () => {
    const container = this.#current().containerRef.current
    if (container === null) throw new Error("Review viewport is not mounted")
    return container
  }

  readonly #globalStickyHeight = () => this.#current().stickyChromeRef.current?.offsetHeight ?? 0

  readonly #targetStickyHeight = (resolved: LocalResolvedReviewNavigationTarget) => {
    const globalHeight = this.#globalStickyHeight()
    if (
      Match.valueTags(resolved.target, {
        file: () => true,
        thread: () => false,
        extension: () => false,
        hunk: () => false,
        line: () => false,
        range: () => false,
      })
    )
      return globalHeight

    const registration = this.#current().diffRegistrations.get(resolved.file.reviewKey)
    const card = registration?.host.closest<HTMLElement>("[data-review-file-id]") ?? null
    const fileHeader = card?.querySelector<HTMLElement>("[data-diff-card-header]") ?? null
    return globalHeight + (fileHeader?.offsetHeight ?? 0)
  }

  readonly #throwIfAborted = (signal: AbortSignal) => {
    if (signal.aborted) throw new DOMException("Navigation aborted", "AbortError")
  }
}

const isLocalResolvedReviewNavigationTarget = (
  target: ResolvedReviewNavigationTarget,
): target is LocalResolvedReviewNavigationTarget =>
  "file" in target && "linePoint" in target && "threadAnchor" in target && "threadId" in target

const targetAnchorKey = (
  target: Exclude<ReviewNavigationTarget, { readonly _tag: "thread" | "extension" }>,
) => {
  return Match.valueTags(target, {
    file: ({ fileId }) => reviewFileAnchorKey(fileId),
    hunk: ({ fileId, hunkId }) => `hunk:${fileId}:${hunkId}`,
    line: ({ fileId, point }) => pointAnchorKey(fileId, point),
    range: ({ fileId, start, end }) =>
      `range:${pointAnchorKey(fileId, start)}:${pointAnchorKey(fileId, end)}`,
  })
}

const pointAnchorKey = (fileId: ReviewFileId, point: ReviewLinePoint) =>
  `line:${fileId}:${point.hunkId}:${point.side}:${point.lineNumber}:${point.column ?? ""}`

const rangeMatchesOccurrence = (
  target: RangeReviewNavigationTarget,
  occurrence: ReviewSnapshotSearchMatch,
) => {
  const side = occurrence.side === "deletions" ? "old" : "new"
  const lineNumber = side === "old" ? occurrence.oldLineNumber : occurrence.newLineNumber
  return (
    occurrence.fileId === target.fileId &&
    occurrence.hunkId === target.start.hunkId &&
    occurrence.hunkFingerprint === target.start.hunkFingerprint &&
    side === target.start.side &&
    lineNumber === target.start.lineNumber &&
    occurrence.start === (target.start.column ?? 0) &&
    occurrence.end === (target.end.column ?? 0)
  )
}

const parsedFileContainsPoint = (file: ParsedDiffFile, point: ReviewLinePoint) => {
  const hunk = file.hunks.find(
    (candidate) => candidate.id === point.hunkId && candidate.fingerprint === point.hunkFingerprint,
  )
  if (hunk === undefined) return false
  return projectDiffHunkLines(hunk).some(
    (line) =>
      line.kind !== "metadata" &&
      (point.side === "old" ? line.oldLineNumber : line.newLineNumber) === point.lineNumber,
  )
}

const parsedFileContainsThreadAnchor = (file: ParsedDiffFile, anchor: ReviewThreadAnchor) => {
  const hunk = file.hunks.find(
    (candidate) =>
      candidate.id === anchor.hunkId && candidate.fingerprint === anchor.hunkFingerprint,
  )
  if (hunk === undefined) return false
  return projectDiffHunkLines(hunk).some(
    (line) =>
      line.kind !== "metadata" &&
      (anchor.side === "old" ? line.oldLineNumber : line.newLineNumber) === anchor.lineNumber &&
      line.content === anchor.lineContent,
  )
}

const resolvedPoint = (
  file: ParsedDiffFile | null,
  resolved: LocalResolvedReviewNavigationTarget,
): ReviewLinePoint | null => {
  if (resolved.linePoint !== null) return resolved.linePoint
  const target = Match.valueTags(resolved.target, {
    hunk: (value) => value,
    file: () => null,
    thread: () => null,
    extension: () => null,
    line: () => null,
    range: () => null,
  })
  if (target === null || file === null) return null
  const hunk = file.hunks.find(
    (candidate) =>
      candidate.id === target.hunkId && candidate.fingerprint === target.hunkFingerprint,
  )
  const line =
    hunk === undefined
      ? undefined
      : projectDiffHunkLines(hunk).find((item) => item.kind !== "metadata")
  if (hunk === undefined || line === undefined || line.kind === "metadata") return null
  const side = line.newLineNumber === null ? "old" : "new"
  const lineNumber = side === "old" ? line.oldLineNumber : line.newLineNumber
  if (lineNumber === null) return null
  return {
    hunkId: hunk.id,
    hunkFingerprint: hunk.fingerprint,
    side,
    lineNumber,
  }
}

const focusableAnchor = (
  element: HTMLElement,
  measure: () => DOMRect | null = () => element.getBoundingClientRect(),
): Omit<MountedReviewAnchor, "generation"> => ({
  measure: () => measure() ?? element.getBoundingClientRect(),
  focus: () => {
    if (!element.isConnected || element.getClientRects().length === 0) return false
    element.tabIndex = -1
    element.focus({ preventScroll: true })
    return deepActiveElement() === element
  },
  ownsFocus: (active) => active === element,
  isConnected: () => element.isConnected,
})

const focusThreadPanel = (panel: HTMLElement) => {
  const endpoint =
    panel.querySelector<HTMLElement>('textarea[aria-label="Thread message"]') ??
    panel.querySelector<HTMLElement>("button, [tabindex]") ??
    panel
  if (endpoint === panel) panel.tabIndex = -1
  endpoint.focus({ preventScroll: true })
  return deepActiveElement() === endpoint
}

const deepActiveElement = (): Element | null => {
  let active: Element | null = document.activeElement
  while (
    active?.shadowRoot?.activeElement !== null &&
    active?.shadowRoot?.activeElement !== undefined
  ) {
    active = active.shadowRoot.activeElement
  }
  return active
}

const anchorOwnsDeepFocus = (anchor: MountedReviewAnchor, active: Element | null) => {
  if (active === null) return false
  const rect = anchor.measure()
  const activeRect = active.getBoundingClientRect()
  return (
    activeRect.bottom >= rect.top - 1 &&
    activeRect.top <= rect.bottom + 1 &&
    activeRect.right >= rect.left - 1 &&
    activeRect.left <= rect.right + 1
  )
}

const setProgrammaticScrollTop = (container: HTMLElement, requested: number) => {
  const max = Math.max(0, container.scrollHeight - container.clientHeight)
  container.scrollTop = Math.min(Math.max(0, requested), max)
  container.dispatchEvent(new Event("scroll"))
}

const eagerPlaceholderFileIds = (
  container: HTMLElement,
  inventory: readonly ReviewSnapshotFileInventory[],
) => {
  const containerRect = container.getBoundingClientRect()
  const byId = new Map(inventory.map((file) => [file.fileId, file]))
  return [
    ...container.querySelectorAll<HTMLElement>("[data-review-page-placeholder-file-id]"),
  ].flatMap((placeholder) => {
    const decodedFileId = Schema.decodeUnknownResult(ReviewFileId)(
      placeholder.dataset.reviewPagePlaceholderFileId,
    )
    if (Result.isFailure(decodedFileId)) return []
    const fileId = decodedFileId.success
    const rect = placeholder.getBoundingClientRect()
    return fileId !== undefined &&
      byId.has(fileId) &&
      rect.bottom >= containerRect.top - EAGER_PLACEHOLDER_MARGIN &&
      rect.top <= containerRect.bottom + EAGER_PLACEHOLDER_MARGIN
      ? [fileId]
      : []
  })
}

const nextFrame = (signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Navigation aborted", "AbortError"))
      return
    }
    const frame = window.requestAnimationFrame(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    })
    const onAbort = () => {
      window.cancelAnimationFrame(frame)
      reject(new DOMException("Navigation aborted", "AbortError"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
