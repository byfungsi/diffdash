/* oxlint-disable eslint/no-underscore-dangle -- Search result variants use Effect-compatible _tag discriminants. */
import {
  RangeReviewNavigationTarget,
  ReviewLinePoint,
  ReviewLocationV1,
  ReviewNavigationBehavior,
  ReviewNavigationInput,
  ReviewSnapshotAddress,
} from "@diffdash/domain/review-navigation"
import {
  type ReviewSnapshotSearchCursor,
  type ReviewSnapshotSearchFileAnchor,
  type ReviewSnapshotSearchMatch,
  ReviewSnapshotSearchRequest,
  ReviewSnapshotSearchResponse,
} from "@diffdash/protocol/review-snapshot"
import { Match, Schema } from "effect"
import { Atom, AtomRegistry } from "effect/unstable/reactivity"

import type { ReviewNavigator } from "./review-navigation"
import { type ReviewSearchPage, ReviewSearchPageCache } from "./review-search-page-cache"

/** Serializable lifecycle state for the current search result set. */
export type ReviewSearchResultStatus =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "available" }
  | { readonly _tag: "failed" }
  | { readonly _tag: "expired" }

/** Full ownership guard carried by every asynchronous search operation. */
export interface ReviewSearchOperationKey {
  readonly projectId: ReviewSnapshotAddress["projectId"]
  readonly snapshotId: ReviewSnapshotAddress["snapshotId"]
  readonly sessionEpoch: number
  readonly queryEpoch: number
  readonly moveEpoch: number
}

/** One latest-query or latest-movement operation accepted by the reducer. */
export interface ReviewSearchOperation {
  readonly key: ReviewSearchOperationKey
  readonly kind: "query" | "move"
  readonly targetIndex: number
}

/** Complete serializable search model updated atomically by commands. */
export interface ReviewSearchModel {
  readonly session: ReviewSnapshotAddress | null
  readonly sessionEpoch: number
  readonly queryEpoch: number
  readonly moveEpoch: number
  readonly open: boolean
  readonly query: string
  readonly anchor: ReviewSnapshotSearchFileAnchor | null
  readonly resultStatus: ReviewSearchResultStatus
  readonly totalMatches: number
  readonly desiredGlobalIndex: number
  readonly activeGlobalIndex: number
  readonly activeMatch: ReviewSnapshotSearchMatch | null
  readonly retainedMatches: readonly ReviewSnapshotSearchMatch[]
}

/** Commands accepted by the pure review-search state machine. */
export type ReviewSearchCommand =
  | { readonly _tag: "attach"; readonly session: ReviewSnapshotAddress }
  | { readonly _tag: "replace"; readonly session: ReviewSnapshotAddress }
  | { readonly _tag: "detach" }
  | { readonly _tag: "open"; readonly anchor: ReviewSnapshotSearchFileAnchor | null }
  | { readonly _tag: "close" }
  | {
      readonly _tag: "query"
      readonly query: string
      readonly anchor?: ReviewSnapshotSearchFileAnchor | null
    }
  | { readonly _tag: "move"; readonly direction: -1 | 1 }
  | {
      readonly _tag: "results"
      readonly key: ReviewSearchOperationKey
      readonly totalMatches: number
      readonly retainedMatches: readonly ReviewSnapshotSearchMatch[]
    }
  | {
      readonly _tag: "activate"
      readonly key: ReviewSearchOperationKey
      readonly index: number
      readonly match: ReviewSnapshotSearchMatch
    }
  | { readonly _tag: "failed"; readonly operation: ReviewSearchOperation }
  | { readonly _tag: "expired"; readonly key: ReviewSearchOperationKey }

/** Pure command result used by the imperative controller. */
export interface ReviewSearchCommandResult {
  readonly model: ReviewSearchModel
  readonly operation: ReviewSearchOperation | null
  readonly activatedMatch: ReviewSnapshotSearchMatch | null
  readonly stale: boolean
}

/** Narrow toolbar-facing search projection. */
export interface ReviewSearchToolbarState {
  readonly open: boolean
  readonly query: string
  readonly resultStatus: ReviewSearchResultStatus
  readonly totalMatches: number
  readonly activeGlobalIndex: number
}

/** Runtime capabilities kept outside serializable atom state. */
export interface ReviewSearchRuntime {
  readonly navigator: Pick<ReviewNavigator, "navigate" | "cancelActiveForOrigins">
  readonly onSnapshotExpired: () => void
  readonly search: (request: ReviewSnapshotSearchRequest) => Promise<ReviewSnapshotSearchResponse>
}

