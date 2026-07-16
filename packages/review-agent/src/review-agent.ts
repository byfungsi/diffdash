import { Context, Effect, Either, Layer, Option, Schema } from "effect"
import {
  AgentExecutionPolicy,
  AgentModelId,
  type AgentModelQuality,
  type AgentProviderId,
  type AgentProviderManifest,
  type AgentProviderRegistration,
  AgentSessionId,
  DIFFDASH_REVIEW_MCP_TOOLS,
  ReviewRevision as AgentReviewRevision,
  ReviewThreadResult,
  ScopedMcpAccessError,
} from "@diffdash/agent-provider"
import { AgentProviderRegistry, type AgentProviderRoute } from "@diffdash/agent-provider/registry"
import {
  AgentPromptVersion,
  ThreadMemorySummaryAlgorithm,
  UpsertThreadMemoryInput,
} from "@diffdash/domain/agent-run"
import {
  AgentRunId,
  type ReviewAgentProgressStage,
  type ReviewAgentProviderId,
  ReviewAgentProviderRunId,
  ReviewAgentTurnResult,
  ReviewAgentUsage,
  ReviewThreadAgentResponse,
} from "@diffdash/domain/review-agent"
import { PullRequestReviewSnapshot, type ReviewSnapshot } from "@diffdash/domain/review-context"
import {
  HostedRepositoryLocator,
  HostedReviewLocator,
  HostedReviewNumber,
  HostedRepositoryName,
  RepositoryNamespace,
} from "@diffdash/domain/git-provider"
import {
  MarkdownBody,
  type ReviewThreadDetails,
  type ReviewThreadId,
  type ReviewThreadMessage,
} from "@diffdash/domain/review-thread"
import { ReviewAnchor } from "@diffdash/domain/review-thread"
import type { StoredWalkthrough } from "@diffdash/domain/walkthrough"
import { GitProviderRegistry } from "@diffdash/git-provider"
import { AgentRunArtifactStore } from "@diffdash/persistence/agent-run-artifact-store"
import { AgentRunStore } from "@diffdash/persistence/agent-run-store"
import { DiffDashMcpServer } from "./diffdash-mcp-server"
import { AgentArtifactNormalizer, normalizeAgentArtifactType } from "./agent-artifact-normalizer"
import { ReviewContextBuilder, type SelectedReviewAgentArtifact } from "./review-context-builder"
import { ReviewThreadStore } from "@diffdash/persistence/review-thread-store"
import {
  HostedReviewWorkspacePool,
  HostedReviewWorkspacePoolError,
} from "@diffdash/local-git/hosted-review-workspace-pool"
import { createFallbackThreadMemoryUpdate, selectThreadMemoryWindow } from "./thread-memory"
import { ThreadMemoryStore } from "@diffdash/persistence/thread-memory-store"

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
export interface RunReviewAgentTurnInput {
  readonly threadId: ReviewThreadId
  readonly snapshot: ReviewSnapshot
  readonly cwd: string | null
  readonly walkthrough: StoredWalkthrough | null
  readonly onProgress?: (stage: ReviewAgentProgressStage) => Effect.Effect<void>
}

/** A recoverable orchestration failure suitable for renderer error state. */
export class ReviewAgentServiceError extends Schema.TaggedError<ReviewAgentServiceError>()(
  "ReviewAgentServiceError",
  {
    operation: Schema.String,
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
    ) => Effect.Effect<ReviewThreadDetails, ReviewAgentServiceError>
  }
