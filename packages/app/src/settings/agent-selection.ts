import {
  AIAgentSelection,
  type AIAgentSelection as AIAgentSelectionValue,
  type AgentCapability,
  AIModelId,
  AIProviderId,
  AISettings,
  AgentModelQuality,
} from "@diffdash/domain/ai-settings"
import { Schema } from "effect"
import {
  AgentProviderCapabilityStatus,
  type AgentProviderCatalog,
} from "@diffdash/protocol/agent-providers"

/** Renderer metadata for a provider route option. */
interface AgentProviderOption {
  readonly provider: "auto" | AIProviderId
  readonly label: string
  readonly reason: string | null
  readonly disabled: boolean
}

/** Renderer metadata for a provider-owned model or automatic quality tier. */
interface AgentModelOption {
  readonly model: string
  readonly label: string
  readonly reason: string | null
  readonly disabled: boolean
}

const AUTO_MODEL_OPTIONS: readonly AgentModelOption[] = [
  { model: "best", label: "Best", reason: null, disabled: false },
  { model: "balanced", label: "Balance", reason: null, disabled: false },
  { model: "fast", label: "Fast", reason: null, disabled: false },
]
const PROVIDER_DEFAULT_MODEL = "provider-default"

/** Returns the complete persisted selection for one capability. */
export const agentSelection = (settings: AISettings, capability: AgentCapability) =>
  settings.selections[capability]

/** Returns the provider menu value for one complete capability selection. */
export const selectedProvider = (selection: AIAgentSelectionValue): "auto" | AIProviderId =>
  AIAgentSelection.guards.Automatic(selection) ? "auto" : selection.providerId

/** Selects a provider and derives a compatible capability-local default model. */
export const aiSettingsWithProvider = (
  settings: AISettings,
  capability: AgentCapability,
  provider: "auto" | AIProviderId,
  catalog: AgentProviderCatalog,
) => {
  const current = agentSelection(settings, capability)
  const next =
    provider === "auto"
      ? AIAgentSelection.cases.Automatic.make({
          quality: AIAgentSelection.guards.Automatic(current) ? current.quality : "balanced",
        })
      : pinnedSelectionForProvider(current, provider, catalog, capability)
  if (next === null) return settings
  return AISettings.make({
    ...settings,
    selections: { ...settings.selections, [capability]: next },
  })
}

/** Selects a model for a pinned route or a quality tier for automatic routing. */
export const aiSettingsWithModel = (
  settings: AISettings,
  capability: AgentCapability,
  model: string,
) => {
  const current = agentSelection(settings, capability)
  if (AIAgentSelection.guards.Automatic(current)) {
    if (!isAgentModelQuality(model)) return settings
    return AISettings.make({
      ...settings,
      selections: {
        ...settings.selections,
        [capability]: AIAgentSelection.cases.Automatic.make({ quality: model }),
      },
    })
  }
  if (model === PROVIDER_DEFAULT_MODEL) {
    return AISettings.make({
      ...settings,
      selections: {
        ...settings.selections,
        [capability]: AIAgentSelection.cases.Pinned.make({
          providerId: current.providerId,
          modelId: null,
        }),
      },
    })
  }
  return AISettings.make({
    ...settings,
    selections: {
      ...settings.selections,
      [capability]: AIAgentSelection.cases.Pinned.make({
        providerId: current.providerId,
        modelId: AIModelId.make(model),
      }),
    },
  })
}

/** Resolves a provider label from the runtime catalog while retaining unknown saved providers. */
export const aiProviderLabel = (
  selection: AIAgentSelectionValue,
  catalog: AgentProviderCatalog,
) => {
  const provider = selectedProvider(selection)
  return provider === "auto" ? "Auto" : (providerStatus(catalog, provider)?.displayName ?? provider)
}

/** Resolves the selected model or quality label from catalog-owned metadata. */
export const selectedAIModelLabel = (
  settings: AISettings,
  catalog: AgentProviderCatalog,
  capability: AgentCapability = "walkthrough",
) => {
  const selection = agentSelection(settings, capability)
  const selectedModel = selectedModelForProvider(selection)
  return (
    modelOptionsForProvider(selection, catalog, capability).find(
      (option) => option.model === selectedModel,
    )?.label ?? selectedModel
  )
}

/** Builds provider options from the runtime catalog and a possibly unavailable saved provider. */
export const agentProviderOptions = (
  catalog: AgentProviderCatalog,
  selection: AIAgentSelectionValue,
  capability: AgentCapability,
): readonly AgentProviderOption[] => {
  const selected = selectedProvider(selection)
  const options: AgentProviderOption[] = catalog.providers
    .filter(
      (provider) =>
        !AgentProviderCapabilityStatus.guards.Unsupported(provider.capabilities[capability]),
    )
    .map((provider) => {
      const providerId = AIProviderId.make(provider.id)
      const reason = providerUnavailableReason(providerId, catalog, capability)
      const hasCompatibleModel =
        compatibleProviderModels(catalog, providerId, capability).length > 0
      return {
        provider: providerId,
        label: provider.displayName,
        reason:
          reason ?? (hasCompatibleModel ? null : capabilityModelUnavailableReason(capability)),
        disabled: reason !== null || !hasCompatibleModel,
      }
    })

  if (selected !== "auto" && !options.some(({ provider }) => provider === selected)) {
    options.push({
      provider: selected,
      label: selected,
      reason: "This saved provider is not currently registered.",
      disabled: true,
    })
  }

  return [
    {
      provider: "auto",
      label: "Auto",
      reason: automaticUnavailableReason(catalog, capability),
      disabled: !agentAvailable(catalog, capability),
    },
    ...options,
  ]
}

