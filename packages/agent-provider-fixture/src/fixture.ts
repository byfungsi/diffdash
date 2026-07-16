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
  ReviewThreadResponse,
  ReviewThreadResult,
  WalkthroughResult,
} from "@diffdash/agent-provider"

/** Stable identity used by the fourth-provider composition proof. */
export const FIXTURE_AGENT_PROVIDER_ID = AgentProviderId.make("fixture-agent")

const fixtureModel = AgentModelId.make("fixture-model")

/** Creates a deterministic provider used only when desktop E2E composition requests it. */
export const makeFixtureAgentProvider = (): AgentProviderRegistration => ({
  manifest: AgentProviderManifest.make({
    descriptor: AgentProviderDescriptor.make({
      id: FIXTURE_AGENT_PROVIDER_ID,
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
    execute: () => Effect.succeed(WalkthroughResult.make({ text: "Fixture walkthrough" })),
  },
  reviewThread: {
    probe: Effect.succeed(
      AgentCapabilityReady.make({ capability: "review-thread", runtimeVersion: "1.0.0" }),
    ),
    execute: () =>
      Effect.succeed(
        ReviewThreadResult.make({
          response: ReviewThreadResponse.make({
            bodyMarkdown: "Fixture review response",
            threadSummary: null,
            referencedLocations: [],
          }),
          usage: null,
          artifacts: [],
          sessionId: null,
        }),
      ),
  },
})
