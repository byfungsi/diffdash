import { randomUUID } from "node:crypto"
import { RepositorySearchRequest } from "@diffdash/domain/repository"
import {
  makeRepositoryComparisonReviewKey,
  type RepositoryComparisonTarget,
} from "@diffdash/domain/repository-comparison"
import { makeReviewSnapshotManifest, type ReviewSnapshot } from "@diffdash/domain/review-context"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { isReviewAnchorInParsedDiff, type ReviewThreadTarget } from "@diffdash/domain/review-thread"
import {
  prepareWalkthroughPromptInput,
  type StoredWalkthrough,
  WALKTHROUGH_PROMPT_VERSION,
  walkthroughHostedReviewScope,
  walkthroughLocalDiffScope,
  walkthroughRepositoryComparisonScope,
} from "@diffdash/domain/walkthrough"
import { GitService } from "@diffdash/local-git/local-git"
import { ProjectWorkspaceStore } from "@diffdash/persistence/project-workspace-store"
import { ReviewThreadStore } from "@diffdash/persistence/review-thread-store"
import { ReviewTurnStore, type ReviewTurnStoreError } from "@diffdash/persistence/review-turn-store"
import { ViewedFileStore } from "@diffdash/persistence/viewed-file-store"
import { WalkthroughStore } from "@diffdash/persistence/walkthrough-store"
import {
  REVIEW_SNAPSHOT_PAGE_MAX_BYTES,
  REVIEW_SNAPSHOT_SEARCH_MAX_BYTES,
  ReviewSnapshotExpired,
  ResolvedRepositoryComparison,
} from "@diffdash/protocol/review-snapshot"
import { transportError } from "@diffdash/protocol/transport-error"
import { ReviewAgentService } from "@diffdash/review-agent"
import { ReviewThreadAnchorMapper } from "@diffdash/review-agent/anchor-mapper"
import { AppSettings } from "@diffdash/settings/app-settings"
import { AppState } from "@diffdash/settings/app-state"
import { WalkthroughService } from "@diffdash/walkthrough"
import { Cause, Context, Deferred, Effect, Exit, FiberMap, Layer, Option } from "effect"
import {
  CoreMethod,
  type CoreMethod as CoreMethodType,
  type CoreGetStoredWalkthroughFailure,
  type CoreMethodInput,
  type CoreOperationFailure,
  type CoreOperationOptions,
  type CoreOperationOutput,
  type CoreWalkthroughFailure,
  type GetStoredWalkthrough,
  type StartWalkthroughOperation,
  type WalkthroughOperationAccepted,
  WalkthroughOperationCapacityExceeded,
  WalkthroughOperationId,
  type WalkthroughOperationId as WalkthroughOperationIdType,
  WalkthroughOperationNotFound,
  type WalkthroughOperationResult,
} from "./core"
import { CoreAbsolutePath, CoreWebUrl } from "./core-configuration"
import { AgentProviders } from "./services/agent-providers"
import { Analytics } from "./services/analytics"
import { GitProvider } from "./services/git-provider"
import { Prerequisites } from "./services/prerequisites"
import { RepositoryComparisonSource } from "./services/repository-comparison-source"
import { RepositoryLinker } from "./services/repository-linker"
import { ReviewSnapshotService } from "./services/review-snapshot"
import { paginateReviewSnapshot, searchReviewSnapshot } from "./services/review-snapshot-pagination"

interface CoreOperationServiceShape {
  readonly start: Effect.Effect<void, ReviewTurnStoreError>
  readonly execute: <Method extends CoreMethodType>(
    method: Method,
    input: CoreMethodInput<Method>,
    options?: CoreOperationOptions,
  ) => Effect.Effect<CoreOperationOutput<Method>, CoreOperationFailure<Method>>
  readonly walkthroughs: {
    readonly start: (
      request: StartWalkthroughOperation,
    ) => Effect.Effect<WalkthroughOperationAccepted, WalkthroughOperationCapacityExceeded>
    readonly getOperation: (
      operationId: WalkthroughOperationIdType,
    ) => Effect.Effect<WalkthroughOperationResult, WalkthroughOperationNotFound>
    readonly cancel: (
      operationId: WalkthroughOperationIdType,
    ) => Effect.Effect<WalkthroughOperationResult, WalkthroughOperationNotFound>
    readonly getStored: (
      request: GetStoredWalkthrough,
    ) => Effect.Effect<StoredWalkthrough | null, CoreGetStoredWalkthroughFailure>
  }
}

