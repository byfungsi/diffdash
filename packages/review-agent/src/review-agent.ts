import { randomUUID } from "node:crypto"
import {
  AgentModelId,
  type AgentModelQuality,
  type AgentProviderId,
  type AgentProviderManifest,
  type AgentProviderRegistration,
  ReviewRevision as AgentReviewRevision,
  AgentSessionId,
  DIFFDASH_REVIEW_MCP_TOOLS,
  ReviewThreadResult,
  ScopedMcpAccessError,
} from "@diffdash/agent-provider"
import { makeNonMutatingAgentExecutionPolicy } from "@diffdash/agent-provider/policy"
import { AgentProviderRegistry, type AgentProviderRoute } from "@diffdash/agent-provider/registry"
import { boundedProviderDiagnostic } from "@diffdash/agent-provider/runtime"
import {
  AgentPromptVersion,
  ThreadMemorySummaryAlgorithm,
  UpsertThreadMemoryInput,
} from "@diffdash/domain/agent-run"
import {
  ReviewAgentArtifactId,
  type ReviewAgentProgressStage,
  type ReviewAgentProviderId,
} from "@diffdash/domain/review-agent"
import { HostedReviewSnapshot, type ReviewSnapshot } from "@diffdash/domain/review-context"
import {
  MarkdownBody,
  type ReviewThreadDetails,
  type ReviewThreadId,
  ReviewThreadMessage,
  type ReviewThreadTarget,
} from "@diffdash/domain/review-thread"
import type { StoredWalkthrough } from "@diffdash/domain/walkthrough"
import { GitProviderRegistry } from "@diffdash/git-provider"
import {
  HostedReviewWorkspacePool,
  HostedReviewWorkspacePoolError,
} from "@diffdash/local-git/hosted-review-workspace-pool"
import { AgentRunArtifactStore } from "@diffdash/persistence/agent-run-artifact-store"
import {
  type BegunReviewTurn,
  type ReviewTurnMappingToken,
  ReviewTurnRejectedError,
  ReviewTurnStore,
  ReviewTurnTargetError,
} from "@diffdash/persistence/review-turn-store"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { AgentArtifactNormalizer } from "./agent-artifact-normalizer"
import { DiffDashMcpServer } from "./diffdash-mcp-server"
import { ReviewContextBuilder, type SelectedReviewAgentArtifact } from "./review-context-builder"
import { adaptProviderResult } from "./provider-result-adapter"
import { createFallbackThreadMemoryUpdate, selectThreadMemoryWindow } from "./thread-memory"

const REVIEW_THREAD_PROMPT_VERSION = AgentPromptVersion.make("review-thread-v3")
const PROVIDER_SUMMARY_ALGORITHM = ThreadMemorySummaryAlgorithm.make("provider-summary")
const REVIEW_THREAD_TIMEOUT_MS = 10 * 60 * 1_000

/** Settings required to route one review turn without exposing app configuration to providers. */
export interface ReviewAgentRouteSelection {
  readonly route: AgentProviderRoute
  readonly models: Readonly<Record<string, string>>
  readonly autoQuality: AgentModelQuality
}

/** Supplies host-owned review routing and model preferences. */
export class ReviewAgentRouting extends Context.Tag("@diffdash/ReviewAgentRouting")<
  ReviewAgentRouting,
  { readonly get: Effect.Effect<ReviewAgentRouteSelection> }
>() {}

/** Immutable resources resolved by main before one local review-agent turn. */
interface RunReviewAgentTurnInput {
  readonly threadId: ReviewThreadId
  readonly repoId: string
  readonly target: ReviewThreadTarget
  readonly mapping: ReviewTurnMappingToken
  readonly snapshot: ReviewSnapshot
  readonly cwd: string | null
  readonly walkthrough: StoredWalkthrough | null
  readonly onProgress?: (stage: ReviewAgentProgressStage) => Effect.Effect<void>
}

