import {
  CoreReviewSessionId,
  CoreReviewSessionState,
  CoreReviewSessionStateVersion,
  type CoreReviewRangeRequest,
  type CoreReviewSessionFailure as CoreReviewSessionFailureType,
  type CoreReviewSessionIdentity,
  type CoreReviewSessionRequest,
  type OpenCoreReviewSessionRequest,
  CoreReviewSessionFailure,
} from "@diffdash/core-rpc/review-session"
import { CoreProgressiveReviewRpcs } from "@diffdash/core-rpc/review-session-rpc"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ReviewFileId, ReviewHunkId } from "@diffdash/domain/review-identity"
import type { SnapshotFilePlacement } from "@diffdash/persistence/snapshot-block-store"
import {
  Cause,
  Context,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect"

import {
  SnapshotRepository,
  type SnapshotRepositoryError,
  type SnapshotRepositoryIdentity,
  SnapshotRepositorySessionId,
} from "./services/snapshot-repository"
import {
  SnapshotSearch,
  type SnapshotSearchError,
  type SnapshotSearchFinal,
  type SnapshotSearchMatch,
  type SnapshotSearchProvisional,
} from "./services/snapshot-search"
import { CoreRuntimeServices } from "./core-runtime-services"
import { ReviewLifecycleDiagnostics } from "./review-lifecycle-diagnostics"

type ProgressiveMethod = CoreReviewSessionFailureType["method"]

/** Core authority that binds native RPC operations to one foreground snapshot generation. */
export class CoreProgressiveReviewService extends Context.Service<
  CoreProgressiveReviewService,
  {
    readonly open: (
      request: OpenCoreReviewSessionRequest,
    ) => Effect.Effect<typeof CoreReviewSessionState.Type, CoreReviewSessionFailureType>
    readonly current: (
      request: CoreReviewSessionRequest,
    ) => Effect.Effect<typeof CoreReviewSessionState.Type, CoreReviewSessionFailureType>
    readonly close: (
      request: CoreReviewSessionRequest,
    ) => Effect.Effect<typeof CoreReviewSessionState.Type, CoreReviewSessionFailureType>
  }
>()("@diffdash/core/CoreProgressiveReviewService") {}

/** Builds progressive review ownership while leaving repository and search adapters visible. */
export const coreProgressiveReviewServiceLayer = Layer.effect(
  CoreProgressiveReviewService,
  Effect.gen(function* () {
    const repository = yield* SnapshotRepository
    const diagnostics = yield* ReviewLifecycleDiagnostics
    const lock = yield* Semaphore.make(1)
    const active = yield* Ref.make<Option.Option<typeof CoreReviewSessionState.Type>>(Option.none())

    const open = Effect.fn("CoreProgressiveReviewService.open")(function* (
      request: OpenCoreReviewSessionRequest,
    ) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const previous = yield* Ref.get(active)
          if (Option.isSome(previous)) {
            const closed = yield* repository
              .closeSession(repositoryIdentity(request, previous.value.identity))
              .pipe(Effect.catch(() => Effect.succeed(false)))
            if (closed && !Schema.is(CoreReviewSessionState.cases.Disposed)(previous.value)) {
              yield* diagnostics.sessionDisposed(previous.value.identity.sessionId)
            }
          }
          yield* Ref.set(active, Option.none())
          const identity: CoreReviewSessionIdentity = {
            applicationInstanceId: request.applicationInstanceId,
            processEpoch: request.processEpoch,
            projectId: request.projectId,
            reviewKey: request.reviewKey,
            snapshotId: request.snapshotId,
            sessionId: CoreReviewSessionId.make(`session:${request.requestId}`),
            stateVersion: CoreReviewSessionStateVersion.make(1),
          }
          yield* repository
            .openSession(repositoryIdentity(request, identity))
            .pipe(
              Effect.mapError((error) => repositoryFailure("Reviews.openSession", request, error)),
            )
          const state = CoreReviewSessionState.cases.Ready.make({ identity })
          yield* Ref.set(active, Option.some(state))
          yield* diagnostics.sessionOpened(identity.sessionId)
          return state
        }),
      )
    })

    const readCurrent = Effect.fn("CoreProgressiveReviewService.current")(function* (
      request: CoreReviewSessionRequest,
    ) {
      const state = yield* requireActive(active, "Reviews.currentSession", request)
      return state
    })

    const close = Effect.fn("CoreProgressiveReviewService.close")(function* (
      request: CoreReviewSessionRequest,
    ) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const currentState = yield* Ref.get(active)
          if (Option.isNone(currentState) || !canClose(currentState.value, request.identity)) {
            return yield* Effect.fail(
              CoreReviewSessionFailure.make({
                ...requestContext(request),
                method: "Reviews.closeSession",
                code: Option.isSome(currentState)
                  ? "REVIEW_SESSION_SUPERSEDED"
                  : "REVIEW_SESSION_INVALID",
                retryClass: "automatic",
                safeMessage: "The progressive review session is no longer authoritative.",
              }),
            )
          }
          const state = currentState.value
          if (Schema.is(CoreReviewSessionState.cases.Disposed)(state)) return state
          const closed = yield* repository
            .closeSession(repositoryIdentity(request, state.identity))
            .pipe(
              Effect.mapError((error) => repositoryFailure("Reviews.closeSession", request, error)),
            )
          if (!closed) {
            return yield* Effect.fail(
              CoreReviewSessionFailure.make({
                ...requestContext(request),
                method: "Reviews.closeSession",
                code: "REVIEW_SESSION_SUPERSEDED",
                retryClass: "automatic",
                safeMessage: "The progressive review session is no longer authoritative.",
              }),
            )
          }
          const disposed = CoreReviewSessionState.cases.Disposed.make({
            identity: {
              ...state.identity,
              stateVersion: CoreReviewSessionStateVersion.make(state.identity.stateVersion + 1),
            },
            reason: "closed",
          })
          yield* Ref.set(active, Option.some(disposed))
          yield* diagnostics.sessionDisposed(state.identity.sessionId)
          return disposed
        }),
      )
    })

    return CoreProgressiveReviewService.of({ open, current: readCurrent, close })
  }),
)

