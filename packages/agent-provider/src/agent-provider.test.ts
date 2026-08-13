import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted, Result } from "effect"

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
  InvalidAgentProviderRegistrationError,
  type AgentProviderRegistration,
  AgentRuntimeRequirement,
  AgentSessionId,
  AgentSessionSupport,
  AgentUsage,
  McpToolName,
  type ReviewThreadRequest,
  ReviewThreadResult,
  ScopedMcpResult,
  WalkthroughRequest,
  WalkthroughResult,
  isAgentExecutionPolicyEnforced,
} from "./agent-provider"
import { ReviewThreadAgentResponse } from "@diffdash/domain/review-agent"
import { ReviewRevision } from "@diffdash/domain/review-identity"
import {
  agentCancellationConformance,
  agentManifestConformance,
  agentRegistryConformance,
  agentSecurityConformance,
  reviewConformance,
  walkthroughConformance,
} from "./testing"
import { isScopedMcpToolSubset } from "./security"
import { makeAgentProviderOperationErrorFactory } from "./runtime"
import { AgentProviderRegistry } from "./registry"

const walkthroughId = AgentProviderId.make("walkthrough-provider")
const reviewId = AgentProviderId.make("review-provider")
const modelId = AgentModelId.make("model")
const allowedTool = McpToolName.make("getReviewContext")
const walkthroughErrors = makeAgentProviderOperationErrorFactory({
  providerId: walkthroughId,
  fallbackReason: "fixture failure",
})
const reviewErrors = makeAgentProviderOperationErrorFactory({
  providerId: reviewId,
  fallbackReason: "fixture failure",
})
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
  response: ReviewThreadAgentResponse.make({
    bodyMarkdown: "Review response",
    referencedAnchors: [],
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
        : reviewErrors.fromReason(
            "review-thread",
            "Scoped MCP access includes tools outside the execution policy",
            "policy-violation",
          ),
  },
})

agentManifestConformance("fixture", { create: walkthroughRegistration })
walkthroughConformance("fixture", {
  create: walkthroughRegistration,
  request: () => walkthroughRequest,
  expectedFailure: () =>
    Effect.fail(walkthroughErrors.fromReason("walkthrough", "fixture failure")),
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

describe("provider registration validation", () => {
  it.effect("rejects manifest declarations without matching implementations", () => {
    const registration = walkthroughRegistration()
    const inconsistent: AgentProviderRegistration = {
      manifest: registration.manifest,
    }
    return Effect.gen(function* () {
      const result = yield* AgentProviderRegistry.pipe(
        Effect.provide(
          AgentProviderRegistry.layer([inconsistent], {
            walkthrough: [walkthroughId],
            reviewThread: [],
          }),
        ),
        Effect.result,
      )
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(InvalidAgentProviderRegistrationError)
      }
    })
  })

  it.effect("rejects implementations omitted from the manifest declaration", () => {
    const registration = walkthroughRegistration()
    const inconsistent: AgentProviderRegistration = {
      ...registration,
      manifest: manifest(walkthroughId, false, false),
    }
    return Effect.gen(function* () {
      const result = yield* AgentProviderRegistry.pipe(
        Effect.provide(
          AgentProviderRegistry.layer([inconsistent], {
            walkthrough: [],
            reviewThread: [],
          }),
        ),
        Effect.result,
      )
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(InvalidAgentProviderRegistrationError)
      }
    })
  })

  it.effect("rejects probe evidence tagged for another capability", () => {
    const registration = walkthroughRegistration()
    const walkthrough = registration.walkthrough
    if (walkthrough === undefined) throw new Error("Missing walkthrough fixture")
    const inconsistent: AgentProviderRegistration = {
      ...registration,
      walkthrough: {
        ...walkthrough,
        probe: Effect.succeed(
          AgentCapabilityReady.make({ capability: "review-thread", runtimeVersion: "1" }),
        ),
      },
    }
    return Effect.gen(function* () {
      const registry = yield* AgentProviderRegistry
      const result = yield* registry
        .resolveWalkthroughCandidates({ mode: "provider", providerId: walkthroughId })
        .pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(InvalidAgentProviderRegistrationError)
      }
    }).pipe(
      Effect.provide(
        AgentProviderRegistry.layer([inconsistent], {
          walkthrough: [walkthroughId],
          reviewThread: [],
        }),
      ),
    )
  })

  it.effect("returns automatic candidates without probing lower priorities", () => {
    const fallbackId = AgentProviderId.make("fallback")
    let primaryProbes = 0
    let fallbackProbes = 0
    const primary = walkthroughRegistration()
    const fallback = walkthroughRegistration()
    const primaryWalkthrough = primary.walkthrough
    const fallbackWalkthrough = fallback.walkthrough
    if (primaryWalkthrough === undefined || fallbackWalkthrough === undefined) {
      throw new Error("Missing walkthrough fixture")
    }
    const registrations: AgentProviderRegistration[] = [
      {
        ...primary,
        walkthrough: {
          ...primaryWalkthrough,
          probe: Effect.sync(() => {
            primaryProbes += 1
            return AgentCapabilityReady.make({ capability: "walkthrough", runtimeVersion: "1" })
          }),
        },
      },
      {
        ...fallback,
        manifest: manifest(fallbackId, true, false),
        walkthrough: {
          ...fallbackWalkthrough,
          probe: Effect.sync(() => {
            fallbackProbes += 1
            return AgentCapabilityReady.make({ capability: "walkthrough", runtimeVersion: "1" })
          }),
        },
      },
    ]
    return Effect.gen(function* () {
      const registry = yield* AgentProviderRegistry
      const candidates = yield* registry.resolveWalkthroughCandidates({ mode: "auto" })
      expect(primaryProbes).toBe(0)
      expect(fallbackProbes).toBe(0)
      yield* candidates[0]!.ready
      expect(primaryProbes).toBe(1)
      expect(fallbackProbes).toBe(0)
    }).pipe(
      Effect.provide(
        AgentProviderRegistry.layer(registrations, {
          walkthrough: [walkthroughId, fallbackId],
          reviewThread: [],
        }),
      ),
    )
  })
})