/** A recoverable orchestration failure suitable for renderer error state. */
class ReviewAgentServiceError extends Schema.TaggedError<ReviewAgentServiceError>()(
  "ReviewAgentServiceError",
  {
    operation: Schema.String,
    reason: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** A transactional completion or failure could not be committed as one durable review turn. */
export class ReviewAgentFinalizeError extends Schema.TaggedError<ReviewAgentFinalizeError>()(
  "ReviewAgentFinalizeError",
  {
    operation: Schema.Literal("completeTurn", "failTurn"),
    reason: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** Coordinates provider selection, MCP capability lifetime, persistence, and thread memory. */
export class ReviewAgentService extends Context.Tag("@diffdash/ReviewAgentService")<
  ReviewAgentService,
  {
    readonly runThreadTurn: (
      input: RunReviewAgentTurnInput,
    ) => Effect.Effect<
      ReviewThreadDetails,
      | ReviewAgentServiceError
      | ReviewAgentFinalizeError
      | ReviewTurnTargetError
      | ReviewTurnRejectedError
    >
  }
>() {
  static readonly layer = Layer.effect(
    ReviewAgentService,
    Effect.gen(function* () {
      const routing = yield* ReviewAgentRouting
      const providers = yield* AgentProviderRegistry
      const artifacts = yield* AgentRunArtifactStore
      const turns = yield* ReviewTurnStore
      const contextBuilder = yield* ReviewContextBuilder
      const normalizer = yield* AgentArtifactNormalizer
      const mcp = yield* DiffDashMcpServer
      const workspaces = yield* HostedReviewWorkspacePool
      const gitProviders = yield* GitProviderRegistry

      return ReviewAgentService.of({
        runThreadTurn: (input) =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* validateReviewSnapshot(input)
              const selection = yield* routing.get
              const provider = yield* resolveReviewProvider(providers, selection.route)
              const providerId = provider.registration.manifest.descriptor.id
              const model = yield* modelForProvider(
                provider.registration.manifest,
                selection,
                providerId,
              )
              if (!(input.snapshot instanceof HostedReviewSnapshot) && input.cwd === null) {
                return yield* serviceError(
                  "runThreadTurn.workingDirectory",
                  new Error("Local review execution requires a working directory"),
                )
              }
              const hostedExecution = yield* prepareHostedExecution(input.snapshot, gitProviders)
              const publishingTools = (yield* gitProviders.list).flatMap(
                (registration) => registration.publishingTools,
              )
              const begun = yield* turns.beginTurn({
                threadId: input.threadId,
                target: input.target,
                repoId: input.repoId,
                reviewKey: input.snapshot.reviewKey,
                baseRevision: input.snapshot.baseRevision,
                headRevision: input.snapshot.headRevision,
                mapping: input.mapping,
                provider: providerId,
                model,
                promptVersion: REVIEW_THREAD_PROMPT_VERSION,
              })
              const providerRunId =
                provider.registration.manifest.session.mode === "resume"
                  ? begun.resumableProviderRunId
                  : null

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
                const prompt = yield* contextBuilder.build({
                  snapshot: input.snapshot,
                  thread: begun.details.thread,
                  messages: memoryWindow.messages,
                  latestUserMessage: begun.latestUserMessage,
                  threadSummary: memoryWindow.memory?.summary ?? null,
                  priorArtifacts,
                })
                const policy = reviewExecutionPolicy(publishingTools)
                const runProvider = (cwd: string | null) =>
                  Effect.scoped(
                    Effect.gen(function* () {
                      yield* reportProgress(input.onProgress, "starting-agent")
                      const access = yield* mcp.acquireRun({
                        runId: begun.run.id,
                        threadId: input.threadId,
                        repoId: input.repoId,
                        snapshot: input.snapshot,
                        localPath: cwd,
                        walkthrough: input.walkthrough,
                      })
                      yield* reportProgress(input.onProgress, "reviewing")
                      if (cwd === null) {
                        return yield* serviceError(
                          "runThreadTurn.workingDirectory",
                          new Error("Review execution requires a working directory"),
                        )
                      }
                      const rawProviderResult = yield* provider.capability.execute({
                        stablePrompt: prompt.stablePromptPrefix,
                        dynamicPrompt: prompt.dynamicPromptSuffix,
                        model,
                        workingDirectory: cwd,
                        revision: AgentReviewRevision.make(input.snapshot.headRevision),
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
                      const providerResult =
                        yield* Schema.decodeUnknown(ReviewThreadResult)(rawProviderResult)
                      return yield* adaptProviderResult(providerId, providerResult, normalizer)
                    }),
                  )

                if (hostedExecution === null) return yield* runProvider(input.cwd)
                return yield* workspaces.use(
                  {
                    runId: begun.run.id,
                    threadId: input.threadId,
                    checkout: hostedExecution.checkout,
                    sourcePath: input.cwd,
                    bootstrapBareRepository: hostedExecution.bootstrapBareRepository,
                  },
                  (lease) => runProvider(lease.localPath),
                  input.onProgress,
                )
              })

              const result = yield* execute.pipe(
                Effect.catchAll((cause) => failStartedTurn(turns, begun, providerId, cause)),
              )
              const preparedArtifacts = result.artifacts.map((artifact) => ({
                id: ReviewAgentArtifactId.make(randomUUID()),
                artifact,
              }))
              const completedMessage = ReviewThreadMessage.make({
                ...begun.pendingMessage,
                bodyMarkdown: MarkdownBody.make(result.response.bodyMarkdown),
                status: "complete",
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
            }).pipe(
              Effect.mapError((cause) =>
                isReviewAgentTurnError(cause)
                  ? cause
                  : serviceErrorValue("runThreadTurn.preflight", cause),
              ),
            ),
          ),
      })
    }),
  )
}

const validateReviewSnapshot = (input: RunReviewAgentTurnInput) =>
  input.mapping.threadId === input.threadId &&
  input.mapping.repoId === input.repoId &&
  input.mapping.reviewKey === input.snapshot.reviewKey &&
  input.mapping.baseRevision === input.snapshot.baseRevision &&
  input.mapping.headRevision === input.snapshot.headRevision
    ? Effect.void
    : ReviewTurnTargetError.make({
        reason: "The review snapshot changed after the review-turn target was checked.",
      })

type GitProviderRegistryService = Context.Tag.Service<GitProviderRegistry>

const prepareHostedExecution = (snapshot: ReviewSnapshot, registry: GitProviderRegistryService) => {
  if (!(snapshot instanceof HostedReviewSnapshot)) return Effect.succeed(null)
  return Effect.gen(function* () {
    const review = snapshot.detail.summary.locator
    const provider = yield* registry.get(review.repository.providerId)
    const checkout = yield* provider.checkoutSpecAtRevision?.(review, snapshot.headRevision) ??
      provider.checkoutSpec(review)
    if (checkout.revision !== snapshot.headRevision) {
      return yield* serviceError(
        "runThreadTurn.checkoutRevision",
        new Error("Git provider did not preserve the exact review revision"),
      )
    }
    return {
      checkout,
      bootstrapBareRepository: (destination: string) =>
        provider.bootstrapBareRepository(checkout.repository, destination),
    }
  })
}

const failStartedTurn = (
  turns: Context.Tag.Service<ReviewTurnStore>,
  begun: BegunReviewTurn,
  providerId: ReviewAgentProviderId,
  cause: unknown,
) => {
  const failure = userSafeFailure(providerId, cause)
  return turns
    .failTurn({
      threadId: begun.run.threadId,
      runId: begun.run.id,
      messageId: begun.pendingMessage.id,
      diagnostic: MarkdownBody.make(failure),
    })
    .pipe(
      Effect.mapError((finalizeCause) => finalizeErrorValue("failTurn", finalizeCause)),
      Effect.flatMap(() => serviceError("runThreadTurn.provider", cause)),
    )
}

const loadSelectedArtifacts = (
  artifactIds: readonly Parameters<Context.Tag.Service<AgentRunArtifactStore>["get"]>[0][],
  threadId: ReviewThreadId,
  store: Context.Tag.Service<AgentRunArtifactStore>,
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

type ProviderRegistry = Context.Tag.Service<AgentProviderRegistry>

interface ResolvedReviewProvider {
  readonly registration: AgentProviderRegistration
  readonly capability: NonNullable<AgentProviderRegistration["reviewThread"]>
}

const resolveReviewProvider = (
  registry: ProviderRegistry,
  route: AgentProviderRoute,
): Effect.Effect<ResolvedReviewProvider, unknown> => {
  const resolveProvider = (
    remaining: readonly AgentProviderId[],
  ): Effect.Effect<ResolvedReviewProvider, unknown> => {
    const [providerId, ...rest] = remaining
    if (providerId === undefined) {
      return serviceError(
        "runThreadTurn.resolveProvider",
        new Error("No review agent provider is available"),
      )
    }
    return Effect.gen(function* () {
      const registration = yield* registry.get(providerId)
      const capability = yield* registry.resolveReviewThread({ mode: "provider", providerId })
      return { registration, capability }
    }).pipe(
      Effect.catchAll((cause) =>
        route.mode === "auto" && rest.length > 0 ? resolveProvider(rest) : Effect.fail(cause),
      ),
    )
  }
  return resolveProvider(registry.reviewThreadRoute(route))
}

const modelForProvider = (
  manifest: AgentProviderManifest,
  selection: ReviewAgentRouteSelection,
  providerId: AgentProviderId,
) => {
  const reviewModels = manifest.models.filter((model) =>
    model.capabilities.includes("review-thread"),
  )
  const configured = selection.models[providerId]
  const selected =
    selection.route.mode === "auto"
      ? reviewModels.find((model) => model.quality === selection.autoQuality)?.id
      : configured === undefined
        ? manifest.defaults.reviewThreadModel
        : AgentModelId.make(configured)
  return selected === null ||
    selected === undefined ||
    !reviewModels.some(({ id }) => id === selected)
    ? serviceError(
        "runThreadTurn.resolveModel",
        new Error(`No review-thread model is configured for provider: ${providerId}`),
      )
    : Effect.succeed(selected)
}

const reviewExecutionPolicy = (providerPublishingTools: readonly string[]) =>
  makeNonMutatingAgentExecutionPolicy({
    network: "allow",
    repository: "reviewed-revision",
    shell: "read-only",
    providerPublishingTools: [...new Set(providerPublishingTools)],
    allowedMcpTools: DIFFDASH_REVIEW_MCP_TOOLS,
  })

const userSafeFailure = (provider: ReviewAgentProviderId, cause: unknown) => {
  const reason = executionFailureReason(cause)
  return cause instanceof HostedReviewWorkspacePoolError
    ? reason
    : `The local ${provider} agent could not complete this response: ${reason}. Retry to try again.`
}

const executionFailureReason = (cause: unknown) => {
  const reason =
    typeof cause === "object" && cause !== null && "reason" in cause
      ? String(cause.reason)
      : cause instanceof Error
        ? cause.message
        : "Review agent execution failed"
  return boundedProviderDiagnostic(reason)
}

const serviceError = (operation: string, cause: unknown) =>
  Effect.fail(serviceErrorValue(operation, cause))

const serviceErrorValue = (operation: string, cause: unknown) =>
  ReviewAgentServiceError.make({
    operation,
    reason: executionFailureReason(cause),
    cause,
  })

const finalizeErrorValue = (operation: "completeTurn" | "failTurn", cause: unknown) =>
  ReviewAgentFinalizeError.make({
    operation,
    reason: executionFailureReason(cause),
    cause,
  })

const isReviewAgentTurnError = (
  cause: unknown,
): cause is
  | ReviewAgentServiceError
  | ReviewAgentFinalizeError
  | ReviewTurnTargetError
  | ReviewTurnRejectedError =>
  cause instanceof ReviewAgentServiceError ||
  cause instanceof ReviewAgentFinalizeError ||
  cause instanceof ReviewTurnTargetError ||
  cause instanceof ReviewTurnRejectedError

const reportProgress = (
  reporter: ((stage: ReviewAgentProgressStage) => Effect.Effect<void>) | undefined,
  stage: ReviewAgentProgressStage,
) => reporter?.(stage) ?? Effect.void
