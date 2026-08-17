/* oxlint-disable eslint/no-await-in-loop, eslint/no-underscore-dangle -- Navigation retries and stabilization passes are deliberately sequential; domain unions use Effect-compatible _tag discriminants. */
import type { ParsedDiffFile } from "@diffdash/domain/diff"
import { projectDiffHunkLines } from "@diffdash/domain/diff-hunk-lines"
import type {
  ReviewSnapshotFileInventory,
  ReviewSnapshotManifest,
} from "@diffdash/domain/review-context"
import type { ReviewFileId, ReviewSnapshotId } from "@diffdash/domain/review-identity"
import type {
  RangeReviewNavigationTarget,
  ReviewLinePoint,
  ReviewNavigationInput,
  ReviewNavigationTarget,
} from "@diffdash/domain/review-navigation"
import type { ReviewThreadAnchor, ReviewThreadDetails } from "@diffdash/domain/review-thread"
import type { ReviewSnapshotSearchMatch } from "@diffdash/protocol/review-snapshot"
import type { ResolvedReviewSessionTarget } from "@diffdash/protocol/review-session"
import type { RefObject } from "react"
import { Match } from "effect"

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
import type { ProgressiveReviewContentReader } from "./progressive-review-content-session"
import type { ReviewThreadAnnotation } from "./thread-annotations"

/** Runtime Pierre registration retained only by the viewport execution plane. */
export interface ReviewDiffRegistration {
  readonly generation: number
  readonly host: HTMLElement
  readonly instance: VirtualizedFileDiff<ReviewThreadAnnotation>
  readonly reviewKey: string
  readonly rendered: boolean
}

/** Latest React-owned resources read imperatively by one stable viewport bridge. */
export interface ReviewViewportNavigationBindings {
  readonly review: Pick<
    ReviewSnapshotManifest,
    "projectId" | "reviewKey" | "baseRevision" | "headRevision"
  >
  readonly inventory: readonly ReviewSnapshotFileInventory[]
  readonly containerRef: RefObject<HTMLDivElement | null>
  readonly stickyChromeRef: RefObject<HTMLDivElement | null>
  readonly pages: ProgressiveReviewContentReader
  readonly diffRegistrations: ReadonlyMap<string, ReviewDiffRegistration>
  readonly diffVirtualizer: DiffVirtualizer
  readonly searchHighlights: ReviewSearchHighlightManager
  readonly searchOccurrences: readonly ReviewSnapshotSearchMatch[]
  readonly threads: readonly ReviewThreadDetails[]
  readonly requestReconciliation: (reviewKey: string) => number | null
  readonly prepareFile: (
    file: ReviewSnapshotFileInventory,
    input: ReviewNavigationInput,
    persistedTarget: ResolvedReviewSessionTarget | null,
  ) => void
  readonly activateWindow: () => Promise<void>
}

interface LocalResolvedReviewNavigationTarget extends ResolvedReviewNavigationTarget {
  readonly file: ReviewSnapshotFileInventory
  readonly linePoint: ReviewLinePoint | null
  readonly threadAnchor: ReviewThreadAnchor | null
  readonly threadId: string | null
  readonly persistedTarget: ResolvedReviewSessionTarget | null
}

