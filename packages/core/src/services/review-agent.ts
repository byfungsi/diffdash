import { randomUUID } from "node:crypto"
import {
  ReviewThreadAgentEngine,
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
import type { ReviewProjectId } from "@diffdash/domain/review-identity"
import type { RepositoryCheckoutPath, RepositoryLocalPath } from "@diffdash/domain/repository"
import {
  ReviewAgentArtifactId,
  type ReviewAgentProgressStage,
  ReviewAgentProviderId,
} from "@diffdash/domain/review-agent"
import {
  HostedReviewSnapshot,
  LocalReviewSnapshot,
  RepositoryComparisonSnapshot,
  type ReviewSnapshot,
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
interface RunReviewAgentTurnInput {
  readonly threadId: ReviewThreadId
  readonly repoId: ReviewProjectId
  readonly target: ReviewThreadTarget
  readonly mapping: ReviewTurnMappingToken
  readonly snapshot: ReviewSnapshot
  readonly cwd: RepositoryLocalPath
  readonly walkthrough: Option.Option<StoredWalkthrough>
  readonly onProgress?: (stage: ReviewAgentProgressStage) => Effect.Effect<void>
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

      return ReviewAgentService.of({
        runThreadTurn: (input) =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* validateReviewSnapshot(input)
              const selection = yield* routing.get
              const route = providerRoute(selection.selection)
              const providerCandidates = yield* resolveReviewProviders(
                providers,
                selection.selection,
              )
              if (Schema.is(LocalReviewSnapshot)(input.snapshot) && input.cwd === null) {
                return yield* serviceError(
                  "runThreadTurn.workingDirectory",
                  new Error("Local review execution requires a working directory"),
                )
              }
              const hostedExecution = yield* prepareHostedExecution(input.snapshot, gitProviders)
              const comparisonExecution = yield* prepareComparisonExecution(
                input.snapshot,
                gitProviders,
                input.cwd,
              )
              const publishingTools = (yield* gitProviders.list).flatMap(
                (registration) => registration.publishingTools,
              )
              const runCandidate = Effect.fn("ReviewAgentService.runCandidate")(function* (
                provider: ResolvedReviewProvider,
              ) {
                const providerId = provider.registration.manifest.descriptor.id
                const persistedProviderId = ReviewAgentProviderId.make(providerId)
                const model = provider.model
                const begun = yield* turns.beginTurn({
                  threadId: input.threadId,
                  target: input.target,
                  repoId: input.repoId,
                  reviewKey: input.snapshot.reviewKey,
                  baseRevision: input.snapshot.baseRevision,
                  headRevision: input.snapshot.headRevision,
                  mapping: input.mapping,
                  provider: persistedProviderId,
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
                            snapshot: input.snapshot,
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
                          snapshot: input.snapshot,
                          thread: begun.details.thread,
                          messages: memoryWindow.messages,
                          latestUserMessage: begun.latestUserMessage,
                          threadSummary: memoryWindow.memory?.summary ?? null,
                          priorArtifacts,
                          providerId,
                          capability: provider.capability,
                          model,
                          workingDirectory: cwd,
                          revision: input.snapshot.headRevision,
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

                  if (comparisonExecution !== null) {
                    return yield* workspaces.useComparison(comparisonExecution, runProvider)
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
                    (lease) => runProvider(lease.localPath),
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
              })

              const runCandidates: (
                remaining: readonly ResolvedReviewProvider[],
              ) => Effect.Effect<ReviewThreadDetails, CoreExpectedCause> = Effect.fn(
                "ReviewAgentService.runCandidates",
              )(
                (remaining): Effect.Effect<ReviewThreadDetails, CoreExpectedCause> =>
                  Effect.gen(function* () {
                    const [provider, ...rest] = remaining
                    if (provider === undefined) {
                      return yield* providerFailureError(
                        AgentProviderId.make("unavailable"),
                        "configuration",
                        new Error("No review agent provider is available"),
                      )
                    }
                    const readiness = yield* provider.ready.pipe(Effect.result)
                    if (Result.isFailure(readiness)) {
                      return route.mode === "auto" && rest.length > 0
                        ? yield* runCandidates(rest)
                        : yield* Effect.fail(readiness.failure)
                    }
                    return yield* runCandidate(provider).pipe(
                      Effect.catch((cause) =>
                        route.mode === "auto" &&
                        rest.length > 0 &&
                        Schema.is(ReviewAgentProviderFailureError)(cause)
                          ? runCandidates(rest)
                          : Effect.fail(cause),
                      ),
                    )
                  }),
              )

              return yield* runCandidates(providerCandidates)
            }).pipe(
              Effect.mapError((cause) =>
                isReviewAgentTurnError(cause)
                  ? cause
                  : (publicPreflightFailure(cause) ??
                    serviceErrorValue("runThreadTurn.preflight", cause)),
              ),
            ),
          ),
      })
    }),
  ).pipe(Layer.provide(ReviewThreadAgentEngine.layer))
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

type GitProviderRegistryService = Context.Service.Shape<typeof GitProviderRegistry>

const prepareHostedExecution = (snapshot: ReviewSnapshot, registry: GitProviderRegistryService) => {
  if (!Schema.is(HostedReviewSnapshot)(snapshot)) return Effect.succeed(null)
  return Effect.gen(function* () {
    const review = snapshot.detail.summary.locator
    const provider = yield* registry.get(review.repository.providerId)
    const checkout = yield* provider.checkoutSpec(review, snapshot.headRevision)
    return {
      checkout,
      bootstrapBareRepository: (destination: RepositoryCheckoutPath) =>
        provider.bootstrapBareRepository(checkout.repository, destination),
    }
  })
}

const prepareComparisonExecution = (
  snapshot: ReviewSnapshot,
  registry: GitProviderRegistryService,
  sourcePath: RepositoryLocalPath,
) => {
  if (!Schema.is(RepositoryComparisonSnapshot)(snapshot)) return Effect.succeed(null)
  return Effect.gen(function* () {
    const target = snapshot.detail.target
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

const reportProgress = (
  reporter: ((stage: ReviewAgentProgressStage) => Effect.Effect<void>) | undefined,
  stage: ReviewAgentProgressStage,
) => reporter?.(stage) ?? Effect.void
