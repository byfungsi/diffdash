import { randomUUID } from "node:crypto"
import {
  ReviewThreadAgentEngine,
  REVIEW_THREAD_PROMPT_CONTEXT_LIMITS,
  type ReviewPromptFile,
  type ReviewPromptIdentity,
  type SelectedReviewAgentArtifact,
} from "@diffdash/agents/review-thread"
import {
  AgentCapabilityUnavailableError,
  AgentModelId,
  AgentPolicyEnforcementError,
  AgentProviderId,
  AgentProviderOperationError,
  type AgentProviderManifest,
  AgentProviderProbeError,
  type AgentProviderRegistration,
  AgentSessionId,
  InvalidAgentProviderResponseError,
  InvalidAgentProviderRegistrationError,
  MissingAgentProviderError,
  ScopedMcpAccessError,
  UnsupportedAgentCapabilityError,
} from "@diffdash/agent-provider"
import { makeNonMutatingAgentExecutionPolicy } from "@diffdash/agent-provider/policy"
import {
  AgentProviderRegistry,
  type AgentProviderRoute,
  type ResolvedReviewThreadCandidate,
} from "@diffdash/agent-provider/registry"
import {
  boundedProviderDiagnostic,
  classifyProviderFailureText,
} from "@diffdash/agent-provider/runtime"
import type { AIAgentSelection } from "@diffdash/domain/ai-settings"
import {
  AgentPromptVersion,
  ThreadMemorySummaryAlgorithm,
  UpsertThreadMemoryInput,
} from "@diffdash/domain/agent-run"
import { AgentProviderFailure } from "@diffdash/domain/provider-failure"
import type { ApplicationInstanceId, CoreProcessEpoch } from "@diffdash/core-rpc"
import {
  ReviewFileId,
  ReviewHunkId,
  type ReviewProjectId,
  type ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import type { RepositoryCheckoutPath, RepositoryLocalPath } from "@diffdash/domain/repository"
import {
  ReviewAgentArtifactId,
  type ReviewAgentProgressStage,
  ReviewAgentProviderId,
} from "@diffdash/domain/review-agent"
import {
  HostedReviewDescriptor,
  LocalReviewDescriptor,
  RepositoryComparisonReviewDescriptor,
} from "@diffdash/domain/review-context"
import {
  MarkdownBody,
  CompletedAgentReviewThreadMessage,
  type ReviewThreadDetails,
  type ReviewThreadId,
  type ReviewThreadTarget,
} from "@diffdash/domain/review-thread"
import type { StoredWalkthrough } from "@diffdash/domain/walkthrough"
import { GitProviderRegistry } from "@diffdash/git-provider"
import { DIFFDASH_REVIEW_MCP_TOOLS } from "@diffdash/protocol/mcp"
import { HostedReviewWorkspacePool } from "@diffdash/local-git/hosted-review-workspace-pool"
import { AgentRunArtifactStore } from "@diffdash/persistence/agent-run-artifact-store"
import {
  type BegunReviewTurn,
  type ReviewTurnMappingToken,
  ReviewTurnRejectedError,
  ReviewTurnStore,
  ReviewTurnTargetError,
} from "@diffdash/persistence/review-turn-store"
import { Context, Effect, Layer, Match, Option, Predicate, Result, Schema } from "effect"
import { DiffDashMcpServer } from "@diffdash/mcp"
import { AgentArtifactNormalizer } from "./agent-artifact-normalizer"
import { adaptReviewAgentOutcome } from "./review-agent-outcome-adapter"
import { ReviewMcpHandlers } from "./review-mcp-handlers"
import { createFallbackThreadMemoryUpdate, selectThreadMemoryWindow } from "./thread-memory"
import { CoreExpectedCause } from "../core-error-cause"
import {
  OPERATION_SNAPSHOT_INVENTORY_LIMIT,
  OperationSnapshotReader,
  type OperationSnapshotHandle,
} from "./operation-snapshot-reader"
import {
  decodeSnapshotHunkLines,
  reviewPromptFile,
  reviewPromptIdentity,
  reviewThreadHunkExcerpt,
} from "./operation-snapshot-projection"
import { AgentWorkspaceResources } from "../agent-workspace-resources"

const REVIEW_THREAD_PROMPT_VERSION = AgentPromptVersion.make("review-thread-v3")
const PROVIDER_SUMMARY_ALGORITHM = ThreadMemorySummaryAlgorithm.make("provider-summary")
const REVIEW_THREAD_TIMEOUT_MS = 10 * 60 * 1_000

/** Settings required to route one review turn without exposing app configuration to providers. */
export interface ReviewAgentRouteSelection {
  readonly selection: AIAgentSelection
}

/** Supplies host-owned review routing and model preferences. */
export class ReviewAgentRouting extends Context.Service<
  ReviewAgentRouting,
  { readonly get: Effect.Effect<ReviewAgentRouteSelection> }
>()("@diffdash/ReviewAgentRouting") {}

/** Immutable resources resolved by main before one local review-agent turn. */
export interface RunReviewAgentTurnInput {
  readonly threadId: ReviewThreadId
  readonly repoId: ReviewProjectId
  readonly target: ReviewThreadTarget
  readonly mapping: ReviewTurnMappingToken
  readonly snapshotId: ReviewSnapshotId
  readonly applicationInstanceId: ApplicationInstanceId
  readonly processEpoch: CoreProcessEpoch
  readonly cwd: RepositoryLocalPath
  readonly walkthrough: Option.Option<StoredWalkthrough>
  readonly onProgress?: (stage: ReviewAgentProgressStage) => Effect.Effect<void>
}

/** Durable review-turn reservation and the scoped provider work that owns it. */
export interface AcceptedReviewAgentTurn {
  readonly operation: BegunReviewTurn["run"]
  readonly worker: Effect.Effect<
    ReviewThreadDetails,
    | ReviewAgentServiceError
    | ReviewAgentFinalizeError
    | ReviewAgentProviderFailureError
    | ReviewTurnTargetError
    | ReviewTurnRejectedError
  >
}

/** A recoverable orchestration failure suitable for renderer error state. */
export class ReviewAgentServiceError extends Schema.TaggedError<ReviewAgentServiceError>()(
  "ReviewAgentServiceError",
  {
    operation: Schema.String,
    reason: Schema.String,
    cause: CoreExpectedCause,
  },
) {}

/** A transactional completion or failure could not be committed as one durable review turn. */
export class ReviewAgentFinalizeError extends Schema.TaggedError<ReviewAgentFinalizeError>()(
  "ReviewAgentFinalizeError",
  {
    operation: Schema.Literals(["completeTurn", "failTurn"]),
    reason: Schema.String,
    cause: CoreExpectedCause,
  },
) {}

/** Provider failure already projected to data safe for persistence and renderer display. */
export class ReviewAgentProviderFailureError extends Schema.TaggedError<ReviewAgentProviderFailureError>()(
  "ReviewAgentProviderFailureError",
  {
    failure: AgentProviderFailure,
    reason: Schema.String,
    cause: CoreExpectedCause,
  },
) {}

/** Coordinates provider selection, MCP capability lifetime, persistence, and thread memory. */
export class ReviewAgentService extends Context.Service<
  ReviewAgentService,
  {
    readonly acceptThreadTurn: (
      input: RunReviewAgentTurnInput,
    ) => Effect.Effect<
      AcceptedReviewAgentTurn,
      | ReviewAgentServiceError
      | ReviewAgentProviderFailureError
      | ReviewTurnTargetError
      | ReviewTurnRejectedError
    >
    readonly runThreadTurn: (
      input: RunReviewAgentTurnInput,
    ) => Effect.Effect<
      ReviewThreadDetails,
      | ReviewAgentServiceError
      | ReviewAgentFinalizeError
      | ReviewAgentProviderFailureError
      | ReviewTurnTargetError
      | ReviewTurnRejectedError
    >
  }
>()("@diffdash/ReviewAgentService") {
  static readonly layer = Layer.effect(
    ReviewAgentService,
    Effect.gen(function* () {
      const routing = yield* ReviewAgentRouting
      const providers = yield* AgentProviderRegistry
      const artifacts = yield* AgentRunArtifactStore
      const turns = yield* ReviewTurnStore
      const normalizer = yield* AgentArtifactNormalizer
      const engine = yield* ReviewThreadAgentEngine
      const mcp = yield* DiffDashMcpServer
      const mcpHandlers = yield* ReviewMcpHandlers
      const workspaces = yield* HostedReviewWorkspacePool
      const gitProviders = yield* GitProviderRegistry
      const snapshotReader = yield* OperationSnapshotReader
      const workspaceResources = yield* AgentWorkspaceResources

      const acceptThreadTurnAt = Effect.fn("ReviewAgentService.acceptThreadTurnAt")(
        (input: RunReviewAgentTurnInput, candidateOffset: number) =>
          Effect.gen(function* () {
            yield* validateReviewSnapshot(input)
            const selection = yield* routing.get
            const route = providerRoute(selection.selection)
            const providerCandidates = yield* resolveReviewProviders(providers, selection.selection)
            const publishingTools = (yield* gitProviders.list).flatMap(
              (registration) => registration.publishingTools,
            )
            const provider = yield* selectReviewProvider(
              route,
              providerCandidates.slice(candidateOffset),
            )
            const providerId = provider.registration.manifest.descriptor.id
            const persistedProviderId = ReviewAgentProviderId.make(providerId)
            const model = provider.model
            const begun = yield* turns.beginTurn({
              threadId: input.threadId,
              target: input.target,
              repoId: input.repoId,
              reviewKey: input.mapping.reviewKey,
              baseRevision: input.mapping.baseRevision,
              headRevision: input.mapping.headRevision,
              mapping: input.mapping,
              provider: persistedProviderId,
              model,
              promptVersion: REVIEW_THREAD_PROMPT_VERSION,
            })
            const providerRunId =
              provider.registration.manifest.session.mode === "resume"
                ? begun.resumableProviderRunId
                : null

            const worker = Effect.scoped(
              Effect.gen(function* () {
                const snapshot = yield* snapshotReader.open({
                  applicationInstanceId: input.applicationInstanceId,
                  processEpoch: input.processEpoch,
                  operationId: begun.run.id,
                  projectId: input.repoId,
                  reviewKey: input.mapping.reviewKey,
                  snapshotId: input.snapshotId,
                })
                yield* validateSnapshotHandle(input, snapshot)
                const review = reviewPromptIdentity(snapshot.snapshot)
                if (Schema.is(LocalReviewDescriptor)(review.descriptor) && input.cwd === null) {
                  return yield* serviceError(
                    "runThreadTurn.workingDirectory",
                    new Error("Local review execution requires a working directory"),
                  )
                }
                const hostedExecution = yield* prepareHostedExecution(review, gitProviders)
                const comparisonExecution = yield* prepareComparisonExecution(
                  review,
                  gitProviders,
                  input.cwd,
                )
                const execute = Effect.gen(function* () {
                  const memoryWindow = selectThreadMemoryWindow({
                    threadId: input.threadId,
                    memory: begun.memory,
                    messages: begun.details.messages,
                  })
                  const priorArtifacts = yield* loadSelectedArtifacts(
                    begun.memory?.importantArtifactIds ?? [],
                    input.threadId,
                    artifacts,
                  )
                  yield* reportProgress(input.onProgress, "preparing-context")
                  const promptContext = yield* prepareReviewPromptContext(
                    snapshot,
                    begun.details.thread,
                  )
                  const policy = reviewExecutionPolicy(publishingTools)
                  const runProvider = (cwd: RepositoryLocalPath) =>
                    Effect.scoped(
                      Effect.gen(function* () {
                        yield* reportProgress(input.onProgress, "starting-agent")
                        const access = yield* mcp.acquireRun({
                          runId: begun.run.id,
                          threadId: input.threadId,
                          repoId: input.repoId,
                          localPath: cwd,
                          handlers: mcpHandlers.make({
                            runId: begun.run.id,
                            threadId: input.threadId,
                            repoId: input.repoId,
                            review,
                            snapshot,
                            localPath: cwd,
                            walkthrough: input.walkthrough,
                          }),
                        })
                        yield* reportProgress(input.onProgress, "reviewing")
                        if (cwd === null) {
                          return yield* serviceError(
                            "runThreadTurn.workingDirectory",
                            new Error("Review execution requires a working directory"),
                          )
                        }
                        const outcome = yield* engine.run({
                          review,
                          fileInventory: promptContext.fileInventory,
                          anchorHunk: promptContext.anchorHunk,
                          thread: begun.details.thread,
                          messages: memoryWindow.messages,
                          latestUserMessage: begun.latestUserMessage,
                          threadSummary: memoryWindow.memory?.summary ?? null,
                          priorArtifacts,
                          providerId,
                          capability: provider.capability,
                          model,
                          workingDirectory: cwd,
                          revision: review.headRevision,
                          timeoutMs: REVIEW_THREAD_TIMEOUT_MS,
                          sessionId:
                            providerRunId === null ? null : AgentSessionId.make(providerRunId),
                          mcp: {
                            scopeId: input.threadId,
                            endpoint: access.url,
                            bearerToken: access.bearerToken,
                            allowedTools: DIFFDASH_REVIEW_MCP_TOOLS,
                            call: () =>
                              ScopedMcpAccessError.make({
                                reason: "Provider uses the scoped MCP transport",
                              }),
                          },
                          policy,
                        })
                        return yield* adaptReviewAgentOutcome(providerId, outcome, normalizer)
                      }),
                    )

                  const runManagedProvider = (cwd: RepositoryCheckoutPath) =>
                    workspaceResources
                      .protect(
                        {
                          localPath: cwd,
                          agentRunId: begun.run.id,
                          applicationInstanceId: input.applicationInstanceId,
                          processEpoch: input.processEpoch,
                        },
                        runProvider(cwd),
                      )
                      .pipe(
                        Effect.catchTags({
                          AgentWorkspaceResourceError: (cause) =>
                            serviceError("runThreadTurn.workspaceResource", cause),
                          ResourceCatalogError: (cause) =>
                            serviceError("runThreadTurn.workspaceResource", cause),
                        }),
                      )

                  if (comparisonExecution !== null) {
                    return yield* workspaces.useComparison(comparisonExecution, runManagedProvider)
                  }
                  if (hostedExecution === null) return yield* runProvider(input.cwd)
                  return yield* workspaces.use(
                    {
                      runId: begun.run.id,
                      threadId: input.threadId,
                      checkout: hostedExecution.checkout,
                      sourcePath: input.cwd,
                      bootstrapBareRepository: hostedExecution.bootstrapBareRepository,
                    },
                    (lease) => runManagedProvider(lease.localPath),
                    input.onProgress,
                  )
                })

                const result = yield* execute.pipe(
                  Effect.catch((cause) =>
                    failStartedTurn(turns, begun, persistedProviderId, cause),
                  ),
                )
                const preparedArtifacts = result.artifacts.map((artifact) => ({
                  id: ReviewAgentArtifactId.make(randomUUID()),
                  artifact,
                }))
                const completedMessage = CompletedAgentReviewThreadMessage.make({
                  id: begun.pendingMessage.id,
                  threadId: begun.pendingMessage.threadId,
                  sequence: begun.pendingMessage.sequence,
                  agentRunId: begun.pendingMessage.agentRunId,
                  bodyMarkdown: MarkdownBody.make(result.response.bodyMarkdown),
                  createdAt: begun.pendingMessage.createdAt,
                  updatedAt: begun.pendingMessage.updatedAt,
                })
                const completedMessages = begun.details.messages.map((message) =>
                  message.id === completedMessage.id ? completedMessage : message,
                )
                const importantArtifactIds = [
                  ...(begun.memory?.importantArtifactIds ?? []),
                  ...preparedArtifacts.map(({ id }) => id),
                ].slice(-20)
                const memoryUpdate =
                  result.response.threadSummaryUpdate === undefined
                    ? createFallbackThreadMemoryUpdate({
                        threadId: input.threadId,
                        memory: begun.memory,
                        messages: completedMessages,
                        importantArtifactIds,
                      })
                    : UpsertThreadMemoryInput.make({
                        threadId: input.threadId,
                        summary: result.response.threadSummaryUpdate,
                        summarizedThroughSequence: completedMessage.sequence,
                        summaryAlgorithm: PROVIDER_SUMMARY_ALGORITHM,
                        summaryVersion: 1,
                        importantArtifactIds,
                      })
                return yield* turns
                  .completeTurn({
                    threadId: input.threadId,
                    runId: begun.run.id,
                    messageId: begun.pendingMessage.id,
                    bodyMarkdown: completedMessage.bodyMarkdown,
                    artifacts: preparedArtifacts,
                    providerRunId: result.providerRunId,
                    usage: result.usage,
                    memoryUpdate,
                  })
                  .pipe(Effect.mapError((cause) => finalizeErrorValue("completeTurn", cause)))
              }),
            ).pipe(
              Effect.mapError((cause) =>
                isReviewAgentTurnError(cause)
                  ? cause
                  : (publicPreflightFailure(cause) ??
                    serviceErrorValue("runThreadTurn.provider", cause)),
              ),
            )

            return { operation: begun.run, worker }
          }).pipe(
            Effect.mapError((cause) =>
              isReviewAgentAcceptanceError(cause)
                ? cause
                : (publicPreflightFailure(cause) ??
                  serviceErrorValue("runThreadTurn.preflight", cause)),
            ),
          ),
      )

      const acceptThreadTurn: ReviewAgentService["Service"]["acceptThreadTurn"] = (input) =>
        acceptThreadTurnAt(input, 0)

      const runThreadTurn = Effect.fn("ReviewAgentService.runThreadTurn")(function* (
        input: RunReviewAgentTurnInput,
      ) {
        const selection = (yield* routing.get).selection
        const route = providerRoute(selection)
        const candidateCount = (yield* resolveReviewProviders(providers, selection).pipe(
          Effect.mapError(
            (cause) =>
              (isReviewAgentAcceptanceError(cause) ? cause : publicPreflightFailure(cause)) ??
              serviceErrorValue("runThreadTurn.preflight", cause),
          ),
        )).length
        const runAt: (candidateOffset: number) => AcceptedReviewAgentTurn["worker"] = Effect.fn(
          "ReviewAgentService.runThreadTurnCandidate",
        )((candidateOffset): AcceptedReviewAgentTurn["worker"] =>
          acceptThreadTurnAt(input, candidateOffset).pipe(
            Effect.flatMap(({ worker }) =>
              worker.pipe(
                Effect.catch((cause) =>
                  route.mode === "auto" &&
                  candidateOffset + 1 < candidateCount &&
                  Schema.is(ReviewAgentProviderFailureError)(cause)
                    ? runAt(candidateOffset + 1)
                    : Effect.fail(cause),
                ),
              ),
            ),
          ),
        )
        return yield* runAt(0)
      })

      return ReviewAgentService.of({
        acceptThreadTurn,
        runThreadTurn,
      })
    }),
  ).pipe(Layer.provide(ReviewThreadAgentEngine.layer))
}

const validateReviewSnapshot = (input: RunReviewAgentTurnInput) =>
  input.mapping.threadId === input.threadId &&
  input.mapping.repoId === input.repoId &&
  input.mapping.reviewKey.length > 0 &&
  input.mapping.baseRevision.length > 0 &&
  input.mapping.headRevision.length > 0
    ? Effect.void
    : ReviewTurnTargetError.make({
        reason: "The review snapshot changed after the review-turn target was checked.",
      })

const validateSnapshotHandle = (input: RunReviewAgentTurnInput, handle: OperationSnapshotHandle) =>
  handle.snapshot.reviewKey === input.mapping.reviewKey &&
  handle.snapshot.baseRevision === input.mapping.baseRevision &&
  handle.snapshot.headRevision === input.mapping.headRevision
    ? Effect.void
    : ReviewTurnTargetError.make({
        reason: "The durable review snapshot does not match the accepted review turn.",
      })

type GitProviderRegistryService = Context.Service.Shape<typeof GitProviderRegistry>

const prepareReviewPromptContext = Effect.fn("ReviewAgentService.preparePromptContext")(function* (
  handle: OperationSnapshotHandle,
  thread: ReviewThreadDetails["thread"],
) {
  const files: ReviewPromptFile[] = []
  let totalFiles = 0
  let retainInventory = true
  for (;;) {
    const page = yield* handle.inventory(totalFiles, OPERATION_SNAPSHOT_INVENTORY_LIMIT)
    totalFiles += page.length
    if (retainInventory) {
      for (const file of page) {
        if (files.length >= REVIEW_THREAD_PROMPT_CONTEXT_LIMITS.maxFileInventoryCount) {
          retainInventory = false
          break
        }
        files.push(reviewPromptFile(file))
        if (Buffer.byteLength(JSON.stringify({ totalFiles, files }), "utf8") > 12 * 1024) {
          files.pop()
          retainInventory = false
          break
        }
      }
    }
    if (page.length < OPERATION_SNAPSHOT_INVENTORY_LIMIT) break
  }

  const anchor = thread.activeAnchor
  if (anchor === null) return { fileInventory: { totalFiles, files }, anchorHunk: null }
  const read = yield* handle.readHunk(
    ReviewFileId.make(anchor.fileId),
    ReviewHunkId.make(anchor.hunkId),
  )
  const lines = yield* decodeSnapshotHunkLines(read.bytes)
  const excerpt = reviewThreadHunkExcerpt(anchor, read.hunk, lines)
  if (excerpt === null) return { fileInventory: { totalFiles, files }, anchorHunk: null }

  const maximumLines = REVIEW_THREAD_PROMPT_CONTEXT_LIMITS.maxAnchorHunkLines
  let start = Math.max(0, excerpt.anchorLineIndex - Math.floor(maximumLines / 2))
  let end = Math.min(lines.length, start + maximumLines)
  start = Math.max(0, end - maximumLines)
  while (
    end - start > 1 &&
    Buffer.byteLength([read.hunk.header, ...lines.slice(start, end)].join("\n"), "utf8") >
      REVIEW_THREAD_PROMPT_CONTEXT_LIMITS.maxAnchorHunkBytes
  ) {
    if (excerpt.anchorLineIndex - start > end - excerpt.anchorLineIndex - 1) start += 1
    else end -= 1
  }
  return {
    fileInventory: { totalFiles, files },
    anchorHunk: {
      ...excerpt,
      lines: lines.slice(start, end),
      anchorLineIndex: excerpt.anchorLineIndex - start,
      omittedBefore: start,
      omittedAfter: lines.length - end,
    },
  }
})

const prepareHostedExecution = (
  reviewIdentity: ReviewPromptIdentity,
  registry: GitProviderRegistryService,
) => {
  const descriptor = reviewIdentity.descriptor
  if (!Schema.is(HostedReviewDescriptor)(descriptor)) return Effect.succeed(null)
  return Effect.gen(function* () {
    const review = descriptor.review
    const provider = yield* registry.get(review.repository.providerId)
    const checkout = yield* provider.checkoutSpec(review, reviewIdentity.headRevision)
    return {
      checkout,
      bootstrapBareRepository: (destination: RepositoryCheckoutPath) =>
        provider.bootstrapBareRepository(checkout.repository, destination),
    }
  })
}

const prepareComparisonExecution = (
  reviewIdentity: ReviewPromptIdentity,
  registry: GitProviderRegistryService,
  sourcePath: RepositoryLocalPath,
) => {
  const descriptor = reviewIdentity.descriptor
  if (!Schema.is(RepositoryComparisonReviewDescriptor)(descriptor)) return Effect.succeed(null)
  return Effect.gen(function* () {
    const target = descriptor.target
    const provider = yield* registry.get(target.repository.providerId)
    return {
      repository: target.repository,
      sourcePath,
      remoteUrl: null,
      baseSha: target.baseSha,
      headSha: target.headSha,
      mergeBaseSha: target.mergeBaseSha,
      bootstrapBareRepository: (destination: RepositoryCheckoutPath) =>
        provider.bootstrapBareRepository(target.repository, destination),
    }
  })
}

const failStartedTurn = (
  turns: Context.Service.Shape<typeof ReviewTurnStore>,
  begun: BegunReviewTurn,
  providerId: ReviewAgentProviderId,
  cause: CoreExpectedCause,
) => {
  const failure = publicProviderFailure(providerId, cause)
  const diagnostic = MarkdownBody.make(
    "The local review agent could not complete this response. Retry to try again.",
  )
  return turns
    .failTurn({
      threadId: begun.run.threadId,
      runId: begun.run.id,
      messageId: begun.pendingMessage.id,
      diagnostic,
      failure,
    })
    .pipe(
      Effect.mapError((finalizeCause) => finalizeErrorValue("failTurn", finalizeCause)),
      Effect.flatMap(
        (): Effect.Effect<never, ReviewAgentServiceError | ReviewAgentProviderFailureError> => {
          if (failure === null) return serviceError("runThreadTurn.provider", cause)
          return Effect.fail(
            ReviewAgentProviderFailureError.make({ failure, reason: diagnostic, cause }),
          )
        },
      ),
    )
}

const loadSelectedArtifacts = (
  artifactIds: readonly Parameters<Context.Service.Shape<typeof AgentRunArtifactStore>["get"]>[0][],
  threadId: ReviewThreadId,
  store: Context.Service.Shape<typeof AgentRunArtifactStore>,
): Effect.Effect<readonly SelectedReviewAgentArtifact[]> =>
  Effect.forEach(artifactIds, (id) => store.get(id).pipe(Effect.option), { concurrency: 1 }).pipe(
    Effect.map((items) =>
      items.flatMap((item) =>
        Option.isSome(item) && item.value.threadId === threadId
          ? [{ id: item.value.id, artifact: item.value.artifact }]
          : [],
      ),
    ),
  )

type ProviderRegistry = Context.Service.Shape<typeof AgentProviderRegistry>

interface ResolvedReviewProvider {
  readonly registration: AgentProviderRegistration
  readonly capability: NonNullable<AgentProviderRegistration["reviewThread"]>
  readonly model: AgentModelId
  readonly ready: Effect.Effect<void, CoreExpectedCause>
}

const selectReviewProvider = Effect.fn("ReviewAgentService.selectProvider")(function* (
  route: AgentProviderRoute,
  candidates: readonly ResolvedReviewProvider[],
) {
  for (const candidate of candidates) {
    const readiness = yield* candidate.ready.pipe(Effect.result)
    if (Result.isSuccess(readiness)) return candidate
    if (route.mode === "provider") return yield* Effect.fail(readiness.failure)
  }
  return yield* providerFailureError(
    AgentProviderId.make("unavailable"),
    "configuration",
    new Error("No review agent provider is available"),
  )
})

const resolveReviewProviders = (
  registry: ProviderRegistry,
  selection: AIAgentSelection,
): Effect.Effect<readonly ResolvedReviewProvider[], CoreExpectedCause> => {
  const route = providerRoute(selection)
  const resolveProvider = (candidate: ResolvedReviewThreadCandidate) =>
    Effect.gen(function* () {
      const { registration, capability, ready } = candidate
      const providerId = registration.manifest.descriptor.id
      const model = yield* modelForProvider(registration.manifest, selection, providerId)
      return { registration, capability, model, ready }
    })
  return registry.resolveReviewThreadCandidates(route).pipe(
    Effect.flatMap((candidates) =>
      route.mode === "provider"
        ? Effect.forEach(candidates, resolveProvider)
        : Effect.forEach(
            candidates,
            (candidate) => resolveProvider(candidate).pipe(Effect.option),
            {
              concurrency: 1,
            },
          ).pipe(
            Effect.flatMap((resolved) => {
              const available = resolved.flatMap((candidate) =>
                Option.isSome(candidate) ? [candidate.value] : [],
              )
              return available.length > 0
                ? Effect.succeed(available)
                : Effect.fail(
                    providerFailureError(
                      AgentProviderId.make("unavailable"),
                      "configuration",
                      new Error("No review agent provider has a compatible model"),
                    ),
                  )
            }),
          ),
    ),
    Effect.catchTag("NoAgentProviderAvailableError", () =>
      Effect.fail(
        providerFailureError(
          AgentProviderId.make("unavailable"),
          "configuration",
          new Error("No review agent provider is available"),
        ),
      ),
    ),
  )
}

const modelForProvider = (
  manifest: AgentProviderManifest,
  selection: AIAgentSelection,
  providerId: AgentProviderId,
) => {
  const reviewModels = manifest.models.filter((model) =>
    model.capabilities.includes("review-thread"),
  )
  const selected = Match.valueTags(selection, {
    Automatic: ({ quality }) => reviewModels.find((model) => model.quality === quality)?.id,
    Pinned: ({ providerId: selectedProviderId, modelId }) =>
      String(selectedProviderId) !== String(providerId)
        ? undefined
        : modelId === null
          ? manifest.defaults.reviewThreadModel
          : AgentModelId.make(modelId),
  })
  return selected === null ||
    selected === undefined ||
    !reviewModels.some(({ id }) => id === selected)
    ? Effect.fail(
        providerFailureError(
          providerId,
          "model-unavailable",
          new Error(`No review-thread model is configured for provider: ${providerId}`),
        ),
      )
    : Effect.succeed(selected)
}

const providerRoute = (selection: AIAgentSelection): AgentProviderRoute =>
  Match.valueTags(selection, {
    Automatic: () => ({ mode: "auto" as const }),
    Pinned: ({ providerId }) => ({
      mode: "provider" as const,
      providerId: AgentProviderId.make(providerId),
    }),
  })

const reviewExecutionPolicy = (providerPublishingTools: readonly string[]) =>
  makeNonMutatingAgentExecutionPolicy({
    network: "allow",
    repository: "reviewed-revision",
    shell: "read-only",
    providerPublishingTools: [...new Set(providerPublishingTools)],
    allowedMcpTools: DIFFDASH_REVIEW_MCP_TOOLS,
  })

const publicProviderFailure = (
  provider: ReviewAgentProviderId,
  cause: CoreExpectedCause,
): AgentProviderFailure | null => {
  if (Schema.is(AgentProviderOperationError)(cause)) {
    return AgentProviderFailure.make({
      ...cause.failure,
      providerId: safePublicProviderId(cause.failure.providerId),
    })
  }
  if (!Schema.is(InvalidAgentProviderResponseError)(cause)) return null
  return AgentProviderFailure.make({
    version: 1,
    providerId: safePublicProviderId(provider),
    capability: "review-thread",
    category: "invalid-response",
    processKind: null,
    exitCode: null,
    signal: null,
    httpStatus: null,
    retryAfterSeconds: null,
    resetsAt: null,
  })
}

const publicPreflightFailure = (
  cause: CoreExpectedCause,
): ReviewAgentProviderFailureError | null => {
  if (Schema.is(AgentCapabilityUnavailableError)(cause)) {
    return providerFailureError(
      cause.providerId,
      classifyProviderFailureText(cause.reason) ?? "configuration",
      cause,
    )
  }
  if (Schema.is(AgentPolicyEnforcementError)(cause)) {
    return providerFailureError(cause.providerId, "policy-violation", cause)
  }
  if (Schema.is(AgentProviderProbeError)(cause)) {
    return providerFailureError(cause.providerId, "configuration", cause)
  }
  if (Schema.is(InvalidAgentProviderRegistrationError)(cause)) {
    return providerFailureError(cause.providerId, "configuration", cause)
  }
  if (
    Schema.is(MissingAgentProviderError)(cause) ||
    Schema.is(UnsupportedAgentCapabilityError)(cause)
  ) {
    return providerFailureError(cause.providerId, "configuration", cause)
  }
  return null
}

const providerFailureError = (
  providerId: AgentProviderId,
  category: AgentProviderFailure["category"],
  cause: CoreExpectedCause,
) =>
  ReviewAgentProviderFailureError.make({
    failure: AgentProviderFailure.make({
      version: 1,
      providerId: safePublicProviderId(providerId),
      capability: "review-thread",
      category,
      processKind: null,
      exitCode: null,
      signal: null,
      httpStatus: null,
      retryAfterSeconds: null,
      resetsAt: null,
    }),
    reason: "The configured review agent is unavailable.",
    cause,
  })

const safePublicProviderId = (providerId: string): ReviewAgentProviderId =>
  ReviewAgentProviderId.make(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(providerId) ? providerId : "custom",
  )

const executionFailureReason = (cause: CoreExpectedCause) => {
  const reason =
    Predicate.hasProperty(cause, "reason") && Predicate.isString(cause.reason)
      ? cause.reason
      : cause.message
  return boundedProviderDiagnostic(reason)
}

const serviceError = (operation: string, cause: CoreExpectedCause) =>
  Effect.fail(serviceErrorValue(operation, cause))

const serviceErrorValue = (operation: string, cause: CoreExpectedCause) =>
  ReviewAgentServiceError.make({
    operation,
    reason: executionFailureReason(cause),
    cause,
  })

const finalizeErrorValue = (operation: "completeTurn" | "failTurn", cause: CoreExpectedCause) =>
  ReviewAgentFinalizeError.make({
    operation,
    reason: executionFailureReason(cause),
    cause,
  })

const isReviewAgentTurnError = (
  cause: CoreExpectedCause,
): cause is
  | ReviewAgentServiceError
  | ReviewAgentFinalizeError
  | ReviewAgentProviderFailureError
  | ReviewTurnTargetError
  | ReviewTurnRejectedError =>
  Schema.is(ReviewAgentServiceError)(cause) ||
  Schema.is(ReviewAgentFinalizeError)(cause) ||
  Schema.is(ReviewAgentProviderFailureError)(cause) ||
  Schema.is(ReviewTurnTargetError)(cause) ||
  Schema.is(ReviewTurnRejectedError)(cause)

const isReviewAgentAcceptanceError = (
  cause: CoreExpectedCause,
): cause is
  | ReviewAgentServiceError
  | ReviewAgentProviderFailureError
  | ReviewTurnTargetError
  | ReviewTurnRejectedError =>
  Schema.is(ReviewAgentServiceError)(cause) ||
  Schema.is(ReviewAgentProviderFailureError)(cause) ||
  Schema.is(ReviewTurnTargetError)(cause) ||
  Schema.is(ReviewTurnRejectedError)(cause)

const reportProgress = (
  reporter: ((stage: ReviewAgentProgressStage) => Effect.Effect<void>) | undefined,
  stage: ReviewAgentProgressStage,
) => reporter?.(stage) ?? Effect.void
