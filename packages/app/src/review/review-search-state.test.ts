/* oxlint-disable eslint/no-underscore-dangle -- Tests assert Effect-compatible _tag discriminants. */
import {
  CompletedReviewNavigationOutcome,
  ReviewNavigationRequestId,
  ReviewSnapshotAddress,
} from "@diffdash/domain/review-navigation"
import {
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewProjectId,
  ReviewKey,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  ReviewSnapshotSearchAvailable,
  ReviewSnapshotSearchCursor,
  ReviewSnapshotSearchFileAnchor,
  ReviewSnapshotSearchMatch,
  ReviewSnapshotSearchMatchId,
  type ReviewSnapshotSearchResponse,
} from "@diffdash/protocol/review-snapshot"
import { AtomRegistry } from "effect/unstable/reactivity"
import { afterEach, describe, expect, it, vi } from "@effect/vitest"

import {
  makeInitialReviewSearchModel,
  reduceReviewSearch,
  ReviewSearchController,
  type ReviewSearchRuntime,
} from "./review-search-state"

const projectId = ReviewProjectId.make("github:fungsi/diffdash")
const snapshotId = ReviewSnapshotId.make("snapshot:v1:11111111111111111111111111111111")
const replacementSnapshotId = ReviewSnapshotId.make("snapshot:v1:22222222222222222222222222222222")
const address = ReviewSnapshotAddress.make({ projectId, snapshotId })
const replacementAddress = ReviewSnapshotAddress.make({
  projectId,
  snapshotId: replacementSnapshotId,
})

const makeMatch = (query: string, globalIndex: number) =>
  ReviewSnapshotSearchMatch.make({
    id: ReviewSnapshotSearchMatchId.make(`${query}-${globalIndex}`),
    fileId: ReviewFileId.make(`file:${query}:${globalIndex}`),
    filePath: RepositoryRelativePath.make(`src/${query}-${globalIndex}.ts`),
    reviewKey: ReviewKey.make(`review:${query}:${globalIndex}`),
    hunkId: ReviewHunkId.make(`hunk:${query}:${globalIndex}`),
    hunkFingerprint: ReviewHunkFingerprint.make(`fingerprint:${query}:${globalIndex}`),
    hunkLineIndex: globalIndex,
    newLineNumber: globalIndex + 1,
    oldLineNumber: null,
    side: "additions",
    text: `${query} ${globalIndex}`,
    start: 0,
    end: query.length,
  })

const makeAvailable = ({
  query,
  start = 0,
  count = 1,
  total = count,
  responseSnapshotId = snapshotId,
}: {
  readonly query: string
  readonly start?: number
  readonly count?: number
  readonly total?: number
  readonly responseSnapshotId?: ReviewSnapshotId
}) => {
  const end = start + count
  return ReviewSnapshotSearchAvailable.make({
    snapshotId: responseSnapshotId,
    matches: Array.from({ length: count }, (_, index) => makeMatch(query, start + index)),
    totalMatches: total,
    nextCursor: end < total ? ReviewSnapshotSearchCursor.make(`search:v1:${end}:00000000`) : null,
  })
}

const deferred = <Value>() => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

const registries: AtomRegistry.AtomRegistry[] = []
const controllers: ReviewSearchController[] = []

const makeRuntime = (search: ReviewSearchRuntime["search"]) => {
  let requestId = 0
  const navigate = vi.fn<ReviewSearchRuntime["navigator"]["navigate"]>(async () => {
    requestId += 1
    return CompletedReviewNavigationOutcome.make({
      requestId: ReviewNavigationRequestId.make(requestId),
      achieved: "revealed",
    })
  })
  const cancelActiveForOrigins = vi.fn<ReviewSearchRuntime["navigator"]["cancelActiveForOrigins"]>(
    () => false,
  )
  return {
    search,
    navigator: { navigate, cancelActiveForOrigins },
    onSnapshotExpired: vi.fn<() => void>(),
  } satisfies ReviewSearchRuntime
}

const requireOperation = (
  result: ReturnType<typeof reduceReviewSearch>,
): NonNullable<ReturnType<typeof reduceReviewSearch>["operation"]> => {
  if (result.operation === null) throw new Error("Expected an accepted search operation")
  return result.operation
}

const makeController = (runtime: ReviewSearchRuntime, session = address) => {
  const registry = AtomRegistry.make()
  const controller = new ReviewSearchController(registry)
  registries.push(registry)
  controllers.push(controller)
  controller.updateRuntime(runtime)
  controller.attach(session)
  controller.open(null)
  return { controller, registry }
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  for (const registry of registries.splice(0)) registry.dispose()
})

