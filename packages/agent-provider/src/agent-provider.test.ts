import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"

import {
  AgentArtifactCandidate,
  AgentCapabilityDeclaration,
  AgentCapabilityManifest,
  AgentCapabilityPolicyUnsupported,
  AgentCapabilityReady,
  AgentExecutionPolicy,
  AgentModelDescriptor,
  AgentModelId,
  AgentProviderDefaults,
  AgentProviderDescriptor,
  AgentProviderId,
  AgentProviderManifest,
  AgentProviderOperationError,
  type AgentProviderRegistration,
  AgentRuntimeRequirement,
  AgentSessionId,
  AgentSessionSupport,
  AgentUsage,
  McpToolName,
  ReviewRevision,
  type ReviewThreadRequest,
  ReviewThreadResponse,
  ReviewThreadResult,
  ScopedMcpResult,
  WalkthroughRequest,
  WalkthroughResult,
  isAgentExecutionPolicyEnforced,
} from "./agent-provider"
import {
  agentCancellationConformance,
  agentManifestConformance,
  agentRegistryConformance,
  agentSecurityConformance,
  reviewConformance,
  walkthroughConformance,
} from "./testing"
import { isScopedMcpToolSubset } from "./security"

const walkthroughId = AgentProviderId.make("walkthrough-provider")
const reviewId = AgentProviderId.make("review-provider")
const modelId = AgentModelId.make("model")
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

const manifest = (
  id: AgentProviderId,
  walkthrough: boolean,
  reviewThread: boolean,
  session: "none" | "resume" = "none",
) =>
  AgentProviderManifest.make({
    descriptor: AgentProviderDescriptor.make({
      id,
      displayName: id,
      description: "Fixture provider",
      homepage: null,
    }),
    models: [
      AgentModelDescriptor.make({
        id: modelId,
        displayName: "Model",
        capabilities: [
          ...(walkthrough ? (["walkthrough"] as const) : []),
          ...(reviewThread ? (["review-thread"] as const) : []),
        ],
        quality: "balanced",
      }),
    ],
    defaults: AgentProviderDefaults.make({
      walkthroughModel: walkthrough ? modelId : null,
      reviewThreadModel: reviewThread ? modelId : null,
    }),
    requirements: [
      AgentRuntimeRequirement.make({ name: "fixture", versionRange: ">=1", installHint: null }),
    ],
    capabilities: AgentCapabilityManifest.make({
      walkthrough: AgentCapabilityDeclaration.make({
        supported: walkthrough,
        autoPriority: walkthrough ? 10 : null,
      }),
      reviewThread: AgentCapabilityDeclaration.make({
        supported: reviewThread,
        autoPriority: reviewThread ? 10 : null,
      }),
    }),
    session: AgentSessionSupport.make({ mode: session }),
  })

const walkthroughRequest = WalkthroughRequest.make({
  prompt: "Explain the review",
  model: modelId,
  workingDirectory: "/tmp/review",
  timeoutMs: 1_000,
  reasoningEffort: "low",
  policy,
})

const reviewRequest = (): ReviewThreadRequest => ({
  stablePrompt: "Review context",
  dynamicPrompt: "Question",
  model: modelId,
  workingDirectory: "/tmp/review",
  revision: ReviewRevision.make("abc123"),
  timeoutMs: 1_000,
  sessionId: null,
  mcp: {
    scopeId: "scope",
    endpoint: "http://127.0.0.1/mcp",
    bearerToken: Redacted.make("secret-token"),
    allowedTools: [allowedTool],
    call: () => Effect.succeed(ScopedMcpResult.make({ content: "context", isError: false })),
  },
  policy,
})

const reviewResult = ReviewThreadResult.make({
  response: ReviewThreadResponse.make({
    bodyMarkdown: "Review response",
    threadSummary: null,
    referencedLocations: [],
  }),
  usage: AgentUsage.make({
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
  }),
  artifacts: [
    AgentArtifactCandidate.make({
      type: "mcp-tool-result",
      title: "Review context",
      content: "safe",
      metadata: {},
    }),
  ],
  sessionId: null,
})

const walkthroughRegistration = (): AgentProviderRegistration => ({
  manifest: manifest(walkthroughId, true, false),
  walkthrough: {
    probe: Effect.succeed(
      AgentCapabilityReady.make({ capability: "walkthrough", runtimeVersion: "1.0.0" }),
    ),
    execute: () => Effect.succeed(WalkthroughResult.make({ text: "Walkthrough" })),
  },
})

const reviewRegistration = (): AgentProviderRegistration => ({
  manifest: manifest(reviewId, false, true),
  reviewThread: {
    probe: Effect.succeed(
      AgentCapabilityReady.make({ capability: "review-thread", runtimeVersion: "1.0.0" }),
    ),
    execute: (request) =>
      isScopedMcpToolSubset(request.mcp.allowedTools, request.policy.allowedMcpTools)
        ? Effect.succeed(reviewResult)
        : AgentProviderOperationError.make({
            providerId: reviewId,
            capability: "review-thread",
            reason: "Scoped MCP access includes tools outside the execution policy",
          }),
  },
})

agentManifestConformance("fixture", { create: walkthroughRegistration })
walkthroughConformance("fixture", {
  create: walkthroughRegistration,
  request: () => walkthroughRequest,
  expectedFailure: () =>
    Effect.fail(
      AgentProviderOperationError.make({
        providerId: walkthroughId,
        capability: "walkthrough",
        reason: "fixture failure",
      }),
    ),
  temporaryFiles: () => Effect.succeed([]),
})
reviewConformance("fixture", { create: reviewRegistration, request: reviewRequest })
agentSecurityConformance("fixture", {
  run: () => Effect.succeed(reviewResult),
  repositoryState: () => Effect.succeed("clean"),
  mcpToken: "secret-token",
  sensitiveValues: ["private-value"],
  maxArtifactLength: 100,
  allowedTools: [allowedTool],
  observedTools: () => [allowedTool],
})
agentRegistryConformance("fixture", {
  registrations: () => [walkthroughRegistration(), reviewRegistration()],
  policies: { walkthrough: [walkthroughId], reviewThread: [reviewId] },
  walkthroughAutoProviderId: walkthroughId,
  reviewAutoProviderId: reviewId,
  unsupportedWalkthroughProviderId: reviewId,
})

agentCancellationConformance("fixture", {
  createRun: () => {
    let cleaned = false
    return {
      run: Effect.never.pipe(Effect.ensuring(Effect.sync(() => void (cleaned = true)))),
      cleanedUp: Effect.sync(() => cleaned),
    }
  },
})

describe("capability policy probes", () => {
  it("model policy enforcement separately from runtime availability", () => {
    const result = AgentCapabilityPolicyUnsupported.make({
      capability: "review-thread",
      reason: "read-only shell is unavailable",
    })
    expect(result).toBeInstanceOf(AgentCapabilityPolicyUnsupported)
  })

  it("keeps session IDs open", () => {
    expect(AgentSessionId.make("vendor-session-1")).toBe("vendor-session-1")
  })

  it("accepts an enforced policy that is stricter than the requested policy", () => {
    const enforced = AgentExecutionPolicy.make({ ...policy, shell: "deny", allowedMcpTools: [] })
    const requested = AgentExecutionPolicy.make({ ...policy, shell: "read-only" })
    expect(isAgentExecutionPolicyEnforced(requested, enforced)).toBe(true)
    expect(isAgentExecutionPolicyEnforced(enforced, requested)).toBe(false)
  })
})