const IDLE_RESULT_STATUS: ReviewSearchResultStatus = { _tag: "idle" }
const LOADING_RESULT_STATUS: ReviewSearchResultStatus = { _tag: "loading" }
const AVAILABLE_RESULT_STATUS: ReviewSearchResultStatus = { _tag: "available" }
const FAILED_RESULT_STATUS: ReviewSearchResultStatus = { _tag: "failed" }
const EXPIRED_RESULT_STATUS: ReviewSearchResultStatus = { _tag: "expired" }

/** Creates the detached model used by each fixed-count atom bundle. */
export const makeInitialReviewSearchModel = (): ReviewSearchModel => ({
  session: null,
  sessionEpoch: 0,
  queryEpoch: 0,
  moveEpoch: 0,
  open: false,
  query: "",
  anchor: null,
  resultStatus: IDLE_RESULT_STATUS,
  totalMatches: 0,
  desiredGlobalIndex: 0,
  activeGlobalIndex: 0,
  activeMatch: null,
  retainedMatches: [],
})

/** Applies one review-search command without performing cache, IPC, or navigation work. */
export const reduceReviewSearch = (
  model: ReviewSearchModel,
  command: ReviewSearchCommand,
): ReviewSearchCommandResult => {
  return Match.valueTags(command, {
    attach: (attach) =>
      commandResult({
        ...makeInitialReviewSearchModel(),
        session: attach.session,
        sessionEpoch: model.sessionEpoch + 1,
        queryEpoch: model.queryEpoch + 1,
        moveEpoch: model.moveEpoch + 1,
      }),
    replace: (replace) => {
      const next = resetResults({
        ...model,
        session: replace.session,
        sessionEpoch: model.sessionEpoch + 1,
        queryEpoch: model.queryEpoch + 1,
        moveEpoch: model.moveEpoch + 1,
      })
      return commandResult(
        next,
        next.open && next.query.length > 0 ? operationFor(next, "query", 0) : null,
      )
    },
    detach: () =>
      commandResult({
        ...makeInitialReviewSearchModel(),
        sessionEpoch: model.sessionEpoch + 1,
        queryEpoch: model.queryEpoch + 1,
        moveEpoch: model.moveEpoch + 1,
      }),
    open: (open) => {
      if (model.session === null) return staleCommand(model)
      const next = resetResults({
        ...model,
        open: true,
        anchor: open.anchor,
        queryEpoch: model.queryEpoch + 1,
        moveEpoch: model.moveEpoch + 1,
      })
      return commandResult(next, next.query.length === 0 ? null : operationFor(next, "query", 0))
    },
    close: () => {
      if (model.session === null) return staleCommand(model)
      return commandResult(
        resetResults({
          ...model,
          open: false,
          queryEpoch: model.queryEpoch + 1,
          moveEpoch: model.moveEpoch + 1,
        }),
      )
    },
    query: (query) => {
      if (model.session === null) return staleCommand(model)
      const next = resetResults({
        ...model,
        query: query.query,
        anchor: query.anchor === undefined ? model.anchor : query.anchor,
        queryEpoch: model.queryEpoch + 1,
        moveEpoch: model.moveEpoch + 1,
      })
      return commandResult(
        next,
        next.open && next.query.length > 0 ? operationFor(next, "query", 0) : null,
      )
    },
    move: (move) => {
      if (model.session === null || !model.open || model.totalMatches === 0) {
        return staleCommand(model)
      }
      const current = model.desiredGlobalIndex % model.totalMatches
      const targetIndex = (current + move.direction + model.totalMatches) % model.totalMatches
      const next = {
        ...model,
        desiredGlobalIndex: targetIndex,
        moveEpoch: model.moveEpoch + 1,
      }
      return commandResult(next, operationFor(next, "move", targetIndex))
    },
    results: (results) => {
      if (!sameOperationKey(model, results.key)) return staleCommand(model)
      return commandResult({
        ...model,
        resultStatus: AVAILABLE_RESULT_STATUS,
        totalMatches: results.totalMatches,
        retainedMatches: results.retainedMatches,
      })
    },
    activate: (activate) => {
      if (!sameOperationKey(model, activate.key)) return staleCommand(model)
      if (activate.index < 0 || activate.index >= model.totalMatches) return staleCommand(model)
      return commandResult(
        {
          ...model,
          desiredGlobalIndex: activate.index,
          activeGlobalIndex: activate.index,
          activeMatch: activate.match,
        },
        null,
        activate.match,
      )
    },
    failed: (failed) => {
      if (!sameOperationKey(model, failed.operation.key)) return staleCommand(model)
      return failed.operation.kind === "move"
        ? commandResult({ ...model, desiredGlobalIndex: model.activeGlobalIndex })
        : commandResult({
            ...resetResults(model),
            resultStatus: FAILED_RESULT_STATUS,
          })
    },
    expired: (expired) => {
      if (!sameOperationKey(model, expired.key)) return staleCommand(model)
      return commandResult({
        ...resetResults(model),
        resultStatus: EXPIRED_RESULT_STATUS,
      })
    },
  })
}