describe("reduceReviewSearch", () => {
  it("rejects stale query and movement epochs", () => {
    const attached = reduceReviewSearch(makeInitialReviewSearchModel(), {
      _tag: "attach",
      session: address,
    }).model
    const opened = reduceReviewSearch(attached, { _tag: "open", anchor: null }).model
    const firstQuery = reduceReviewSearch(opened, { _tag: "query", query: "first" })
    const secondQuery = reduceReviewSearch(firstQuery.model, { _tag: "query", query: "second" })
    const firstMatch = makeMatch("first", 0)

    const staleQuery = reduceReviewSearch(secondQuery.model, {
      _tag: "results",
      key: requireOperation(firstQuery).key,
      totalMatches: 1,
      retainedMatches: [firstMatch],
    })

    expect(staleQuery.stale).toBe(true)
    expect(staleQuery.model.query).toBe("second")

    const secondMatch = makeMatch("second", 0)
    const available = reduceReviewSearch(secondQuery.model, {
      _tag: "results",
      key: requireOperation(secondQuery).key,
      totalMatches: 2,
      retainedMatches: [secondMatch],
    }).model
    const active = reduceReviewSearch(available, {
      _tag: "activate",
      key: requireOperation(secondQuery).key,
      index: 0,
      match: secondMatch,
    }).model
    const firstMove = reduceReviewSearch(active, { _tag: "move", direction: 1 })
    const secondMove = reduceReviewSearch(firstMove.model, { _tag: "move", direction: 1 })
    const staleMove = reduceReviewSearch(secondMove.model, {
      _tag: "activate",
      key: requireOperation(firstMove).key,
      index: 1,
      match: makeMatch("second", 1),
    })

    expect(staleMove.stale).toBe(true)
    expect(staleMove.model.desiredGlobalIndex).toBe(0)
    expect(staleMove.model.activeGlobalIndex).toBe(0)
  })
})