/** Native handlers for progressive session ownership, bounded ranges, targets, and search. */
export const coreProgressiveReviewRpcHandlersLayer = CoreProgressiveReviewRpcs.toLayer(
  Effect.gen(function* () {
    const sessions = yield* CoreProgressiveReviewService
    const repository = yield* SnapshotRepository
    const search = yield* SnapshotSearch
    return {
      "Reviews.openSession": sessions.open,
      "Reviews.currentSession": sessions.current,
      "Reviews.closeSession": sessions.close,
      "Reviews.inventory": (request) =>
        sessions.current(request).pipe(
          Effect.flatMap((state) =>
            repository.inventory(
              repositoryIdentity(request, state.identity),
              request.offset,
              request.limit,
            ),
          ),
          Effect.map((page) => ({
            identity: request.identity,
            files: page.files.map(reviewFile),
            nextOffset: page.nextOffset,
          })),
          Effect.mapError((error) =>
            isPublicFailure(error) ? error : repositoryFailure("Reviews.inventory", request, error),
          ),
        ),
      "Ranges.read": (request) => range("Ranges.read", sessions, repository, request, false),
      "Ranges.wait": (request) => range("Ranges.wait", sessions, repository, request, true),
      "Navigation.resolveTarget": (request) =>
        sessions.current(request).pipe(
          Effect.flatMap((state) =>
            repository.resolveTarget(
              repositoryIdentity(request, state.identity),
              request.fileId,
              request.hunkId,
              request.line,
            ),
          ),
          Effect.map((target) => ({
            identity: request.identity,
            file: reviewFile(target.file),
            blockOrdinal: target.blockOrdinal,
            line: target.line,
          })),
          Effect.mapError((error) =>
            isPublicFailure(error)
              ? error
              : repositoryFailure("Navigation.resolveTarget", request, error),
          ),
        ),
      "Search.scan": (request) =>
        Stream.callback(
          (queue) =>
            sessions.current(request).pipe(
              Effect.flatMap((state) =>
                search.scan(
                  {
                    identity: repositoryIdentity(request, state.identity),
                    query: request.query,
                    anchorFileId: request.anchorFileId,
                    direction: request.direction,
                    cursor: request.cursor,
                    limit: request.limit,
                  },
                  (progress) => Queue.offer(queue, searchProvisional(request.identity, progress)),
                ),
              ),
              Effect.flatMap((result) => Queue.offer(queue, searchFinal(request.identity, result))),
              Effect.matchCauseEffect({
                onFailure: (cause) => {
                  const error = Cause.findErrorOption(cause)
                  return Option.match(error, {
                    onNone: () => Queue.fail(queue, sessionFailure("Search.scan", request)),
                    onSome: (value) =>
                      Queue.fail(
                        queue,
                        isPublicFailure(value)
                          ? value
                          : searchFailure("Search.scan", request, value),
                      ),
                  })
                },
                onSuccess: () => Queue.end(queue),
              }),
              Effect.forkScoped,
            ),
          { bufferSize: 2, strategy: "suspend" },
        ),
    }
  }),
)