>() {
  static readonly layer = Layer.effect(
    ReviewAgentService,
    Effect.gen(function* () {
      const routing = yield* ReviewAgentRouting
      const providers = yield* AgentProviderRegistry
      const threads = yield* ReviewThreadStore
      const runs = yield* AgentRunStore
      const artifacts = yield* AgentRunArtifactStore
      const memories = yield* ThreadMemoryStore
      const contextBuilder = yield* ReviewContextBuilder
      const normalizer = yield* AgentArtifactNormalizer
      const mcp = yield* DiffDashMcpServer
      const workspaces = yield* HostedReviewWorkspacePool
      const gitProviders = yield* GitProviderRegistry
      const activeThreads = new Set<ReviewThreadId>()

      return ReviewAgentService.of({
        runThreadTurn: (input) =>
          Effect.acquireUseRelease(
            Effect.try({
              try: () => {
                if (activeThreads.has(input.threadId)) {
                  throw new Error("A review agent turn is already running")
                }
                activeThreads.add(input.threadId)
              },
              catch: (cause) => serviceErrorValue("runThreadTurn.acquire", cause),
            }),
            () =>
              Effect.scoped(
                Effect.gen(function* () {
                  let details = yield* threads.get(input.threadId)
                  const interruptedMessages = details.messages.filter(
                    (message) => message.author === "agent" && message.status === "pending",
                  )
                  for (const message of interruptedMessages) {
                    if (message.agentRunId !== null) {
                      const interruptedRun = yield* runs
                        .get(AgentRunId.make(message.agentRunId))
                        .pipe(Effect.option)
                      if (
                        Option.isSome(interruptedRun) &&
                        interruptedRun.value.status === "running"
                      ) {
                        yield* runs.fail({
                          runId: interruptedRun.value.id,
                          error: "The previous local agent run was interrupted.",
                        })
                      }
                    }
                    yield* threads.completeAgentMessage({
                      messageId: message.id,
                      threadId: input.threadId,
                      bodyMarkdown: MarkdownBody.make(
                        "The previous local agent run was interrupted. Retry to try again.",
                      ),
                      status: "failed",
                    })
                  }
                  if (interruptedMessages.length > 0) details = yield* threads.get(input.threadId)
                  validateReviewSnapshot(details, input.snapshot)
                  const latestUserMessage = requireUnansweredUserMessage(details.messages)
                  const selection = yield* routing.get
                  const provider = yield* resolveReviewProvider(providers, selection.route)
                  const providerId = provider.registration.manifest.descriptor.id
                  const model = modelForProvider(
                    provider.registration.manifest,
                    selection,
                    providerId,
                  )
                  const priorRuns = yield* runs.listForThread(input.threadId)
                  const providerRunId =
                    provider.registration.manifest.session.mode === "resume"
                      ? priorRuns.find(
                          (run) =>
                            run.provider === providerId &&
                            run.status === "completed" &&
                            run.providerRunId !== null,
                        )?.providerRunId
                      : undefined
                  const memory = yield* memories.get(input.threadId)
                  const memoryWindow = selectThreadMemoryWindow({
                    threadId: input.threadId,
                    memory,
                    messages: details.messages,
                  })
                  const priorArtifacts = yield* loadSelectedArtifacts(
                    memory?.importantArtifactIds ?? [],
                    input.threadId,
                    artifacts,
                  )
                  yield* reportProgress(input.onProgress, "preparing-context")
                  const prompt = yield* contextBuilder.build({
                    snapshot: input.snapshot,
                    thread: details.thread,
                    messages: memoryWindow.messages,
                    latestUserMessage,
                    threadSummary: memoryWindow.memory?.summary ?? null,
                    priorArtifacts,
                  })
                  const run = yield* runs.start({
                    threadId: input.threadId,
                    provider: providerId,
                    model,
                    promptVersion: REVIEW_THREAD_PROMPT_VERSION,
                  })
                  const pendingMessage = yield* threads.createPendingAgentMessage({
                    threadId: input.threadId,
                    agentRunId: run.id,
                  })

                  const execute = Effect.gen(function* () {
                    requireCurrentAnchor(details.thread.currentAnchor)
                    const publishingTools = (yield* gitProviders.list).flatMap(
                      (registration) => registration.publishingTools,
                    )
                    const policy = reviewExecutionPolicy(publishingTools)
                    const runProvider = (cwd: string | null) =>
                      Effect.scoped(
                        Effect.gen(function* () {
                          yield* reportProgress(input.onProgress, "starting-agent")
                          const access = yield* mcp.acquireRun({
                            runId: run.id,
                            threadId: input.threadId,
                            repoId: details.thread.repoId,
                            snapshot: input.snapshot,
                            localPath: cwd,
                            walkthrough: input.walkthrough,
                          })
                          yield* reportProgress(input.onProgress, "reviewing")
                          if (cwd === null)
                            throw new Error("Review execution requires a working directory")
                          const rawProviderResult = yield* provider.capability.execute({
                            stablePrompt: prompt.stablePromptPrefix,
                            dynamicPrompt: prompt.dynamicPromptSuffix,
                            model,
                            workingDirectory: cwd,
                            revision: AgentReviewRevision.make(input.snapshot.headRevision),
                            timeoutMs: REVIEW_THREAD_TIMEOUT_MS,
                            sessionId:
                              providerRunId == null ? null : AgentSessionId.make(providerRunId),
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
                          return yield* normalizeProviderResult(
                            providerId,
                            providerResult,
                            normalizer,
                          )
                        }),
                      )
                    let result: ReviewAgentTurnResult
                    if (input.snapshot instanceof PullRequestReviewSnapshot) {
                      const review = HostedReviewLocator.make({
                        repository: HostedRepositoryLocator.make({
                          providerId: input.snapshot.detail.providerId,
                          namespace: RepositoryNamespace.make(input.snapshot.detail.repoOwner),
                          name: HostedRepositoryName.make(input.snapshot.detail.repoName),
                        }),
                        number: HostedReviewNumber.make(input.snapshot.detail.number),
                      })
                      const gitProvider = yield* gitProviders.get(review.repository.providerId)
                      const checkout = yield* gitProvider.checkoutSpecAtRevision?.(
                        review,
                        input.snapshot.headRevision,
                      ) ?? gitProvider.checkoutSpec(review)
                      if (checkout.revision !== input.snapshot.headRevision) {
                        throw new Error("Git provider did not preserve the exact review revision")
                      }
                      result = yield* workspaces.use(
                        {
                          runId: run.id,
                          threadId: input.threadId,
                          checkout,
                          sourcePath: input.cwd,
                          bootstrapBareRepository: (destination) =>
                            gitProvider.bootstrapBareRepository(checkout.repository, destination),
                        },
                        (lease) => runProvider(lease.localPath),
                        input.onProgress,
                      )
                    } else {
                      result = yield* runProvider(input.cwd)
                    }
                    const storedArtifacts = yield* Effect.forEach(
                      result.artifacts,
                      (artifact) =>
                        artifacts.save({
                          runId: run.id,
                          threadId: input.threadId,
                          artifact,
                        }),
                      { concurrency: 1 },
                    )
                    const agentMessage = yield* threads.completeAgentMessage({
                      messageId: pendingMessage.id,
                      threadId: input.threadId,
                      bodyMarkdown: MarkdownBody.make(result.response.bodyMarkdown),
                      status: "complete",
                    })
                    yield* runs.complete({
                      runId: run.id,
                      usage: result.usage,
                      ...(result.providerRunId === null
                        ? {}
                        : { providerRunId: result.providerRunId }),
                    })
                    const completedDetails = yield* threads.get(input.threadId)
                    const importantArtifactIds = [
                      ...(memory?.importantArtifactIds ?? []),
                      ...storedArtifacts.map((artifact) => artifact.id),
                    ].slice(-20)
                    const memoryUpdate =
                      result.response.threadSummaryUpdate === undefined
                        ? createFallbackThreadMemoryUpdate({
                            threadId: input.threadId,
                            memory,
                            messages: completedDetails.messages,
                            importantArtifactIds,
                          })
                        : UpsertThreadMemoryInput.make({
                            threadId: input.threadId,
                            summary: result.response.threadSummaryUpdate,
                            summarizedThroughSequence: agentMessage.sequence,
                            summaryAlgorithm: PROVIDER_SUMMARY_ALGORITHM,
                            summaryVersion: 1,
                            importantArtifactIds,
                          })
                    if (memoryUpdate !== null) yield* memories.upsert(memoryUpdate)
                    return completedDetails
                  })

                  return yield* execute.pipe(
                    Effect.catchAll((cause) =>
                      Effect.gen(function* () {
                        const failure = userSafeFailure(providerId, cause)
                        yield* runs.fail({ runId: run.id, error: failure }).pipe(Effect.ignore)
                        yield* threads
                          .completeAgentMessage({
                            messageId: pendingMessage.id,
                            threadId: input.threadId,
                            bodyMarkdown: MarkdownBody.make(failure),
                            status: "failed",
                          })
                          .pipe(Effect.ignore)
                        return yield* serviceError("runThreadTurn.provider", cause)
                      }),
                    ),
                  )
                }).pipe(
                  Effect.mapError((cause) =>
                    cause instanceof ReviewAgentServiceError
                      ? cause
                      : serviceErrorValue("runThreadTurn", cause),
                  ),
                ),
              ),
            () => Effect.sync(() => void activeThreads.delete(input.threadId)),
          ),
      })
    }),
  )
}

const validateReviewSnapshot = (details: ReviewThreadDetails, snapshot: ReviewSnapshot) => {
  if (
    details.thread.reviewKey !== snapshot.reviewKey ||
    details.thread.currentBaseRevision !== snapshot.baseRevision ||
    details.thread.currentHeadRevision !== snapshot.headRevision
  ) {
    throw new Error("Review thread is not mapped to the current review revision")
  }
}

const requireCurrentAnchor = (anchor: ReviewThreadDetails["thread"]["currentAnchor"]) => {
  if (anchor === null)
    throw new Error("The line comment is unavailable in the current review revision")
  return anchor
}

const requireUnansweredUserMessage = (messages: readonly ReviewThreadMessage[]) => {
  let latestUser: ReviewThreadMessage | undefined
  for (const message of messages) {
    if (
      message.author === "user" &&
      (latestUser === undefined || message.sequence > latestUser.sequence)
    ) {
      latestUser = message
    }
  }
  if (latestUser === undefined) throw new Error("Review thread has no user message")
  const laterAgents = messages.filter(
    (message) => message.author === "agent" && message.sequence > latestUser.sequence,
  )
  if (laterAgents.some((message) => message.status === "pending")) {
    throw new Error("A review agent turn is already running")
  }
  if (laterAgents.some((message) => message.status === "complete")) {
    throw new Error("The latest user message already has an agent response")
  }
  return latestUser
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
  const resolve = (
    remaining: readonly AgentProviderId[],
  ): Effect.Effect<ResolvedReviewProvider, unknown> => {
    const [providerId, ...rest] = remaining
    if (providerId === undefined) return Effect.dieMessage("No review agent provider is available")
    return Effect.gen(function* () {
      const registration = yield* registry.get(providerId)
      const capability = yield* registry.resolveReviewThread({ mode: "provider", providerId })
      return { registration, capability }
    }).pipe(
      Effect.catchAll((cause) =>
        route.mode === "auto" && rest.length > 0 ? resolve(rest) : Effect.fail(cause),
      ),
    )
  }
  return resolve(registry.reviewThreadRoute(route))
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
  if (
    selected === null ||
    selected === undefined ||
    !reviewModels.some(({ id }) => id === selected)
  ) {
    throw new Error(`No review-thread model is configured for provider: ${providerId}`)
  }
  return selected
}

const reviewExecutionPolicy = (providerPublishingTools: readonly string[]) =>
  AgentExecutionPolicy.make({
    network: "allow",
    sensitiveFiles: "deny",
    repository: "reviewed-revision",
    shell: "read-only",
    fileMutation: "deny",
    gitMutation: "deny",
    providerPublishing: "deny",
    providerPublishingTools: [...new Set(providerPublishingTools)],
    allowedMcpTools: DIFFDASH_REVIEW_MCP_TOOLS,
  })

const normalizeProviderResult = (
  providerId: AgentProviderId,
  result: ReviewThreadResult,
  normalizer: Context.Tag.Service<AgentArtifactNormalizer>,
) =>
  Effect.forEach(
    result.artifacts,
    (artifact) =>
      normalizer.normalize({
        provider: providerId,
        type: normalizeAgentArtifactType(artifact.type),
        title: artifact.title,
        content: artifact.content,
        metadata: artifact.metadata,
      }),
    { concurrency: 1 },
  ).pipe(
    Effect.map((artifacts) =>
      ReviewAgentTurnResult.make({
        response: ReviewThreadAgentResponse.make({
          bodyMarkdown: result.response.bodyMarkdown,
          ...(result.response.threadSummary === null
            ? {}
            : { threadSummaryUpdate: result.response.threadSummary }),
          ...(result.response.referencedLocations.length === 0
            ? {}
            : { referencedAnchors: decodeReferencedAnchors(result.response.referencedLocations) }),
        }),
        artifacts,
        providerRunId:
          result.sessionId === null ? null : ReviewAgentProviderRunId.make(result.sessionId),
        usage:
          result.usage === null
            ? null
            : ReviewAgentUsage.make({
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
                cacheReadTokens: result.usage.cacheReadTokens,
                cacheWriteTokens: result.usage.cacheWriteTokens,
                costUsd: result.usage.costUsd,
              }),
      }),
    ),
  )

const decodeReferencedAnchors = (locations: readonly string[]) =>
  locations.flatMap((location) => {
    try {
      const decoded = Schema.decodeUnknownEither(ReviewAnchor)(JSON.parse(location) as unknown)
      return Either.isRight(decoded) ? [decoded.right] : []
    } catch {
      return []
    }
  })

const userSafeFailure = (provider: ReviewAgentProviderId, cause: unknown) =>
  cause instanceof HostedReviewWorkspacePoolError
    ? cause.reason
    : `The local ${provider} agent could not complete this response: ${executionFailureReason(cause)}. Retry to try again.`

const executionFailureReason = (cause: unknown) => {
  const reason =
    typeof cause === "object" && cause !== null && "reason" in cause
      ? String(cause.reason)
      : cause instanceof Error
        ? cause.message
        : "Review agent execution failed"
  return redactDiagnostic(reason).slice(-600)
}

const redactDiagnostic = (value: string) =>
  value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [redacted]")
    .replace(/DIFFDASH_MCP_BEARER_TOKEN=[^\s]+/giu, "DIFFDASH_MCP_BEARER_TOKEN=[redacted]")
    .replace(/\s+/gu, " ")
    .trim()

const serviceError = (operation: string, cause: unknown) =>
  Effect.fail(serviceErrorValue(operation, cause))

const serviceErrorValue = (operation: string, cause: unknown) =>
  ReviewAgentServiceError.make({
    operation,
    reason: cause instanceof Error ? cause.message : "Review agent turn failed",
    cause,
  })

const reportProgress = (
  reporter: ((stage: ReviewAgentProgressStage) => Effect.Effect<void>) | undefined,
  stage: ReviewAgentProgressStage,
) => reporter?.(stage) ?? Effect.void