describe("ReviewSearchController", () => {
  it("FUN-213 AC: accepts only the latest query response", async () => {
    const oldResponse = deferred<ReviewSnapshotSearchResponse>()
    const newResponse = deferred<ReviewSnapshotSearchResponse>()
    const runtime = makeRuntime((request) =>
      request.query === "old" ? oldResponse.promise : newResponse.promise,
    )
    const { controller, registry } = makeController(runtime)

    controller.setQuery("old")
    controller.setQuery("new")
    newResponse.resolve(makeAvailable({ query: "new" }))
    await vi.waitFor(() => {
      expect(registry.get(controller.activeMatchAtom)?.id).toBe("new-0")
    })
    oldResponse.resolve(makeAvailable({ query: "old" }))
    await Promise.resolve()

    expect(registry.get(controller.toolbarAtom)).toMatchObject({
      query: "new",
      totalMatches: 1,
      activeGlobalIndex: 0,
    })
    expect(registry.get(controller.retainedMatchesAtom).map((match) => match.id)).toEqual(["new-0"])
    expect(runtime.navigator.navigate).toHaveBeenCalledTimes(1)
  })

  it("FUN-213 AC: latest movement wins over a delayed cursor replay", async () => {
    const continuation = deferred<ReviewSnapshotSearchResponse>()
    const runtime = makeRuntime((request) =>
      request.cursor === null
        ? Promise.resolve(makeAvailable({ query: request.query, count: 200, total: 201 }))
        : continuation.promise,
    )
    const { controller, registry } = makeController(runtime)
    controller.setQuery("needle")
    await vi.waitFor(() => {
      expect(registry.get(controller.toolbarAtom).totalMatches).toBe(201)
    })

    controller.move(-1)
    controller.move(1)
    await vi.waitFor(() => {
      expect(registry.get(controller.toolbarAtom).activeGlobalIndex).toBe(0)
    })
    continuation.resolve(makeAvailable({ query: "needle", start: 200, count: 1, total: 201 }))
    await Promise.resolve()

    expect(registry.get(controller.toolbarAtom).activeGlobalIndex).toBe(0)
    expect(registry.get(controller.retainedMatchesAtom)).toHaveLength(200)
    expect(runtime.navigator.navigate).toHaveBeenCalledTimes(2)
  })

  it("FUN-213 AC: invalidates pending work when the review session is replaced", async () => {
    const oldResponse = deferred<ReviewSnapshotSearchResponse>()
    const runtime = makeRuntime((request) =>
      request.snapshotId === snapshotId
        ? oldResponse.promise
        : Promise.resolve(
            makeAvailable({
              query: request.query,
              responseSnapshotId: replacementSnapshotId,
            }),
          ),
    )
    const { controller, registry } = makeController(runtime)
    controller.setQuery("old")

    controller.attach(replacementAddress)
    controller.open(null)
    controller.setQuery("new")
    await vi.waitFor(() => {
      expect(registry.get(controller.activeMatchAtom)?.id).toBe("new-0")
    })
    oldResponse.resolve(makeAvailable({ query: "old" }))
    await Promise.resolve()

    expect(registry.get(controller.toolbarAtom).query).toBe("new")
    expect(registry.get(controller.retainedMatchesAtom).map((match) => match.id)).toEqual(["new-0"])
  })

  it("preserves an open query while invalidating same-address manifest work", async () => {
    const oldResponse = deferred<ReviewSnapshotSearchResponse>()
    let requestCount = 0
    const runtime = makeRuntime((request) => {
      requestCount += 1
      return requestCount === 1
        ? oldResponse.promise
        : Promise.resolve(makeAvailable({ query: request.query }))
    })
    const { controller, registry } = makeController(runtime)
    controller.setQuery("retained")

    controller.attach(address)
    await vi.waitFor(() => {
      expect(registry.get(controller.activeMatchAtom)?.id).toBe("retained-0")
    })
    oldResponse.resolve(makeAvailable({ query: "stale" }))
    await Promise.resolve()

    expect(registry.get(controller.toolbarAtom)).toMatchObject({
      open: true,
      query: "retained",
      totalMatches: 1,
    })
    expect(registry.get(controller.retainedMatchesAtom).map((match) => match.id)).toEqual([
      "retained-0",
    ])
    expect(runtime.navigator.navigate).toHaveBeenCalledTimes(1)
  })

  it("retains the query across close and recaptures the anchor on reopen", async () => {
    const search = vi.fn<ReviewSearchRuntime["search"]>((request) =>
      Promise.resolve(makeAvailable({ query: request.query })),
    )
    const runtime = makeRuntime(search)
    const { controller, registry } = makeController(runtime)
    controller.setQuery("retained")
    await vi.waitFor(() => expect(registry.get(controller.activeMatchAtom)).not.toBeNull())

    controller.close()
    expect(registry.get(controller.toolbarAtom)).toMatchObject({
      open: false,
      query: "retained",
      totalMatches: 0,
    })
    const anchor = ReviewSnapshotSearchFileAnchor.make({
      fileId: ReviewFileId.make("file:reopened-anchor"),
    })
    controller.open(anchor)
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2))

    expect(search.mock.calls[1]?.[0]).toMatchObject({ query: "retained", anchor })
  })

  it("FUN-213 AC: disposal rejects late responses and terminally closes the controller", async () => {
    const response = deferred<ReviewSnapshotSearchResponse>()
    const runtime = makeRuntime(() => response.promise)
    const { controller, registry } = makeController(runtime)
    controller.setQuery("late")

    controller.dispose()
    response.resolve(makeAvailable({ query: "late" }))
    await Promise.resolve()

    expect(registry.get(controller.toolbarAtom)).toMatchObject({ open: false, query: "" })
    expect(registry.get(controller.retainedMatchesAtom)).toEqual([])
    expect(runtime.navigator.navigate).not.toHaveBeenCalled()
    expect(() => controller.setQuery("again")).toThrow("ReviewSearchController is disposed")
  })

  it("FUN-213 AC: isolates fixed atom bundles inside one registry", async () => {
    const registry = AtomRegistry.make()
    registries.push(registry)
    const firstRuntime = makeRuntime((request) =>
      Promise.resolve(makeAvailable({ query: request.query })),
    )
    const secondRuntime = makeRuntime((request) =>
      Promise.resolve(
        makeAvailable({ query: request.query, responseSnapshotId: replacementSnapshotId }),
      ),
    )
    const first = new ReviewSearchController(registry)
    const second = new ReviewSearchController(registry)
    controllers.push(first, second)
    first.updateRuntime(firstRuntime)
    second.updateRuntime(secondRuntime)
    first.attach(address)
    second.attach(replacementAddress)
    first.open(null)
    second.open(null)

    first.setQuery("first")
    await vi.waitFor(() => expect(registry.get(first.activeMatchAtom)?.id).toBe("first-0"))

    expect(registry.get(second.toolbarAtom)).toMatchObject({ query: "", totalMatches: 0 })
    expect(registry.get(second.activeMatchAtom)).toBeNull()
    expect(secondRuntime.navigator.navigate).not.toHaveBeenCalled()
  })

  it("FUN-213 AC: rejects an available response for a different snapshot", async () => {
    const runtime = makeRuntime((request) =>
      Promise.resolve(
        makeAvailable({
          query: request.query,
          responseSnapshotId: ReviewSnapshotId.make("snapshot:v1:33333333333333333333333333333333"),
        }),
      ),
    )
    const { controller, registry } = makeController(runtime)

    controller.setQuery("mismatch")
    await vi.waitFor(() => {
      expect(registry.get(controller.toolbarAtom).resultStatus._tag).toBe("failed")
    })

    expect(registry.get(controller.toolbarAtom).totalMatches).toBe(0)
    expect(registry.get(controller.activeMatchAtom)).toBeNull()
    expect(registry.get(controller.retainedMatchesAtom)).toEqual([])
    expect(runtime.navigator.navigate).not.toHaveBeenCalled()
  })

  it("cancels only search-owned navigation when closing", () => {
    const runtime = makeRuntime((request) =>
      Promise.resolve(makeAvailable({ query: request.query })),
    )
    const { controller } = makeController(runtime)

    controller.close()

    expect(runtime.navigator.cancelActiveForOrigins).toHaveBeenCalledWith([
      "search-preview",
      "search-activation",
    ])
  })
})
