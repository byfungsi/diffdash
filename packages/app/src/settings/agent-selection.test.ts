import { AISettings, DEFAULT_AI_SETTINGS } from "@diffdash/domain/ai-settings"
import {
  AgentProviderAutoCandidates,
  AgentProviderCapabilityStatus,
  AgentProviderCatalog,
  AgentProviderDefaults,
  AgentProviderId,
  AgentModelId,
  AgentProviderModel,
  AgentProviderStatus,
} from "@diffdash/protocol/agent-providers"
import { describe, expect, it } from "@effect/vitest"
import {
  agentProviderOptions,
  agentRouteAvailable,
  aiSettingsWithModel,
  aiSettingsWithProvider,
  modelOptionsForProvider,
  selectedModelForProvider,
} from "./agent-selection"

const provider = AgentProviderStatus.make({
  id: AgentProviderId.make("runtime-provider"),
  displayName: "Runtime Provider",
  description: "Catalog-owned provider",
  homepage: null,
  capabilities: [
    AgentProviderCapabilityStatus.make({
      capability: "walkthrough",
      status: "ready",
      runtimeVersion: "1.0.0",
      reason: null,
    }),
    AgentProviderCapabilityStatus.make({
      capability: "review-thread",
      status: "ready",
      runtimeVersion: "1.0.0",
      reason: null,
    }),
  ],
  models: [
    AgentProviderModel.make({
      id: AgentModelId.make("walkthrough-default"),
      displayName: "Walkthrough Default",
      capabilities: ["walkthrough"],
      quality: "balanced",
    }),
    AgentProviderModel.make({
      id: AgentModelId.make("shared-model"),
      displayName: "Shared Model",
      capabilities: ["walkthrough", "review-thread"],
      quality: "best",
    }),
    AgentProviderModel.make({
      id: AgentModelId.make("review-default"),
      displayName: "Review Default",
      capabilities: ["review-thread"],
      quality: "fast",
    }),
  ],
  defaults: AgentProviderDefaults.make({
    walkthroughModel: AgentModelId.make("walkthrough-default"),
    reviewThreadModel: AgentModelId.make("review-default"),
  }),
  setup: [],
})

const catalog = AgentProviderCatalog.make({
  providers: [provider],
  autoCandidates: AgentProviderAutoCandidates.make({
    walkthrough: [provider.id],
    reviewThread: [provider.id],
  }),
})

describe("agent selection", () => {
  it("derives an unconfigured explicit model from the runtime catalog default", () => {
    const settings = AISettings.make({
      ...DEFAULT_AI_SETTINGS,
      routes: { walkthrough: provider.id, reviewThread: "auto" },
    })

    expect(selectedModelForProvider(settings, provider.id, catalog, "walkthrough")).toBe(
      "walkthrough-default",
    )
    expect(modelOptionsForProvider(settings, provider.id, catalog, "walkthrough")).toEqual([
      { model: "walkthrough-default", label: "Walkthrough Default" },
      { model: "shared-model", label: "Shared Model" },
    ])
  })

  it("selects a catalog-compatible shared model when both routes use one provider", () => {
    const settings = AISettings.make({
      ...DEFAULT_AI_SETTINGS,
      routes: { walkthrough: "auto", reviewThread: provider.id },
      models: { future: "future-model" },
    })

    const updated = aiSettingsWithProvider(settings, "walkthrough", provider.id, catalog)

    expect(updated.routes).toEqual({ walkthrough: provider.id, reviewThread: provider.id })
    expect(updated.models).toEqual({ future: "future-model", [provider.id]: "shared-model" })
    expect(modelOptionsForProvider(updated, provider.id, catalog, "walkthrough")).toEqual([
      { model: "shared-model", label: "Shared Model" },
    ])
  })

  it("retains an unknown persisted provider as a disabled catalog option", () => {
    const settings = AISettings.make({
      ...DEFAULT_AI_SETTINGS,
      routes: { walkthrough: "future-provider", reviewThread: "auto" },
      models: { "future-provider": "future-model" },
    })

    expect(
      agentProviderOptions(catalog, settings, "future-provider", "walkthrough"),
    ).toContainEqual({
      provider: "future-provider",
      label: "future-provider",
      reason: "This saved provider is not currently registered.",
      disabled: true,
    })
  })

  it("uses catalog automatic candidates rather than renderer provider priority", () => {
    expect(agentRouteAvailable(catalog, "auto", "walkthrough")).toBe(true)
    expect(
      agentRouteAvailable(
        AgentProviderCatalog.make({
          ...catalog,
          autoCandidates: AgentProviderAutoCandidates.make({
            walkthrough: [],
            reviewThread: [provider.id],
          }),
        }),
        "auto",
        "walkthrough",
      ),
    ).toBe(false)
  })

  it("updates only valid automatic quality tiers and explicit provider models", () => {
    const automatic = aiSettingsWithModel(DEFAULT_AI_SETTINGS, "walkthrough", "best")
    expect(automatic.autoQuality).toBe("best")
    expect(aiSettingsWithModel(automatic, "walkthrough", "provider-model")).toBe(automatic)

    const explicit = AISettings.make({
      ...DEFAULT_AI_SETTINGS,
      routes: { walkthrough: provider.id, reviewThread: "auto" },
    })
    expect(aiSettingsWithModel(explicit, "walkthrough", "shared-model").models).toEqual({
      [provider.id]: "shared-model",
    })
  })
})