/** Progressive handlers backed by authorities installed after ownership recovery. */
export const coreProgressiveReviewRpcHandlersWithRuntimeLayer =
  coreProgressiveReviewRpcHandlersLayer.pipe(
    Layer.provide(
      Layer.effectContext(
        Effect.gen(function* () {
          const runtime = yield* CoreRuntimeServices
          const sessions = CoreProgressiveReviewService.of({
            open: (request) =>
              runtime.progressiveReviews.pipe(
                Effect.flatMap((progressive) => progressive.sessions.open(request)),
              ),
            current: (request) =>
              runtime.progressiveReviews.pipe(
                Effect.flatMap((progressive) => progressive.sessions.current(request)),
              ),
            close: (request) =>
              runtime.progressiveReviews.pipe(
                Effect.flatMap((progressive) => progressive.sessions.close(request)),
              ),
          })
          const repository = SnapshotRepository.of({
            openSession: (identity) =>
              runtime.progressiveReviews.pipe(
                Effect.flatMap((progressive) => progressive.repository.openSession(identity)),
              ),
            closeSession: (identity) =>
              runtime.progressiveReviews.pipe(
                Effect.flatMap((progressive) => progressive.repository.closeSession(identity)),
              ),
            inventory: (identity, offset, limit) =>
              runtime.progressiveReviews.pipe(
                Effect.flatMap((progressive) =>
                  progressive.repository.inventory(identity, offset, limit),
                ),
              ),
            findFile: (identity, fileId) =>
              runtime.progressiveReviews.pipe(
                Effect.flatMap((progressive) => progressive.repository.findFile(identity, fileId)),
              ),
            findFileHunk: (identity, fileId, hunkId) =>
              runtime.progressiveReviews.pipe(
                Effect.flatMap((progressive) =>
                  progressive.repository.findFileHunk(identity, fileId, hunkId),
                ),
              ),
            resolveTarget: (identity, fileId, hunkId, line) =>
              runtime.progressiveReviews.pipe(
                Effect.flatMap((progressive) =>
                  progressive.repository.resolveTarget(identity, fileId, hunkId, line),
                ),
              ),
            waitForRange: (identity, fileId, startLine) =>
              runtime.progressiveReviews.pipe(
                Effect.flatMap((progressive) =>
                  progressive.repository.waitForRange(identity, fileId, startLine),
                ),
              ),
            readRange: (identity, fileId, startLine) =>
              runtime.progressiveReviews.pipe(
                Effect.flatMap((progressive) =>
                  progressive.repository.readRange(identity, fileId, startLine),
                ),
              ),
          })
          const search = SnapshotSearch.of({
            scan: (input, onProgress) =>
              runtime.progressiveReviews.pipe(
                Effect.flatMap((progressive) => progressive.search.scan(input, onProgress)),
              ),
          })
          return Context.empty().pipe(
            Context.add(CoreProgressiveReviewService, sessions),
            Context.add(SnapshotRepository, repository),
            Context.add(SnapshotSearch, search),
          )
        }),
      ),
    ),
  )

