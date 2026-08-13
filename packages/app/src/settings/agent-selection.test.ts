import {
  AIAgentSelection,
  AIModelId,
  AIProviderId,
  AISettings,
  DEFAULT_AI_SETTINGS,
} from "@diffdash/domain/ai-settings"
import {
  AgentModelId,
  AgentProviderAutoCandidates,
  AgentProviderCapabilityStatus,
  AgentProviderCatalog,
  AgentProviderDefaults,
  AgentProviderId,
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
  capabilities: {
    walkthrough: AgentProviderCapabilityStatus.cases.Ready.make({ runtimeVersion: "1.0.0" }),
    "review-thread": AgentProviderCapabilityStatus.cases.Ready.make({ runtimeVersion: "1.0.0" }),
  },
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
const persistedProviderId = AIProviderId.make(provider.id)

describe("agent selection", () => {
  it("pins a capability to its provider default without coupling the other capability", () => {
    const updated = aiSettingsWithProvider(
      DEFAULT_AI_SETTINGS,
      "walkthrough",
      persistedProviderId,
      catalog,
    )

    expect(updated.selections.walkthrough).toEqual({
      _tag: "Pinned",
      providerId: "runtime-provider",
      modelId: "walkthrough-default",
    })
    expect(updated.selections["review-thread"]).toEqual(
      DEFAULT_AI_SETTINGS.selections["review-thread"],
    )
    expect(modelOptionsForProvider(updated.selections.walkthrough, catalog, "walkthrough")).toEqual(
      [
        {
          model: "walkthrough-default",
          label: "Walkthrough Default",
          reason: null,
          disabled: false,
        },
        { model: "shared-model", label: "Shared Model", reason: null, disabled: false },
      ],
    )
  })

  it("retains unknown provider and model IDs as disabled unavailable options", () => {
    const selection = AIAgentSelection.cases.Pinned.make({
      providerId: AIProviderId.make("future-provider"),
      modelId: AIModelId.make("future-model"),
    })

    expect(agentProviderOptions(catalog, selection, "walkthrough")).toContainEqual({
      provider: "future-provider",
      label: "future-provider",
      reason: "This saved provider is not currently registered.",
      disabled: true,
    })
    expect(modelOptionsForProvider(selection, catalog, "walkthrough")).toContainEqual({
      model: "future-model",
      label: "future-model",
      reason: "This saved model is unavailable or incompatible with this capability.",
      disabled: true,
    })
  })

  it("resolves a provider-default pinned selection from the runtime catalog", () => {
    const selection = AIAgentSelection.cases.Pinned.make({
      providerId: persistedProviderId,
      modelId: null,
    })

    expect(agentRouteAvailable(catalog, selection, "walkthrough")).toBe(true)
    expect(selectedModelForProvider(selection)).toBe("provider-default")
    expect(modelOptionsForProvider(selection, catalog, "walkthrough")[0]).toEqual({
      model: "provider-default",
      label: "Provider default",
      reason: null,
      disabled: false,
    })
    const settings = AISettings.make({
      ...DEFAULT_AI_SETTINGS,
      selections: { ...DEFAULT_AI_SETTINGS.selections, walkthrough: selection },
    })
    expect(
      aiSettingsWithModel(settings, "walkthrough", "shared-model").selections.walkthrough,
    ).toEqual({
      _tag: "Pinned",
      providerId: "runtime-provider",
      modelId: "shared-model",
    })
  })

  it("uses catalog automatic candidates and requires a compatible model", () => {
    const automatic = AIAgentSelection.cases.Automatic.make({ quality: "balanced" })
    expect(agentRouteAvailable(catalog, automatic, "walkthrough")).toBe(true)
    expect(
      agentRouteAvailable(
        AgentProviderCatalog.make({
          ...catalog,
          autoCandidates: AgentProviderAutoCandidates.make({
            walkthrough: [],
            reviewThread: [provider.id],
          }),
        }),
        automatic,
        "walkthrough",
      ),
    ).toBe(false)
  })

  it("updates automatic quality and pinned models independently per capability", () => {
    const automatic = aiSettingsWithModel(DEFAULT_AI_SETTINGS, "walkthrough", "best")
    expect(automatic.selections.walkthrough).toEqual({ _tag: "Automatic", quality: "best" })
    expect(aiSettingsWithModel(automatic, "walkthrough", "provider-model")).toBe(automatic)

    const pinned = AISettings.make({
      ...DEFAULT_AI_SETTINGS,
      selections: {
        ...DEFAULT_AI_SETTINGS.selections,
        walkthrough: AIAgentSelection.cases.Pinned.make({
          providerId: persistedProviderId,
          modelId: AIModelId.make("walkthrough-default"),
        }),
      },
    })
    const updated = aiSettingsWithModel(pinned, "walkthrough", "shared-model")
    expect(selectedModelForProvider(updated.selections.walkthrough)).toBe("shared-model")
    expect(updated.selections["review-thread"]).toEqual(pinned.selections["review-thread"])
  })
})