/** Returns model options for only the selected capability, retaining an unavailable saved model. */
export const modelOptionsForProvider = (
  selection: AIAgentSelectionValue,
  catalog: AgentProviderCatalog,
  capability: AgentCapability,
): readonly AgentModelOption[] => {
  if (AIAgentSelection.guards.Automatic(selection)) return AUTO_MODEL_OPTIONS
  const models = compatibleProviderModels(catalog, selection.providerId, capability).map(
    ({ id, displayName }) => ({ model: id, label: displayName, reason: null, disabled: false }),
  )
  if (selection.modelId === null) {
    return [
      {
        model: PROVIDER_DEFAULT_MODEL,
        label: "Provider default",
        reason: null,
        disabled: false,
      },
      ...models,
    ]
  }
  if (!models.some(({ model }) => String(model) === String(selection.modelId))) {
    return [
      ...models,
      {
        model: selection.modelId,
        label: selection.modelId,
        reason: "This saved model is unavailable or incompatible with this capability.",
        disabled: true,
      },
    ]
  }
  return models
}

/** Returns the model ID or automatic quality encoded by a complete selection. */
export const selectedModelForProvider = (selection: AIAgentSelectionValue) =>
  AIAgentSelection.guards.Automatic(selection)
    ? selection.quality
    : (selection.modelId ?? PROVIDER_DEFAULT_MODEL)

/** Explains why a complete selection cannot currently serve one capability. */
export const agentUnavailableReason = (
  selection: AIAgentSelectionValue,
  catalog: AgentProviderCatalog,
  capability: AgentCapability,
) => {
  if (AIAgentSelection.guards.Automatic(selection)) {
    return automaticUnavailableReason(catalog, capability)
  }
  const reason = providerUnavailableReason(selection.providerId, catalog, capability)
  if (reason !== null) return reason
  if (selection.modelId === null) {
    const provider = providerStatus(catalog, selection.providerId)
    const defaultModel =
      capability === "walkthrough"
        ? provider?.defaults.walkthroughModel
        : provider?.defaults.reviewThreadModel
    return compatibleProviderModels(catalog, selection.providerId, capability).some(
      ({ id }) => id === defaultModel,
    )
      ? null
      : "This provider has no compatible default model for this capability."
  }
  return compatibleProviderModels(catalog, selection.providerId, capability).some(
    ({ id }) => String(id) === String(selection.modelId),
  )
    ? null
    : "This saved model is unavailable or incompatible with this capability."
}

/** Returns whether an automatic or pinned selection is currently executable. */
export const agentRouteAvailable = (
  catalog: AgentProviderCatalog,
  selection: AIAgentSelectionValue,
  capability: AgentCapability,
) => agentUnavailableReason(selection, catalog, capability) === null

const pinnedSelectionForProvider = (
  current: AIAgentSelectionValue,
  providerId: AIProviderId,
  catalog: AgentProviderCatalog,
  capability: AgentCapability,
) => {
  const provider = providerStatus(catalog, providerId)
  if (provider === undefined) return null
  const compatible = compatibleProviderModels(catalog, providerId, capability)
  const currentModel =
    AIAgentSelection.guards.Pinned(current) && current.providerId === providerId
      ? current.modelId
      : null
  const defaultModel =
    capability === "walkthrough"
      ? provider.defaults.walkthroughModel
      : provider.defaults.reviewThreadModel
  const modelId =
    compatible.find(({ id }) => String(id) === String(currentModel))?.id ??
    compatible.find(({ id }) => String(id) === String(defaultModel))?.id ??
    compatible[0]?.id
  return modelId === undefined
    ? null
    : AIAgentSelection.cases.Pinned.make({
        providerId,
        modelId: AIModelId.make(modelId),
      })
}

const automaticUnavailableReason = (catalog: AgentProviderCatalog, capability: AgentCapability) =>
  agentAvailable(catalog, capability)
    ? null
    : `No automatic ${capability === "walkthrough" ? "walkthrough" : "review comment"} provider is currently available.`

const providerUnavailableReason = (
  providerId: AIProviderId,
  catalog: AgentProviderCatalog,
  capability: AgentCapability,
) => {
  const provider = providerStatus(catalog, providerId)
  if (provider === undefined) return "This saved provider is not currently registered."
  const status = provider.capabilities[capability]
  return AgentProviderCapabilityStatus.guards.Ready(status) ? null : status.reason
}

const agentAvailable = (catalog: AgentProviderCatalog, capability: AgentCapability) => {
  const candidates =
    capability === "walkthrough"
      ? catalog.autoCandidates.walkthrough
      : catalog.autoCandidates.reviewThread
  return candidates.some((providerId) => {
    const persistedId = AIProviderId.make(providerId)
    return (
      providerUnavailableReason(persistedId, catalog, capability) === null &&
      compatibleProviderModels(catalog, persistedId, capability).length > 0
    )
  })
}

const isAgentModelQuality = (model: string): model is AgentModelQuality =>
  Schema.is(AgentModelQuality)(model)

const providerStatus = (catalog: AgentProviderCatalog, provider: AIProviderId) =>
  catalog.providers.find(({ id }) => String(id) === String(provider))

const compatibleProviderModels = (
  catalog: AgentProviderCatalog,
  provider: AIProviderId,
  capability: AgentCapability,
) =>
  (providerStatus(catalog, provider)?.models ?? []).filter((model) =>
    model.capabilities.includes(capability),
  )

const capabilityModelUnavailableReason = (capability: AgentCapability) =>
  `No model supports the ${capability === "walkthrough" ? "walkthrough" : "review comment"} capability.`