const requireActive = Effect.fn("CoreProgressiveReviewService.requireActive")(function* (
  active: Ref.Ref<Option.Option<typeof CoreReviewSessionState.Type>>,
  method: ProgressiveMethod,
  request: CoreReviewSessionRequest,
) {
  const current = yield* Ref.get(active)
  if (Option.isNone(current) || !sameIdentity(current.value.identity, request.identity)) {
    return yield* Effect.fail(
      CoreReviewSessionFailure.make({
        ...requestContext(request),
        method,
        code: Option.isSome(current) ? "REVIEW_SESSION_SUPERSEDED" : "REVIEW_SESSION_INVALID",
        retryClass: "automatic",
        safeMessage: "The progressive review session is no longer authoritative.",
      }),
    )
  }
  return current.value
})

const range = Effect.fn("CoreProgressiveReviewService.range")(function* (
  method: "Ranges.read" | "Ranges.wait",
  sessions: CoreProgressiveReviewService["Service"],
  repository: SnapshotRepository["Service"],
  request: CoreReviewRangeRequest,
  wait: boolean,
) {
  const state = yield* sessions.current(request)
  const read = wait ? repository.waitForRange : repository.readRange
  const result = yield* read(
    repositoryIdentity(request, state.identity),
    request.fileId,
    request.startLine,
  ).pipe(Effect.mapError((error) => repositoryFailure(method, request, error)))
  return {
    identity: request.identity,
    file: reviewFile(result.file),
    blocks: result.blocks.map((block) => ({
      id: block.id,
      hunkId: block.hunkId === null ? null : ReviewHunkId.make(block.hunkId),
      ordinal: block.ordinal,
      firstLine: block.firstLine,
      lineCount: block.lineCount,
      bytes: block.bytes,
    })),
    byteCount: result.byteCount,
    complete: result.complete,
  }
})

const repositoryIdentity = (
  request: Pick<CoreReviewSessionRequest, "applicationInstanceId" | "processEpoch" | "requestId">,
  identity: CoreReviewSessionIdentity,
): SnapshotRepositoryIdentity => ({
  applicationInstanceId: request.applicationInstanceId,
  processEpoch: request.processEpoch,
  requestId: request.requestId,
  projectId: identity.projectId,
  reviewKey: identity.reviewKey,
  snapshotId: identity.snapshotId,
  sessionId: SnapshotRepositorySessionId.make(identity.sessionId),
})

const reviewFile = (file: SnapshotFilePlacement) => ({
  ordinal: file.ordinal,
  fileId: ReviewFileId.make(file.fileId),
  path: RepositoryRelativePath.make(file.path),
  oldPath: file.oldPath === null ? null : RepositoryRelativePath.make(file.oldPath),
  additions: file.additions,
  deletions: file.deletions,
  status: file.status,
  visibility: file.visibility,
  patchHash: file.patchHash,
  hunkCount: file.hunkCount,
})

const searchMatch = (match: SnapshotSearchMatch) => ({
  ...match,
  filePath: RepositoryRelativePath.make(match.filePath),
})

const searchProvisional = (
  identity: CoreReviewSessionIdentity,
  progress: SnapshotSearchProvisional,
) => ({
  _tag: "Provisional" as const,
  identity,
  lowerBoundMatches: progress.lowerBoundMatches,
  matches: progress.matches.map(searchMatch),
  previousCursor: null,
  nextCursor: null,
  wrapped: false as const,
})

const searchFinal = (identity: CoreReviewSessionIdentity, result: SnapshotSearchFinal) => ({
  _tag: "Final" as const,
  identity,
  totalMatches: result.totalMatches,
  matches: result.matches.map(searchMatch),
  previousCursor: result.previousCursor,
  nextCursor: result.nextCursor,
  wrapped: result.wrapped,
})

const sameIdentity = (left: CoreReviewSessionIdentity, right: CoreReviewSessionIdentity): boolean =>
  left.applicationInstanceId === right.applicationInstanceId &&
  left.processEpoch === right.processEpoch &&
  left.projectId === right.projectId &&
  left.reviewKey === right.reviewKey &&
  left.snapshotId === right.snapshotId &&
  left.sessionId === right.sessionId &&
  left.stateVersion === right.stateVersion

const sameGeneration = (
  left: CoreReviewSessionIdentity,
  right: CoreReviewSessionIdentity,
): boolean =>
  left.applicationInstanceId === right.applicationInstanceId &&
  left.processEpoch === right.processEpoch &&
  left.projectId === right.projectId &&
  left.reviewKey === right.reviewKey &&
  left.snapshotId === right.snapshotId &&
  left.sessionId === right.sessionId