/** Coordinates revision-scoped atom commands with bounded cache, IPC, and navigation work. */
export class ReviewSearchController {
  readonly #registry: AtomRegistry.AtomRegistry
  readonly #cache = new ReviewSearchPageCache()
  readonly #modelAtom: Atom.Writable<ReviewSearchModel>
  readonly #commandAtom: Atom.Writable<ReviewSearchCommandResult, ReviewSearchCommand>
  readonly #releases: Array<() => void> = []
  #runtime: ReviewSearchRuntime | null = null
  #disposed = false

  /** Read-only toolbar state for the mounted review UI. */
  readonly toolbarAtom: Atom.Atom<ReviewSearchToolbarState>

  /** Read-only active match used for visibility, pinning, and highlights. */
  readonly activeMatchAtom: Atom.Atom<ReviewSnapshotSearchMatch | null>

  /** Read-only bounded match set retained by the private page cache. */
  readonly retainedMatchesAtom: Atom.Atom<readonly ReviewSnapshotSearchMatch[]>

  constructor(registry: AtomRegistry.AtomRegistry) {
    this.#registry = registry
    this.#modelAtom = Atom.make(makeInitialReviewSearchModel())
    const initialResult = commandResult(makeInitialReviewSearchModel())
    this.#commandAtom = Atom.fnSync(
      (command: ReviewSearchCommand, get) => {
        const result = reduceReviewSearch(get(this.#modelAtom), command)
        get.set(this.#modelAtom, result.model)
        return result
      },
      { initialValue: initialResult },
    )
    this.toolbarAtom = Atom.readable((get) => {
      const model = get(this.#modelAtom)
      return {
        open: model.open,
        query: model.query,
        resultStatus: model.resultStatus,
        totalMatches: model.totalMatches,
        activeGlobalIndex: model.activeGlobalIndex,
      }
    })
    this.activeMatchAtom = Atom.readable((get) => get(this.#modelAtom).activeMatch)
    this.retainedMatchesAtom = Atom.readable((get) => get(this.#modelAtom).retainedMatches)
  }

  /** Updates non-serializable capabilities without replacing the controller or atom bundle. */
  readonly updateRuntime = (runtime: ReviewSearchRuntime) => {
    this.#assertUsable()
    this.#runtime = runtime
  }

  /** Attaches an exact review snapshot and invalidates every older session operation. */
  readonly attach = (session: ReviewSnapshotAddress) => {
    this.#assertUsable()
    this.#mount()
    const current = this.#registry.get(this.#modelAtom).session
    const result = this.#dispatch(
      current !== null &&
        current.projectId === session.projectId &&
        current.snapshotId === session.snapshotId
        ? { _tag: "replace", session }
        : { _tag: "attach", session },
    )
    this.#cache.clear()
    this.#start(result.operation)
  }

  /** Detaches the current review and rejects all outstanding work. */
  readonly detach = () => {
    if (this.#disposed) return
    this.#dispatch({ _tag: "detach" })
    this.#cache.clear()
    this.#runtime?.navigator.cancelActiveForOrigins(["search-preview", "search-activation"])
  }

  /** Opens search with a newly captured immutable anchor while retaining the query. */
  readonly open = (anchor: ReviewSnapshotSearchFileAnchor | null) => {
    this.#assertUsable()
    const result = this.#dispatch({ _tag: "open", anchor })
    this.#cache.clear()
    this.#start(result.operation)
  }

  /** Closes search and cancels only navigation owned by the search surface. */
  readonly close = () => {
    if (this.#disposed) return
    this.#dispatch({ _tag: "close" })
    this.#cache.clear()
    this.#runtime?.navigator.cancelActiveForOrigins(["search-preview", "search-activation"])
  }

  /** Replaces the literal query and starts a latest-query-wins operation when eligible. */
  readonly setQuery = (query: string, anchor?: ReviewSnapshotSearchFileAnchor | null) => {
    this.#assertUsable()
    const result = this.#dispatch(
      anchor === undefined ? { _tag: "query", query } : { _tag: "query", query, anchor },
    )
    this.#cache.clear()
    this.#start(result.operation)
  }

  /** Moves with wraparound under latest-movement-wins ownership. */
  readonly move = (direction: -1 | 1) => {
    this.#assertUsable()
    this.#start(this.#dispatch({ _tag: "move", direction }).operation)
  }

  /** Releases cache and registry resources and terminally invalidates the controller. */
  readonly dispose = () => {
    if (this.#disposed) return
    this.detach()
    this.#disposed = true
    this.#runtime = null
    for (;;) {
      const release = this.#releases.pop()
      if (release === undefined) break
      try {
        release()
      } catch {
        // The owning React registry may already have completed delayed disposal.
      }
    }
  }

  readonly #start = (operation: ReviewSearchOperation | null) => {
    if (operation === null) return
    void this.#activateIndex(operation)
  }

  readonly #activateIndex = async (operation: ReviewSearchOperation) => {
    let cached = this.#findCurrent(operation, operation.targetIndex)
    if (cached !== null) {
      this.#activateMatch(operation, cached.page.cursor, cached.match)
      return
    }

    let cursor: ReviewSnapshotSearchCursor | null = null
    let startIndex = 0
    while (this.#isCurrent(operation.key)) {
      // Opaque cursors require replaying pages in order after bounded-cache eviction.
      // oxlint-disable-next-line eslint/no-await-in-loop
      const page = await this.#requestPage(cursor, startIndex, operation)
      if (page === null) return
      const pageEnd = page.startIndex + page.response.matches.length
      if (operation.targetIndex >= page.startIndex && operation.targetIndex < pageEnd) {
        cached = this.#findCurrent(operation, operation.targetIndex)
        if (cached !== null) this.#activateMatch(operation, cached.page.cursor, cached.match)
        else this.#fail(operation)
        return
      }
      if (page.response.totalMatches === 0 && operation.targetIndex === 0) return
      if (page.response.nextCursor === null || page.response.matches.length === 0) {
        this.#fail(operation)
        return
      }
      startIndex = pageEnd
      cursor = page.response.nextCursor
    }
  }

  readonly #requestPage = async (
    cursor: ReviewSnapshotSearchCursor | null,
    startIndex: number,
    operation: ReviewSearchOperation,
  ): Promise<ReviewSearchPage | null> => {
    if (!this.#isCurrent(operation.key)) return null
    const cached = this.#cache.get(cursor)
    if (cached !== null) return cached
    const runtime = this.#runtime
    const model = this.#registry.get(this.#modelAtom)
    if (runtime === null || model.session === null) {
      this.#fail(operation)
      return null
    }

    let response: typeof ReviewSnapshotSearchResponse.Type
    try {
      response = Schema.decodeUnknownSync(ReviewSnapshotSearchResponse)(
        await runtime.search(
          ReviewSnapshotSearchRequest.make({
            snapshotId: operation.key.snapshotId,
            query: model.query,
            cursor,
            limit: 200,
            anchor: model.anchor,
          }),
        ),
      )
    } catch {
      this.#fail(operation)
      return null
    }

    if (!this.#isCurrent(operation.key)) return null
    const availableResponse = Match.valueTags(response, {
      available: (available) => available,
      expired: () => null,
    })
    if (availableResponse === null) {
      const result = this.#dispatch({ _tag: "expired", key: operation.key })
      if (!result.stale) {
        this.#cache.clear()
        runtime.onSnapshotExpired()
      }
      return null
    }
    if (availableResponse.snapshotId !== operation.key.snapshotId) {
      this.#fail(operation)
      return null
    }

    const activeCursor = this.#cache.find(model.activeGlobalIndex)?.page.cursor
    const pinnedCursors = new Set<ReviewSnapshotSearchCursor | null>([cursor])
    if (activeCursor !== undefined) pinnedCursors.add(activeCursor)
    const page = { cursor, response: availableResponse, startIndex }
    try {
      if (!this.#cache.put(page, pinnedCursors)) {
        this.#fail(operation)
        return null
      }
    } catch {
      this.#fail(operation)
      return null
    }
    const retainedMatches = Object.freeze([...this.#cache.matches()])
    const result = this.#dispatch({
      _tag: "results",
      key: operation.key,
      totalMatches: availableResponse.totalMatches,
      retainedMatches,
    })
    return result.stale ? null : page
  }

  readonly #findCurrent = (operation: ReviewSearchOperation, index: number) => {
    if (!this.#isCurrent(operation.key)) return null
    return this.#cache.find(index)
  }

  readonly #activateMatch = (
    operation: ReviewSearchOperation,
    cursor: ReviewSnapshotSearchCursor | null,
    match: ReviewSnapshotSearchMatch,
  ) => {
    if (!this.#isCurrent(operation.key)) return
    this.#cache.get(cursor)
    const result = this.#dispatch({
      _tag: "activate",
      key: operation.key,
      index: operation.targetIndex,
      match,
    })
    if (result.activatedMatch !== null) this.#navigate(operation.key, result.activatedMatch)
  }

  readonly #navigate = (key: ReviewSearchOperationKey, match: ReviewSnapshotSearchMatch) => {
    const runtime = this.#runtime
    if (runtime === null || !this.#isCurrent(key)) return
    const side = match.side === "deletions" ? "old" : "new"
    const lineNumber = side === "old" ? match.oldLineNumber : match.newLineNumber
    if (lineNumber === null) return
    const start = ReviewLinePoint.make({
      hunkId: match.hunkId,
      hunkFingerprint: match.hunkFingerprint,
      side,
      lineNumber,
      column: match.start,
    })
    const end = ReviewLinePoint.make({ ...start, column: match.end })
    const target = Schema.decodeUnknownSync(RangeReviewNavigationTarget)({
      _tag: "range",
      fileId: match.fileId,
      start,
      end,
    })
    void runtime.navigator.navigate(
      ReviewNavigationInput.make({
        location: ReviewLocationV1.make({
          version: 1,
          snapshot: ReviewSnapshotAddress.make({
            projectId: key.projectId,
            snapshotId: key.snapshotId,
          }),
          target,
        }),
        behavior: ReviewNavigationBehavior.make({
          alignment: "nearest",
          focus: "preserve",
          selection: "preserve",
          visibility: "temporarily-reveal",
        }),
        origin: "search-preview",
      }),
    )
  }

  readonly #fail = (operation: ReviewSearchOperation) => {
    if (!this.#isCurrent(operation.key)) return
    const result = this.#dispatch({ _tag: "failed", operation })
    if (!result.stale && operation.kind === "query") this.#cache.clear()
  }

  readonly #isCurrent = (key: ReviewSearchOperationKey) =>
    sameOperationKey(this.#registry.get(this.#modelAtom), key)

  readonly #dispatch = (command: ReviewSearchCommand) => {
    this.#registry.set(this.#commandAtom, command)
    return this.#registry.get(this.#commandAtom)
  }

  readonly #mount = () => {
    if (this.#releases.length > 0) return
    this.#releases.push(
      this.#registry.mount(this.#modelAtom),
      this.#registry.mount(this.#commandAtom),
    )
  }

  readonly #assertUsable = () => {
    if (this.#disposed) throw new Error("ReviewSearchController is disposed")
  }
}

const resetResults = (model: ReviewSearchModel): ReviewSearchModel => ({
  ...model,
  resultStatus: model.open && model.query.length > 0 ? LOADING_RESULT_STATUS : IDLE_RESULT_STATUS,
  totalMatches: 0,
  desiredGlobalIndex: 0,
  activeGlobalIndex: 0,
  activeMatch: null,
  retainedMatches: [],
})

const operationFor = (
  model: ReviewSearchModel,
  kind: ReviewSearchOperation["kind"],
  targetIndex: number,
): ReviewSearchOperation => {
  if (model.session === null) throw new Error("Review search operation requires an active session")
  return {
    key: {
      projectId: model.session.projectId,
      snapshotId: model.session.snapshotId,
      sessionEpoch: model.sessionEpoch,
      queryEpoch: model.queryEpoch,
      moveEpoch: model.moveEpoch,
    },
    kind,
    targetIndex,
  }
}

const sameOperationKey = (model: ReviewSearchModel, key: ReviewSearchOperationKey) =>
  model.session !== null &&
  model.session.projectId === key.projectId &&
  model.session.snapshotId === key.snapshotId &&
  model.sessionEpoch === key.sessionEpoch &&
  model.queryEpoch === key.queryEpoch &&
  model.moveEpoch === key.moveEpoch

const commandResult = (
  model: ReviewSearchModel,
  operation: ReviewSearchOperation | null = null,
  activatedMatch: ReviewSnapshotSearchMatch | null = null,
): ReviewSearchCommandResult => ({ model, operation, activatedMatch, stale: false })

const staleCommand = (model: ReviewSearchModel): ReviewSearchCommandResult => ({
  model,
  operation: null,
  activatedMatch: null,
  stale: true,
})