const STABLE_FRAME_COUNT = 3
const LATE_LAYOUT_RECONCILIATION_MS = 8_000

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
  #layoutReconciliationGeneration = 0
  #bindings: ReviewViewportNavigationBindings | null = null
  #focusedNavigation: {
    readonly expiresAt: number
    readonly input: ReviewNavigationInput
    readonly target: LocalResolvedReviewNavigationTarget
  } | null = null

  constructor(anchors: ReviewNavigationAnchorRegistry) {
    this.#anchors = anchors
  }

  /** Replaces render-owned bindings without replacing the bridge or its epoch. */
  readonly update = (bindings: ReviewViewportNavigationBindings) => {
    this.#bindings = bindings
  }

  /** Restores navigation-owned focus after Pierre republishes its active range shell. */
  readonly reconcileRenderedFocus = (reviewKey: string) => {
    const navigation = this.#focusedNavigation
    if (navigation === null || navigation.target.file.reviewKey !== reviewKey) return
    if (performance.now() > navigation.expiresAt) {
      this.#focusedNavigation = null
      return
    }
    window.requestAnimationFrame(() => {
      const anchor = this.#mountContentAnchor(navigation.target)
      if (anchor === null) return
      this.#align(
        anchor,
        navigation.input.behavior.alignment,
        this.#targetStickyHeight(navigation.target),
      )
      if (deepActiveElement() !== document.body) return
      anchor.focus?.()
    })
  }

  /** Resolves a semantic target strictly inside the active manifest. */
  readonly resolveTarget = async (
    target: ReviewNavigationTarget,
    signal: AbortSignal,
  ): Promise<LocalResolvedReviewNavigationTarget> => {
    this.#throwIfAborted(signal)
    this.#layoutReconciliationGeneration += 1
    this.#focusedNavigation = null
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
        details.thread.repoId !== bindings.review.projectId ||
        details.thread.reviewKey !== bindings.review.reviewKey ||
        details.thread.currentBaseRevision !== bindings.review.baseRevision ||
        details.thread.currentHeadRevision !== bindings.review.headRevision ||
        anchor === null
      ) {
        throw new ReviewNavigationUnavailableError("targetOutdated")
      }
      const file = bindings.inventory.find(
        (candidate) => candidate.fileId === anchor.fileId && candidate.path === anchor.filePath,
      )
      if (file === undefined) throw new ReviewNavigationUnavailableError("targetOutdated")
      const persistedTarget = await bindings.pages.resolveTarget(
        {
          fileId: file.fileId,
          target: {
            _tag: "SideLine",
            hunkId: anchor.hunkId,
            side: anchor.side,
            lineNumber: anchor.lineNumber,
          },
        },
        signal,
      )
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
        persistedTarget,
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
    const file = bindings.inventory.find((candidate) => candidate.fileId === fileTarget.fileId)
    if (file === undefined) throw new ReviewNavigationUnavailableError("targetNotFound")
    const linePoint = Match.valueTags(fileTarget, {
      line: ({ point }) => point,
      range: ({ start }) => start,
      file: () => null,
      hunk: () => null,
    })
    const searchOccurrence = Match.valueTags(fileTarget, {
      range: (range) =>
        bindings.searchOccurrences.find((occurrence) =>
          rangeMatchesOccurrence(range, occurrence),
        ) ?? null,
      file: () => null,
      hunk: () => null,
      line: () => null,
    })
    const persistedTarget =
      searchOccurrence === null
        ? null
        : await bindings.pages.resolveTarget(
            {
              fileId: file.fileId,
              target: {
                _tag: "HunkLine",
                hunkId: searchOccurrence.hunkId,
                line: searchOccurrence.hunkLineIndex,
              },
            },
            signal,
          )
    const resolved = {
      target,
      file,
      fileId: file.fileId,
      anchorKey: targetAnchorKey(fileTarget),
      linePoint,
      threadAnchor: null,
      threadId: null,
      persistedTarget,
    }
    this.#localTargets.set(resolved, resolved)
    return resolved
  }

  /** Loads and validates the exact parsed resource required by a resolved target. */
  readonly loadTarget = async (target: ResolvedReviewNavigationTarget, signal: AbortSignal) => {
    const resolved = this.#localTarget(target)
    if (resolved.persistedTarget !== null) {
      this.#throwIfAborted(signal)
      return
    }
    const bindings = this.#current()
    const result = await bindings.pages.loadFiles([resolved.file.fileId])
    this.#throwIfAborted(signal)
    const status = result.statuses.get(resolved.file.fileId)
    const file = bindings.pages.getFile(resolved.file.fileId)
    if (status === "expired") throw new ReviewNavigationSnapshotExpiredError()
    if (status === "failed") {
      const cause = result.failureCauses.get(resolved.file.fileId)
      if (cause !== undefined) throw cause
    }
    if (status !== "loaded" || file === null) {
      if (
        status === "loaded" &&
        (resolved.persistedTarget !== null || this.#validateMountedTarget(resolved))
      )
        return
      throw new Error(`Unable to load ${resolved.file.fileId}`)
    }
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
    this.#current().prepareFile(resolved.file, input, resolved.persistedTarget)
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
    while (stableFrames < STABLE_FRAME_COUNT) {
      this.#throwIfAborted(signal)
      if (!currentAnchor.isConnected()) {
        currentAnchor = await this.waitForAnchor(resolved, signal)
        await this.position(currentAnchor, input, signal)
        if (input.behavior.focus === "target") await this.focus(currentAnchor, signal)
        continue
      }
      const stickyHeight = this.#targetStickyHeight(resolved)
      this.#align(currentAnchor, input.behavior.alignment, stickyHeight)
      let focusMatches =
        input.behavior.focus === "preserve" ||
        (currentAnchor.ownsFocus?.(deepActiveElement()) ??
          anchorOwnsDeepFocus(currentAnchor, deepActiveElement()))
      if (!focusMatches && input.behavior.focus === "target") {
        focusMatches = currentAnchor.focus?.() === true
      }
      const geometryMatches =
        this.#alignmentDrift(currentAnchor, input.behavior.alignment, stickyHeight) <= 1
      const stable = geometryMatches && focusMatches
      stableFrames = stable ? stableFrames + 1 : 0
      await nextFrame(signal)
      if (!currentAnchor.isConnected() && stableFrames >= STABLE_FRAME_COUNT) {
        stableFrames = STABLE_FRAME_COUNT - 1
      }
    }
    if (input.behavior.focus === "target" && currentAnchor.isConnected()) {
      currentAnchor.focus?.()
      const expiresAt = performance.now() + LATE_LAYOUT_RECONCILIATION_MS
      const reconciliationGeneration = ++this.#layoutReconciliationGeneration
      this.#focusedNavigation = {
        expiresAt,
        input,
        target: resolved,
      }
      this.#reconcileAfterLayout(
        currentAnchor,
        input.behavior.alignment,
        this.#targetStickyHeight(resolved),
        expiresAt,
        reconciliationGeneration,
      )
    }
    this.#current().searchHighlights.refresh()
    this.#reconciliations.delete(resolved.anchorKey)
  }

  readonly #reconcileAfterLayout = (
    anchor: MountedReviewAnchor,
    alignment: ReviewNavigationInput["behavior"]["alignment"],
    stickyHeight: number,
    expiresAt: number,
    generation: number,
  ): void => {
    if (generation !== this.#layoutReconciliationGeneration || performance.now() >= expiresAt)
      return
    window.requestAnimationFrame(() => {
      if (generation !== this.#layoutReconciliationGeneration || !anchor.isConnected()) return
      const active = deepActiveElement()
      const ownsFocus = anchor.ownsFocus?.(active) ?? anchorOwnsDeepFocus(anchor, active)
      if (active !== document.body && !ownsFocus) return
      this.#align(anchor, alignment, stickyHeight)
      if (active === document.body) anchor.focus?.()
      this.#reconcileAfterLayout(anchor, alignment, stickyHeight, expiresAt, generation)
    })
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

  readonly #validateMountedTarget = (resolved: LocalResolvedReviewNavigationTarget): boolean => {
    if (
      Match.valueTags(resolved.target, {
        file: () => true,
        extension: () => false,
        hunk: () => false,
        line: () => false,
        range: () => false,
        thread: () => false,
      })
    ) {
      return true
    }
    const point = resolved.linePoint
    const registration = this.#current().diffRegistrations.get(resolved.file.reviewKey)
    if (point === null || registration === undefined || !registration.rendered) return false
    const side = point.side === "old" ? "deletions" : "additions"
    if (registration.instance.getLineIndex(point.lineNumber, side) === undefined) {
      throw new ReviewNavigationUnavailableError("targetOutdated")
    }
    return true
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
    const line = findRenderedDiffLine(
      registration.host,
      registration.instance,
      point.lineNumber,
      point.side === "old" ? "deletions" : "additions",
    )
    if (line === null) return null
    const resolveRegistration = () => {
      const current = this.#current().diffRegistrations.get(resolved.file.reviewKey)
      return current !== undefined && current.rendered && current.host.isConnected ? current : null
    }
    const resolveLine = () => {
      const current = resolveRegistration()
      return current === null
        ? null
        : findRenderedDiffLine(
            current.host,
            current.instance,
            point.lineNumber,
            point.side === "old" ? "deletions" : "additions",
          )
    }

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
      const resolvePanel = () => {
        const card =
          resolveRegistration()?.host.closest<HTMLElement>("[data-review-file-id]") ?? null
        return card === null
          ? null
          : ([...card.querySelectorAll<HTMLElement>("[data-review-thread-id]")].find(
              (candidate) => candidate.dataset.reviewThreadId === resolved.threadId,
            ) ?? null)
      }
      const panel = resolvePanel()
      if (panel === null) return null
      return {
        measure: () => (resolveLine() ?? line).getBoundingClientRect(),
        focus: () => {
          const current = resolvePanel()
          return current !== null && focusThreadPanel(current)
        },
        ownsFocus: (active) => {
          const current = resolvePanel()
          return (
            active !== null && current !== null && (active === current || current.contains(active))
          )
        },
        isConnected: () => resolveLine() !== null && resolvePanel() !== null,
      }
    }

    return resolvingFocusableAnchor(resolveLine, line)
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
      const positionHost = searchPosition?.host ?? registration.host
      const hostTop =
        positionHost.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop
      const top = hostTop + position.top - stickyHeight - (viewportHeight - position.height) / 2
      setProgrammaticScrollTop(container, top)
    }
    const reconciliation = this.#reconciliations.get(resolved.anchorKey)
    if (reconciliation === undefined || reconciliation.passes < 1) {
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
    for (;;) {
      this.#throwIfAborted(signal)
      this.#align(anchor, "start", this.#targetStickyHeight(resolved))
      const bindings = this.#current()
      const targetIndex = bindings.inventory.findIndex(
        (file) => file.fileId === resolved.file.fileId,
      )
      const precedingLoads = [...bindings.pages.getProjection().loadingFileIds].filter(
        (fileId) => bindings.inventory.findIndex((file) => file.fileId === fileId) < targetIndex,
      )
      if (precedingLoads.length > 0) {
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
    anchor: Pick<MountedReviewAnchor, "measure">,
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
  "file" in target &&
  "linePoint" in target &&
  "threadAnchor" in target &&
  "threadId" in target &&
  "persistedTarget" in target

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

const resolvingFocusableAnchor = (
  resolve: () => HTMLElement | null,
  initial: HTMLElement,
): Omit<MountedReviewAnchor, "generation"> => {
  let last = initial
  const current = () => {
    const resolved = resolve()
    if (resolved !== null) last = resolved
    return resolved
  }
  return {
    measure: () => (current() ?? last).getBoundingClientRect(),
    focus: () => {
      const element = current()
      if (element === null || element.getClientRects().length === 0) return false
      element.tabIndex = -1
      element.focus({ preventScroll: true })
      return deepActiveElement() === element
    },
    ownsFocus: (active) => active !== null && active === current(),
    isConnected: () => current() !== null,
  }
}

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