/** Internal authority that exposes only cohesive Core operations to the embedded runtime. */
export class CoreOperationService extends Context.Tag("@diffdash/CoreOperationService")<
  CoreOperationService,
  CoreOperationServiceShape
>() {}

interface WalkthroughEntry {
  readonly result: Deferred.Deferred<WalkthroughOperationResult>
}

const MAX_RETAINED_WALKTHROUGH_OPERATIONS = 64

type OperationHandler<Method extends CoreMethodType> = (
  input: CoreMethodInput<Method>,
  options: CoreOperationOptions,
) => Effect.Effect<CoreOperationOutput<Method>, CoreOperationFailure<Method>>

type OperationHandlers = {
  readonly [Method in CoreMethodType]: OperationHandler<Method>
}

/** Builds the closed Core operation surface from internal business services. */
export const coreOperationLayer = Layer.scoped(
  CoreOperationService,
  Effect.gen(function* () {
    const agentProviders = yield* AgentProviders
    const analytics = yield* Analytics
    const appSettings = yield* AppSettings
    const appState = yield* AppState
    const comparisons = yield* RepositoryComparisonSource
    const git = yield* GitService
    const gitProvider = yield* GitProvider
    const prerequisites = yield* Prerequisites
    const projectWorkspace = yield* ProjectWorkspaceStore
    const repositories = yield* RepositoryLinker
    const reviewAgents = yield* ReviewAgentService
    const snapshots = yield* ReviewSnapshotService
    const threadMapper = yield* ReviewThreadAnchorMapper
    const threads = yield* ReviewThreadStore
    const turns = yield* ReviewTurnStore
    const viewedFiles = yield* ViewedFileStore
    const walkthroughService = yield* WalkthroughService
    const walkthroughStore = yield* WalkthroughStore
    const walkthroughFibers = yield* FiberMap.make<WalkthroughOperationIdType>()
    const walkthroughOperations = new Map<WalkthroughOperationIdType, WalkthroughEntry>()
    const walkthroughStartSemaphore = yield* Effect.makeSemaphore(1)

    const resolveThreadReview = Effect.fn("Core.resolveThreadReview")(function* (
      target: ReviewThreadTarget,
    ) {
      if (target.kind === "hosted") {
        const snapshot = yield* snapshots.acquireHosted(target.review)
        const repo = yield* repositories.ensureHosted(target.review.repository)
        return { repo, snapshot, prNumber: target.review.number } as const
      }
      if (target.kind === "repositoryComparison") {
        const snapshot = yield* snapshots.acquireComparison(target)
        const repo = yield* comparisons.repository(target)
        return { repo, snapshot, prNumber: null } as const
      }

      const snapshot = yield* snapshots.acquireLocal(target)
      const repo = yield* repositories.ensureLocal(snapshot.detail.rootPath)
      return { repo, snapshot, prNumber: null } as const
    })

    const getStoredWalkthrough: (
      request: GetStoredWalkthrough,
    ) => Effect.Effect<StoredWalkthrough | null, CoreGetStoredWalkthroughFailure> = Effect.fn(
      "Core.Walkthroughs.getStored",
    )(function* (request) {
      const { repo, snapshot } = yield* resolveThreadReview(request.target)
      if (
        (request.expectedBaseRevision !== null &&
          snapshot.baseRevision !== request.expectedBaseRevision) ||
        (request.expectedHeadRevision !== null &&
          snapshot.headRevision !== request.expectedHeadRevision)
      ) {
        return null
      }
      return yield* walkthroughStore.get(walkthroughCacheKey(repo.id, snapshot))
    })

    const generateWalkthrough: (
      request: StartWalkthroughOperation,
    ) => Effect.Effect<StoredWalkthrough, CoreWalkthroughFailure> = Effect.fn(
      "Core.Walkthroughs.generate",
    )(function* (request) {
      const target = request.target
      if (target.kind === "hosted") {
        const snapshot = yield* snapshots.acquireHosted(target.review)
        const repo = yield* repositories.ensureHosted(target.review.repository)
        const cacheKey = walkthroughCacheKey(repo.id, snapshot)
        if (!request.regenerate) {
          const cached = yield* walkthroughStore.get(cacheKey)
          if (cached !== null) return cached
        }
        const promptInput = yield* prepareWalkthroughPromptInput(
          snapshot.parsedDiff.files,
          walkthroughHostedReviewScope(target.review),
        )
        const walkthrough = yield* walkthroughService.generate({
          review: { kind: "hosted", hostedReview: snapshot.detail },
          diff: promptInput.diff,
          hunkDigest: promptInput.hunkDigest,
          changedFileTree: promptInput.changedFileTree,
          generation: promptInput.generation,
          promptStats: promptInput.stats,
        })
        return yield* walkthroughStore.save({
          ...cacheKey,
          prNumber: target.review.number,
          walkthrough,
        })
      }

      if (target.kind === "repositoryComparison") {
        const snapshot = yield* snapshots.acquireComparison(target)
        const repo = yield* comparisons.repository(target)
        const cacheKey = walkthroughCacheKey(repo.id, snapshot)
        if (!request.regenerate) {
          const cached = yield* walkthroughStore.get(cacheKey)
          if (cached !== null) return cached
        }
        const promptInput = yield* prepareWalkthroughPromptInput(
          snapshot.parsedDiff.files,
          walkthroughRepositoryComparisonScope(snapshot.reviewKey),
        )
        const walkthrough = yield* comparisons.useWorkspace(target, (workingDirectory) =>
          walkthroughService.generate({
            review: { kind: "repositoryComparison", comparison: snapshot.detail },
            diff: promptInput.diff,
            hunkDigest: promptInput.hunkDigest,
            changedFileTree: promptInput.changedFileTree,
            generation: promptInput.generation,
            promptStats: promptInput.stats,
            workingDirectory,
          }),
        )
        return yield* walkthroughStore.save({ ...cacheKey, prNumber: null, walkthrough })
      }

      const snapshot = yield* snapshots.acquireLocal(target)
      const repo = yield* repositories.ensureLocal(snapshot.detail.rootPath)
      const cacheKey = walkthroughCacheKey(repo.id, snapshot)
      if (!request.regenerate) {
        const cached = yield* walkthroughStore.get(cacheKey)
        if (cached !== null) return cached
      }
      const promptInput = yield* prepareWalkthroughPromptInput(
        snapshot.parsedDiff.files,
        walkthroughLocalDiffScope(snapshot.headRevision),
      )
      const walkthrough = yield* walkthroughService.generate({
        review: { kind: "localDiff", localReview: snapshot.detail },
        diff: promptInput.diff,
        hunkDigest: promptInput.hunkDigest,
        changedFileTree: promptInput.changedFileTree,
        generation: promptInput.generation,
        promptStats: promptInput.stats,
      })
      return yield* walkthroughStore.save({ ...cacheKey, prNumber: null, walkthrough })
    })

    const startWalkthrough = Effect.fn("Core.Walkthroughs.start")(
      (request: StartWalkthroughOperation) =>
        walkthroughStartSemaphore.withPermits(1)(
          Effect.gen(function* () {
            if (walkthroughOperations.size >= MAX_RETAINED_WALKTHROUGH_OPERATIONS) {
              let oldestTerminalId: WalkthroughOperationIdType | undefined
              for (const [operationId, operation] of walkthroughOperations) {
                if (!(yield* Deferred.isDone(operation.result))) continue
                oldestTerminalId = operationId
                break
              }
              if (oldestTerminalId === undefined) {
                return yield* WalkthroughOperationCapacityExceeded.make({
                  capacity: MAX_RETAINED_WALKTHROUGH_OPERATIONS,
                  message: `DiffDash already retains ${MAX_RETAINED_WALKTHROUGH_OPERATIONS} active walkthrough operations.`,
                })
              }
              walkthroughOperations.delete(oldestTerminalId)
            }
            const operationId = WalkthroughOperationId.make(randomUUID())
            const result = yield* Deferred.make<WalkthroughOperationResult>()
            walkthroughOperations.set(operationId, { result })
            const complete = (terminal: WalkthroughOperationResult) =>
              Deferred.succeed(result, terminal).pipe(Effect.asVoid)
            yield* FiberMap.run(
              walkthroughFibers,
              operationId,
              Effect.exit(generateWalkthrough(request)).pipe(
                Effect.flatMap((exit) => {
                  return complete(walkthroughTerminalFromExit(exit))
                }),
                Effect.onInterrupt(() => complete({ _tag: "cancelled" })),
                Effect.asVoid,
              ),
            )
            return { operationId }
          }),
        ),
    )

    const getWalkthroughOperation = Effect.fn("Core.Walkthroughs.getOperation")(function* (
      operationId: WalkthroughOperationIdType,
    ) {
      const operation = walkthroughOperations.get(operationId)
      if (operation === undefined) return yield* WalkthroughOperationNotFound.make({ operationId })
      return yield* Deferred.await(operation.result)
    })

    const cancelWalkthrough = Effect.fn("Core.Walkthroughs.cancel")(function* (
      operationId: WalkthroughOperationIdType,
    ) {
      const operation = walkthroughOperations.get(operationId)
      if (operation === undefined) return yield* WalkthroughOperationNotFound.make({ operationId })
      yield* FiberMap.remove(walkthroughFibers, operationId)
      return yield* Deferred.await(operation.result)
    })

    const handlers = {
      [CoreMethod.analyticsCapture]: ({ event }) => analytics.capture(event),
      [CoreMethod.analyticsStart]: () => analytics.start,
      [CoreMethod.agentProvidersGetCatalog]: () => agentProviders.catalog,
      [CoreMethod.appDiagnostics]: () => prerequisites.get,
      [CoreMethod.appInstallDiffDashCli]: () => prerequisites.installDiffDashCli,
      [CoreMethod.appOpenLocalRepositoryFile]: ({ rootPath, filePath }) =>
        git.detectRoot(rootPath).pipe(
          Effect.map((canonicalRootPath) => ({
            _tag: "local" as const,
            rootPath: CoreAbsolutePath.make(canonicalRootPath),
            filePath,
          })),
        ),
      [CoreMethod.appOpenRepositoryComparisonFile]: ({ target, filePath }) =>
        gitProvider
          .fileUrl(target.repository, filePath, target.headSha)
          .pipe(Effect.map((url) => ({ _tag: "external" as const, url: CoreWebUrl.make(url) }))),
      [CoreMethod.appOpenRepositoryFile]: (request) =>
        Effect.gen(function* () {
          const linkedRepository = yield* repositories.findHosted(request.review.repository)
          if (linkedRepository?.localPath !== null && linkedRepository?.localPath !== undefined) {
            const currentBranch = yield* git
              .currentBranch(linkedRepository.localPath)
              .pipe(Effect.option)
            if (Option.isSome(currentBranch) && currentBranch.value === request.headRefName) {
              return {
                _tag: "local" as const,
                rootPath: CoreAbsolutePath.make(linkedRepository.localPath),
                filePath: request.filePath,
              }
            }
          }
          const url = yield* gitProvider.fileUrl(
            request.review.repository,
            request.filePath,
            request.headRevision ?? request.headRefName,
          )
          return { _tag: "external" as const, url: CoreWebUrl.make(url) }
        }),
      [CoreMethod.appStateGet]: () => appState.get,
      [CoreMethod.appStateUpdate]: ({ state }) => appState.save(state),
      [CoreMethod.listProviders]: () => gitProvider.listProviders,
      [CoreMethod.submitHostedReviewDecision]: ({ review, decision }) =>
        gitProvider.submitReviewDecision(review, decision),
      [CoreMethod.getHostedReviewDecision]: ({ review }) => gitProvider.getReviewDecision(review),
      [CoreMethod.listHostedReviews]: ({ repository }) => gitProvider.listHostedReviews(repository),
      [CoreMethod.listAssignedHostedReviews]: ({ providerId }) =>
        gitProvider.listAssignedReviews(providerId),
      [CoreMethod.listHostedRepositorySearchScopes]: ({ providerId }) =>
        gitProvider.listSearchScopes(providerId),
      [CoreMethod.searchHostedRepositories]: ({ providerId, query, namespaces }) =>
        gitProvider.searchRepositories(
          RepositorySearchRequest.make({ providerId, query, owners: namespaces }),
        ),
      [CoreMethod.resolveLocalBranch]: ({ localPath, branchName }) =>
        git.resolveBranchComparison(localPath, branchName),
      [CoreMethod.resolveRepositoryComparison]: ({ command }) =>
        Effect.gen(function* () {
          const target = yield* comparisons.resolve(command)
          const repo = yield* comparisons.repository(target)
          return ResolvedRepositoryComparison.make({ repo, target })
        }),
      [CoreMethod.acquireHostedReviewSnapshot]: ({ review }) =>
        Effect.gen(function* () {
          const project = yield* repositories.ensureHosted(review.repository)
          const snapshot = yield* snapshots.acquireHosted(review)
          return makeReviewSnapshotManifest(snapshot, ReviewProjectId.make(project.id))
        }),
      [CoreMethod.acquireLocalReviewSnapshot]: ({ target }) =>
        Effect.gen(function* () {
          const snapshot = yield* snapshots.acquireLocal(target)
          const project = yield* repositories.ensureLocal(snapshot.detail.rootPath)
          return makeReviewSnapshotManifest(snapshot, ReviewProjectId.make(project.id))
        }),
      [CoreMethod.acquireRepositoryComparisonSnapshot]: ({ target }) =>
        Effect.gen(function* () {
          const repo = yield* comparisons.repository(target)
          const snapshot = yield* snapshots.acquireComparison(target)
          return makeReviewSnapshotManifest(snapshot, ReviewProjectId.make(repo.id))
        }),
      [CoreMethod.getReviewSnapshotPage]: (request) =>
        snapshots.get(request.snapshotId).pipe(
          Effect.map((snapshot) =>
            paginateReviewSnapshot(snapshot, request, REVIEW_SNAPSHOT_PAGE_MAX_BYTES),
          ),
          Effect.catchTag("ReviewSnapshotUnavailableError", (error) =>
            Effect.succeed(
              ReviewSnapshotExpired.make({
                snapshotId: request.snapshotId,
                reason: error.reason,
              }),
            ),
          ),
        ),
      [CoreMethod.searchReviewSnapshot]: (request) =>
        snapshots.get(request.snapshotId).pipe(
          Effect.map((snapshot) =>
            searchReviewSnapshot(snapshot, request, REVIEW_SNAPSHOT_SEARCH_MAX_BYTES),
          ),
          Effect.catchTag("ReviewSnapshotUnavailableError", (error) =>
            Effect.succeed(
              ReviewSnapshotExpired.make({
                snapshotId: request.snapshotId,
                reason: error.reason,
              }),
            ),
          ),
        ),
      [CoreMethod.favoriteRemoteRepository]: ({ repository }) =>
        repositories.ensureHosted(repository.locator, true),
      [CoreMethod.forgetRepository]: ({ projectId }) => repositories.forget(projectId),
      [CoreMethod.installRepository]: ({ localPath }) => repositories.install(localPath),
      [CoreMethod.linkRepository]: (request) => repositories.link(request),
      [CoreMethod.listRepositories]: ({ query }) => repositories.list(query ?? undefined),
      [CoreMethod.openProject]: ({ localPath, selectedRepository }) =>
        repositories.openProject(localPath, selectedRepository ?? undefined),
      [CoreMethod.repairRepositoryIdentities]: () => repositories.repairIdentities(),
      [CoreMethod.setRepositoryFavorite]: ({ id, isFavorite }) =>
        repositories.setFavorite(id, isFavorite),
      [CoreMethod.projectWorkspaceGet]: ({ projectId }) => projectWorkspace.get(projectId),
      [CoreMethod.projectWorkspaceSave]: ({ input }) => projectWorkspace.save(input),
      [CoreMethod.addReviewThreadUserMessage]: (request) => threads.addUserMessage(request),
      [CoreMethod.createReviewThread]: (request) =>
        Effect.gen(function* () {
          const { repo, snapshot, prNumber } = yield* resolveThreadReview(request.target)
          if (
            snapshot.baseRevision !== request.expectedBaseRevision ||
            snapshot.headRevision !== request.expectedHeadRevision
          ) {
            return yield* transportError(
              "REVIEW_CHANGED",
              "Review changed before the local thread was created.",
            )
          }
          if (!isReviewAnchorInParsedDiff(request.anchor, snapshot.parsedDiff)) {
            return yield* transportError(
              "INVALID_REVIEW_ANCHOR",
              "Review thread anchor does not exist in the expected review revision.",
            )
          }
          return yield* threads.create({
            repoId: repo.id,
            reviewKey: snapshot.reviewKey,
            prNumber,
            baseRevision: snapshot.baseRevision,
            headRevision: snapshot.headRevision,
            anchor: request.anchor,
            bodyMarkdown: request.bodyMarkdown,
          })
        }),
      [CoreMethod.getReviewThread]: ({ threadId }) => threads.get(threadId),
      [CoreMethod.listReviewThreads]: ({ target }) =>
        Effect.gen(function* () {
          const { repo, snapshot } = yield* resolveThreadReview(target)
          return yield* threadMapper.mapReview({
            repoId: repo.id,
            reviewKey: snapshot.reviewKey,
            baseRevision: snapshot.baseRevision,
            headRevision: snapshot.headRevision,
            parsedDiff: snapshot.parsedDiff,
          })
        }),
      [CoreMethod.runReviewThreadAgent]: (request, options) =>
        Effect.gen(function* () {
          const mapping = yield* turns.validateTarget({
            threadId: request.threadId,
            target: request.target,
            repoId: request.repoId,
            reviewKey: request.reviewKey,
            baseRevision: request.expectedBaseRevision,
            headRevision: request.expectedHeadRevision,
          })
          const { repo, snapshot } = yield* resolveThreadReview(request.target)
          const walkthrough = yield* walkthroughStore.get(walkthroughCacheKey(repo.id, snapshot))
          return yield* reviewAgents.runThreadTurn({
            threadId: request.threadId,
            repoId: repo.id,
            target: request.target,
            mapping,
            snapshot,
            cwd: repo.localPath,
            walkthrough,
            onProgress: (stage) => Effect.sync(() => options.onReviewThreadAgentProgress?.(stage)),
          })
        }),
      [CoreMethod.settingsGet]: () => appSettings.get,
      [CoreMethod.settingsUpdate]: ({ settings }) => appSettings.save(settings),
      [CoreMethod.listViewedFiles]: (request) =>
        repositories.ensureHosted(request.review.repository).pipe(
          Effect.flatMap((repo) =>
            viewedFiles.listHosted({
              repoId: repo.id,
              prNumber: request.review.number,
              baseRefName: request.baseRefName,
            }),
          ),
        ),
      [CoreMethod.setViewedFile]: (request) =>
        repositories.ensureHosted(request.review.repository).pipe(
          Effect.flatMap((repo) =>
            viewedFiles.setHosted({
              repoId: repo.id,
              prNumber: request.review.number,
              baseRefName: request.baseRefName,
              reviewKey: request.reviewKey,
              patchHash: request.patchHash,
              viewed: request.viewed,
            }),
          ),
        ),
      [CoreMethod.listLocalViewedFiles]: (request) =>
        repositories
          .ensureLocal(request.target.rootPath)
          .pipe(
            Effect.flatMap((repo) =>
              viewedFiles.listLocal(
                localViewedFileScope(repo.id, request.target, request.sourceBranch),
              ),
            ),
          ),
      [CoreMethod.setLocalViewedFile]: (request) =>
        repositories.ensureLocal(request.target.rootPath).pipe(
          Effect.flatMap((repo) =>
            viewedFiles.setLocal({
              ...localViewedFileScope(repo.id, request.target, request.sourceBranch),
              reviewKey: request.reviewKey,
              patchHash: request.patchHash,
              viewed: request.viewed,
            }),
          ),
        ),
      [CoreMethod.listRepositoryComparisonViewedFiles]: ({ target }) =>
        comparisons
          .repository(target)
          .pipe(
            Effect.flatMap((repo) =>
              viewedFiles.listLocal(comparisonViewedFileScope(repo.id, target)),
            ),
          ),
      [CoreMethod.setRepositoryComparisonViewedFile]: (request) =>
        comparisons.repository(request.target).pipe(
          Effect.flatMap((repo) =>
            viewedFiles.setLocal({
              ...comparisonViewedFileScope(repo.id, request.target),
              reviewKey: request.reviewKey,
              patchHash: request.patchHash,
              viewed: request.viewed,
            }),
          ),
        ),
    } satisfies OperationHandlers

    const execute: CoreOperationServiceShape["execute"] = (method, input, options = {}) => {
      const handler = handlers[method]
      // SAFETY: OperationHandlers preserves the method/input/output correlation; indexed access
      // widens that relationship before TypeScript can invoke the selected generic member.
      return handler(input as never, options) as Effect.Effect<
        CoreOperationOutput<typeof method>,
        CoreOperationFailure<typeof method>
      >
    }

    return CoreOperationService.of({
      start: turns.recoverInterruptedTurns.pipe(Effect.asVoid),
      execute,
      walkthroughs: {
        start: startWalkthrough,
        getOperation: getWalkthroughOperation,
        cancel: cancelWalkthrough,
        getStored: getStoredWalkthrough,
      },
    })
  }),
)

