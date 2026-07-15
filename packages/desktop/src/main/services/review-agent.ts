import { Context, Effect, Layer, Option, Schema } from "effect"
import {
  AgentPromptVersion,
  ThreadMemorySummaryAlgorithm,
  UpsertThreadMemoryInput,
} from "@diffdash/domain/agent-run"
import { type AISettings, autoModelProviderModels } from "@diffdash/domain/ai-settings"
import {
  AgentRunId,
  type ReviewAgentProgressStage,
  type ReviewAgentProviderId,
  ReviewAgentTurnInput,
  ReviewAgentTurnResult,
  THREAD_MODE_REVIEW_AGENT_PERMISSIONS,
} from "@diffdash/domain/review-agent"
import { PullRequestReviewSnapshot, type ReviewSnapshot } from "@diffdash/domain/review-context"
import {
  MarkdownBody,
  type ReviewThreadDetails,
  type ReviewThreadId,
  type ReviewThreadMessage,
} from "@diffdash/domain/review-thread"
import type { StoredWalkthrough } from "@diffdash/domain/walkthrough"
import { AgentRunArtifactStore } from "./agent-run-artifact-store"
import { AgentRunStore } from "./agent-run-store"
import { AppSettings } from "@diffdash/settings/app-settings"
import { DiffDashMcpServer } from "./diffdash-mcp-server"
import { executionFailureReason } from "./review-agent-provider"
import { ReviewAgentProviderRegistry } from "./review-agent-provider-registry"
import { ReviewContextBuilder, type SelectedReviewAgentArtifact } from "./review-context-builder"
import { ReviewThreadStore } from "./review-thread-store"
import { ReviewWorktreePool, ReviewWorktreePoolError } from "./review-worktree-pool"
import { createFallbackThreadMemoryUpdate, selectThreadMemoryWindow } from "./thread-memory"
import { ThreadMemoryStore } from "./thread-memory-store"

const REVIEW_THREAD_PROMPT_VERSION = AgentPromptVersion.make("review-thread-v3")
const PROVIDER_SUMMARY_ALGORITHM = ThreadMemorySummaryAlgorithm.make("provider-summary")

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
      const settingsStore = yield* AppSettings
      const providers = yield* ReviewAgentProviderRegistry
      const threads = yield* ReviewThreadStore
      const runs = yield* AgentRunStore
      const artifacts = yield* AgentRunArtifactStore
      const memories = yield* ThreadMemoryStore
      const contextBuilder = yield* ReviewContextBuilder
      const mcp = yield* DiffDashMcpServer
      const worktrees = yield* ReviewWorktreePool
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
                  const settings = yield* settingsStore.get
                  const provider = yield* providers.resolve(settings.provider)
                  const model = modelForProvider(settings, provider.id)
                  const priorRuns = yield* runs.listForThread(input.threadId)
                  const providerRunId = priorRuns.find(
                    (run) =>
                      run.provider === provider.id &&
                      run.status === "completed" &&
                      run.providerRunId !== null,
                  )?.providerRunId
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
                    provider: provider.id,
                    model,
                    promptVersion: REVIEW_THREAD_PROMPT_VERSION,
                  })
                  const pendingMessage = yield* threads.createPendingAgentMessage({
                    threadId: input.threadId,
                    agentRunId: run.id,
                  })

                  const execute = Effect.gen(function* () {
                    const currentAnchor = requireCurrentAnchor(details.thread.currentAnchor)
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
                          const providerResult = yield* provider.runThreadTurn(
                            ReviewAgentTurnInput.make({
                              threadId: input.threadId,
                              reviewKey: details.thread.reviewKey,
                              baseRevision: input.snapshot.baseRevision,
                              headRevision: input.snapshot.headRevision,
                              anchor: currentAnchor,
                              stablePromptPrefix: prompt.stablePromptPrefix,
                              dynamicPromptSuffix: prompt.dynamicPromptSuffix,
                              cwd,
                              model,
                              permissions: THREAD_MODE_REVIEW_AGENT_PERMISSIONS,
                            }),
                            { mcp: access, providerRunId: providerRunId ?? null },
                          )
                          return yield* Schema.decodeUnknown(ReviewAgentTurnResult)(providerResult)
                        }),
                      )
                    const result =
                      input.snapshot instanceof PullRequestReviewSnapshot
                        ? yield* worktrees.use(
                            {
                              runId: run.id,
                              threadId: input.threadId,
                              snapshot: input.snapshot,
                              sourcePath: input.cwd,
                            },
                            (lease) => runProvider(lease.localPath),
                            input.onProgress,
                          )
                        : yield* runProvider(input.cwd)
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
                        const failure = userSafeFailure(provider.id, cause)
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

const modelForProvider = (settings: AISettings, provider: ReviewAgentProviderId) => {
  if (settings.provider !== "auto") return settings.models[provider]
  const models = autoModelProviderModels(settings.models.auto)
  if (provider === "claude") return models.claude
  if (provider === "codex") return models.codex
  return models.opencodeCodex
}

const userSafeFailure = (provider: ReviewAgentProviderId, cause: unknown) =>
  cause instanceof ReviewWorktreePoolError
    ? cause.reason
    : `The local ${provider} agent could not complete this response: ${executionFailureReason(cause)}. Retry to try again.`

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
