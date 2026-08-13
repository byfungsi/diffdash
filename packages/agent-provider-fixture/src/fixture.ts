import { Effect } from "effect"

import {
  AgentCapabilityDeclaration,
  AgentCapabilityManifest,
  AgentCapabilityReady,
  AgentModelDescriptor,
  AgentModelId,
  AgentProviderDefaults,
  AgentProviderDescriptor,
  AgentProviderId,
  AgentProviderManifest,
  type AgentProviderRegistration,
  AgentRuntimeRequirement,
  AgentSessionSupport,
  ReviewThreadResult,
  WalkthroughResult,
} from "@diffdash/agent-provider"
import { ReviewThreadAgentResponse } from "@diffdash/domain/review-agent"
import { makeAgentProviderOperationErrorFactory } from "@diffdash/agent-provider/runtime"
import { isScopedMcpToolSubset } from "@diffdash/agent-provider/security"

const providerId = AgentProviderId.make("fixture-agent")
const fixtureModel = AgentModelId.make("fixture-model")
const operationErrors = makeAgentProviderOperationErrorFactory({
  providerId,
  fallbackReason: "Fixture agent execution failed",
})

/** Optional deterministic execution controls for lifecycle tests. */
export interface FixtureAgentProviderOptions {
  readonly walkthroughNeverCompletes?: boolean
}

/** Creates a deterministic provider used only when desktop E2E composition requests it. */
export const makeFixtureAgentProvider = (
  options: FixtureAgentProviderOptions = {},
): AgentProviderRegistration => ({
  manifest: AgentProviderManifest.make({
    descriptor: AgentProviderDescriptor.make({
      id: providerId,
      displayName: "Fixture Agent",
      description: "Deterministic fourth-provider composition fixture.",
      homepage: null,
    }),
    models: [
      AgentModelDescriptor.make({
        id: fixtureModel,
        displayName: "Fixture Model",
        capabilities: ["walkthrough", "review-thread"],
        quality: "balanced",
      }),
    ],
    defaults: AgentProviderDefaults.make({
      walkthroughModel: fixtureModel,
      reviewThreadModel: fixtureModel,
    }),
    requirements: [
      AgentRuntimeRequirement.make({
        name: "fixture-runtime",
        versionRange: "1",
        installHint: null,
      }),
    ],
    capabilities: AgentCapabilityManifest.make({
      walkthrough: AgentCapabilityDeclaration.make({ supported: true, autoPriority: null }),
      reviewThread: AgentCapabilityDeclaration.make({ supported: true, autoPriority: null }),
    }),
    session: AgentSessionSupport.make({ mode: "none" }),
  }),
  walkthrough: {
    probe: Effect.succeed(
      AgentCapabilityReady.make({ capability: "walkthrough", runtimeVersion: "1.0.0" }),
    ),
    execute: () => {
      const result = Effect.succeed(
        WalkthroughResult.make({
          text: JSON.stringify({
            title: "Fixture review path",
            summary: "Review the deterministic fixture change.",
            chapters: [
              {
                id: "fixture-chapter",
                title: "Fixture change",
                summary: "Inspect the fixture hunk.",
                stops: [
                  {
                    id: "fixture-stop",
                    title: "Updated fixture",
                    summary: "The fixture changes one deterministic line.",
                    risk: "review",
                    hunkIds: ["h1"],
                  },
                ],
              },
            ],
          }),
        }),
      )
      return options.walkthroughNeverCompletes === true ? Effect.never : result
    },
  },
  reviewThread: {
    probe: Effect.succeed(
      AgentCapabilityReady.make({ capability: "review-thread", runtimeVersion: "1.0.0" }),
    ),
    execute: (request) =>
      isScopedMcpToolSubset(request.mcp.allowedTools, request.policy.allowedMcpTools)
        ? Effect.succeed(
            ReviewThreadResult.make({
              response: ReviewThreadAgentResponse.make({
                bodyMarkdown: "Fixture review response",
                referencedAnchors: [],
              }),
              usage: null,
              artifacts: [],
              sessionId: null,
            }),
          )
        : operationErrors.fromReason(
            "review-thread",
            "Scoped MCP access includes tools outside the execution policy",
          ),
  },
})