const canClose = (
  current: typeof CoreReviewSessionState.Type,
  requested: CoreReviewSessionIdentity,
): boolean =>
  sameIdentity(current.identity, requested) ||
  (Schema.is(CoreReviewSessionState.cases.Disposed)(current) &&
    sameGeneration(current.identity, requested) &&
    current.identity.stateVersion === requested.stateVersion + 1)

const repositoryFailure = (
  method: ProgressiveMethod,
  request: Pick<CoreReviewSessionRequest, "applicationInstanceId" | "processEpoch" | "requestId">,
  error: SnapshotRepositoryError,
): CoreReviewSessionFailureType =>
  CoreReviewSessionFailure.make({
    ...requestContext(request),
    method,
    code: repositoryFailureCode(error),
    retryClass: error.reason === "rangeLimit" ? "notRetryable" : "automatic",
    safeMessage: repositoryFailureMessage(error),
  })

const searchFailure = (
  method: "Search.scan",
  request: Pick<CoreReviewSessionRequest, "applicationInstanceId" | "processEpoch" | "requestId">,
  error: SnapshotSearchError,
): CoreReviewSessionFailureType =>
  CoreReviewSessionFailure.make({
    ...requestContext(request),
    method,
    code:
      error.reason === "invalidRequest"
        ? "REVIEW_SEARCH_INVALID"
        : error.reason === "invalidCursor"
          ? "REVIEW_SEARCH_CURSOR_INVALID"
          : error.reason === "superseded"
            ? "REVIEW_SEARCH_SUPERSEDED"
            : "REVIEW_SOURCE_UNAVAILABLE",
    retryClass: error.reason === "invalidRequest" ? "notRetryable" : "automatic",
    safeMessage:
      error.reason === "invalidCursor"
        ? "The search cursor belongs to another query or snapshot."
        : error.reason === "superseded"
          ? "The search was superseded by a newer query."
          : error.reason === "invalidRequest"
            ? "The search request is outside its fixed-space limits."
            : "Committed review content is temporarily unavailable.",
  })

const sessionFailure = (
  method: ProgressiveMethod,
  request: Pick<CoreReviewSessionRequest, "applicationInstanceId" | "processEpoch" | "requestId">,
): CoreReviewSessionFailureType =>
  CoreReviewSessionFailure.make({
    ...requestContext(request),
    method,
    code: "REVIEW_SESSION_INTERNAL_ERROR",
    retryClass: "notRetryable",
    safeMessage: "DiffDash Core encountered an internal progressive review error.",
  })

const requestContext = (
  request: Pick<CoreReviewSessionRequest, "applicationInstanceId" | "processEpoch" | "requestId">,
) => ({
  applicationInstanceId: request.applicationInstanceId,
  processEpoch: request.processEpoch,
  requestId: request.requestId,
})

const repositoryFailureCode = (
  error: SnapshotRepositoryError,
): CoreReviewSessionFailureType["code"] =>
  (
    ({
      identityRejected: "REVIEW_SESSION_INVALID",
      superseded: "REVIEW_SESSION_SUPERSEDED",
      notFound: "REVIEW_SNAPSHOT_NOT_FOUND",
      rangeLimit: "REVIEW_RANGE_LIMIT",
      quotaExceeded: "REVIEW_RESOURCE_QUOTA",
      sourceUnavailable: "REVIEW_SOURCE_UNAVAILABLE",
    }) as const
  )[error.reason]

const repositoryFailureMessage = (error: SnapshotRepositoryError): string =>
  ({
    identityRejected: "The progressive review session is no longer authoritative.",
    superseded: "The progressive review session is no longer authoritative.",
    notFound: "The requested committed review content was not found.",
    rangeLimit: "The requested review range is outside its bounded limits.",
    quotaExceeded: "DiffDash cannot reserve space for this committed review range.",
    sourceUnavailable: "Committed review content is temporarily unavailable.",
  })[error.reason]

const isPublicFailure = <Value>(value: Value): value is Value & CoreReviewSessionFailureType =>
  Schema.is(CoreReviewSessionFailure)(value)
