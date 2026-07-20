import { Effect, Redacted } from "effect"

import {
  AgentExecutionPolicy,
  AgentModelId,
  AgentProviderOperationError,
  McpToolName,
  ReviewRevision,
  type ReviewThreadRequest,
  ScopedMcpResult,
  WalkthroughRequest,
} from "@diffdash/agent-provider"
import {
  agentManifestConformance,
  agentSecurityConformance,
  reviewConformance,
  walkthroughConformance,
} from "@diffdash/agent-provider/testing"
import { makeFixtureAgentProvider } from "./fixture"

const model = AgentModelId.make("fixture-model")
const allowedTool = McpToolName.make("getReviewContext")
const policy = AgentExecutionPolicy.make({
  network: "deny",
  sensitiveFiles: "deny",
  repository: "reviewed-revision",
  shell: "deny",
  fileMutation: "deny",
  gitMutation: "deny",
  providerPublishing: "deny",
  providerPublishingTools: [],
  allowedMcpTools: [allowedTool],
})
const walkthroughRequest = () =>
  WalkthroughRequest.make({
    prompt: "Explain the fixture review",
    model,
    workingDirectory: "/tmp/fixture-review",
    timeoutMs: 1_000,
    reasoningEffort: "low",
    policy,
  })
const reviewRequest = (): ReviewThreadRequest => ({
  stablePrompt: "Fixture review context",
  dynamicPrompt: "Review this line",
  model,
  workingDirectory: "/tmp/fixture-review",
  revision: ReviewRevision.make("fixture-revision"),
  timeoutMs: 1_000,
  sessionId: null,
  mcp: {
    scopeId: "fixture-scope",
    endpoint: "http://127.0.0.1/mcp",
    bearerToken: Redacted.make("fixture-secret-token"),
    allowedTools: [allowedTool],
    call: () => Effect.succeed(ScopedMcpResult.make({ content: "context", isError: false })),
  },
  policy,
})

agentManifestConformance("Fixture Agent", { create: makeFixtureAgentProvider })
walkthroughConformance("Fixture Agent", {
  create: makeFixtureAgentProvider,
  request: walkthroughRequest,
  expectedFailure: () =>
    Effect.fail(
      AgentProviderOperationError.make({
        providerId: makeFixtureAgentProvider().manifest.descriptor.id,
        capability: "walkthrough",
        reason: "fixture failure",
      }),
    ),
  temporaryFiles: () => Effect.succeed([]),
})
reviewConformance("Fixture Agent", { create: makeFixtureAgentProvider, request: reviewRequest })
agentSecurityConformance("Fixture Agent", {
  run: () => {
    const capability = makeFixtureAgentProvider().reviewThread
    if (capability === undefined) {
      return Effect.fail(
        AgentProviderOperationError.make({
          providerId: makeFixtureAgentProvider().manifest.descriptor.id,
          capability: "review-thread",
          reason: "Fixture review capability is missing",
        }),
      )
    }
    return capability.execute(reviewRequest()).pipe(
      Effect.mapError((cause) =>
        cause instanceof AgentProviderOperationError
          ? cause
          : AgentProviderOperationError.make({
              providerId: makeFixtureAgentProvider().manifest.descriptor.id,
              capability: "review-thread",
              reason: cause.reason,
            }),
      ),
    )
  },
  repositoryState: () => Effect.succeed("unchanged"),
  mcpToken: "fixture-secret-token",
  sensitiveValues: ["fixture-private-value"],
  maxArtifactLength: 64 * 1024,
  allowedTools: [allowedTool],
  observedTools: () => [allowedTool],
})