/** Converts one walkthrough fiber exit without allowing defects to masquerade as expected failures. */
export const walkthroughTerminalFromExit = (
  exit: Exit.Exit<StoredWalkthrough, CoreWalkthroughFailure>,
): WalkthroughOperationResult => {
  if (Exit.isSuccess(exit)) return { _tag: "completed", walkthrough: exit.value }
  const defect = Cause.dieOption(exit.cause)
  if (Option.isSome(defect)) return { _tag: "defect", defect: defect.value }
  const failure = Cause.failureOption(exit.cause)
  if (Option.isSome(failure)) return { _tag: "failed", error: failure.value }
  if (Exit.isInterrupted(exit)) return { _tag: "cancelled" }
  return { _tag: "defect", defect: Cause.squash(exit.cause) }
}

const walkthroughCacheKey = (repoId: string, snapshot: ReviewSnapshot) => ({
  repoId,
  reviewKey: snapshot.reviewKey,
  baseSha: snapshot.baseRevision,
  headSha: snapshot.headRevision,
  promptVersion: WALKTHROUGH_PROMPT_VERSION,
})

const localViewedFileScope = (
  repoId: string,
  target: Extract<ReviewThreadTarget, { readonly kind: "local" }>,
  sourceBranch: string | null,
) =>
  ({
    repoId,
    sourceIdentity: sourceBranch === null ? "detached" : `branch:${sourceBranch}`,
    comparisonKind: target.comparison["_tag"],
    comparisonTarget: target.comparison["_tag"] === "branch" ? target.comparison.branchName : "",
  }) as const

const comparisonViewedFileScope = (repoId: string, target: RepositoryComparisonTarget) =>
  ({
    repoId,
    sourceIdentity: `comparison:${makeRepositoryComparisonReviewKey(target)}`,
    comparisonKind: "repositoryComparison",
    comparisonTarget: target.headSha,
  }) as const
