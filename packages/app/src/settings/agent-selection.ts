import { type AICapabilityRoute, AISettings, type AutoQuality } from "@diffdash/domain/ai-settings"
import type { AgentProviderCatalog } from "@diffdash/protocol/agent-providers"

/** Agent capabilities independently configurable in renderer settings. */
type ConfigurableAgentCapability = "walkthrough" | "review-thread"

/** Renderer metadata for a provider route option. */
interface AgentProviderOption {
  readonly provider: AICapabilityRoute
  readonly label: string
  readonly reason: string | null
  readonly disabled: boolean
}

/** Renderer metadata for a provider-owned model or automatic quality tier. */
interface AgentModelOption {
  readonly model: string
  readonly label: string
}

const AUTO_MODEL_OPTIONS: readonly AgentModelOption[] = [
  { model: "best", label: "Best" },
  { model: "balanced", label: "Balance" },
  { model: "fast", label: "Fast" },
]

/** Selects a provider route and derives any missing model from its runtime catalog entry. */
export const aiSettingsWithProvider = (
  settings: AISettings,
  capability: ConfigurableAgentCapability,
  provider: AICapabilityRoute,
  catalog: AgentProviderCatalog,
) => {
  const status = providerStatus(catalog, provider)
  const defaults = status?.defaults
  const defaultModel =
    capability === "walkthrough" ? defaults?.walkthroughModel : defaults?.reviewThreadModel
  const configuredModel = settings.models[provider]
  const requiredCapabilities = requiredModelCapabilities(settings, provider, capability)
  const compatibleModels = compatibleProviderModels(catalog, provider, requiredCapabilities)
  const configuredModelSupportsCapability = compatibleModels.some(
    (model) => model.id === configuredModel,
  )
  const nextModel = compatibleModels.some((model) => model.id === defaultModel)
    ? defaultModel
    : compatibleModels[0]?.id

  if (provider !== "auto" && status !== undefined && nextModel == null) return settings
  return AISettings.make({
    ...settings,
    routes: { ...settings.routes, [capabilityRouteKey(capability)]: provider },
    models:
      provider === "auto" || configuredModelSupportsCapability || nextModel == null
        ? settings.models
        : { ...settings.models, [provider]: nextModel },
  })
}

/** Selects a model for an explicit route or a quality tier for automatic routing. */
export const aiSettingsWithModel = (
  settings: AISettings,
  capability: ConfigurableAgentCapability,
  model: string,
) => {
  const route = settings.routes[capabilityRouteKey(capability)]
  if (route === "auto" && isAutoQuality(model)) {
    return AISettings.make({ ...settings, autoQuality: model })
  }
  if (route !== "auto") {
    return AISettings.make({ ...settings, models: { ...settings.models, [route]: model } })
  }
  return settings
}

/** Resolves a provider label from the runtime catalog while retaining unknown saved routes. */
export const aiProviderLabel = (provider: AICapabilityRoute, catalog: AgentProviderCatalog) =>
  provider === "auto" ? "Auto" : (providerStatus(catalog, provider)?.displayName ?? provider)

/** Resolves the selected walkthrough model label from catalog-owned model metadata. */
export const selectedAIModelLabel = (settings: AISettings, catalog: AgentProviderCatalog) => {
  const route = settings.routes.walkthrough
  const selectedModel = selectedModelForProvider(settings, route, catalog, "walkthrough")
  return (
    modelOptionsForProvider(settings, route, catalog, "walkthrough").find(
      (option) => option.model === selectedModel,
    )?.label ?? selectedModel
  )
}

/** Builds provider options from the runtime catalog and a possibly unknown persisted route. */
export const agentProviderOptions = (
  catalog: AgentProviderCatalog,
  settings: AISettings,
  selectedRoute: AICapabilityRoute,
  capability: ConfigurableAgentCapability,
): readonly AgentProviderOption[] => {
  const options: AgentProviderOption[] = catalog.providers
    .filter((provider) =>
      provider.capabilities.some(
        (item) => item.capability === capability && item.status !== "unsupported",
      ),
    )
    .map((provider) => {
      const unavailableReason = agentUnavailableReason(provider.id, catalog, capability)
      const requiredCapabilities = requiredModelCapabilities(settings, provider.id, capability)
      const hasCompatibleModel =
        compatibleProviderModels(catalog, provider.id, requiredCapabilities).length > 0
      return {
        provider: provider.id,
        label: provider.displayName,
        reason:
          unavailableReason ??
          (hasCompatibleModel
            ? null
            : "No model supports both the walkthrough and review-comment capabilities."),
        disabled: unavailableReason !== null || !hasCompatibleModel,
      }
    })

  if (selectedRoute !== "auto" && !options.some(({ provider }) => provider === selectedRoute)) {
    options.push({
      provider: selectedRoute,
      label: selectedRoute,
      reason: "This saved provider is not currently registered.",
      disabled: true,
    })
  }

  return [
    {
      provider: "auto",
      label: "Auto",
      reason: agentUnavailableReason("auto", catalog, capability),
      disabled: !agentAvailable(catalog, capability),
    },
    ...options,
  ]
}

/** Returns model options compatible with this capability and the other saved route. */
export const modelOptionsForProvider = (
  settings: AISettings,
  provider: AICapabilityRoute,
  catalog: AgentProviderCatalog,
  capability: ConfigurableAgentCapability,
): readonly AgentModelOption[] =>
  provider === "auto"
    ? AUTO_MODEL_OPTIONS
    : compatibleProviderModels(
        catalog,
        provider,
        requiredModelCapabilities(settings, provider, capability),
      ).map(({ id, displayName }) => ({ model: id, label: displayName }))

/** Resolves the persisted model, then falls back to the provider manifest default. */
export const selectedModelForProvider = (
  settings: AISettings,
  provider: AICapabilityRoute,
  catalog: AgentProviderCatalog,
  capability: ConfigurableAgentCapability,
) =>
  provider === "auto"
    ? settings.autoQuality
    : (settings.models[provider] ??
      (capability === "walkthrough"
        ? providerStatus(catalog, provider)?.defaults.walkthroughModel
        : providerStatus(catalog, provider)?.defaults.reviewThreadModel) ??
      "")

/** Explains why a selected route cannot currently serve one capability. */
export const agentUnavailableReason = (
  route: AICapabilityRoute,
  catalog: AgentProviderCatalog,
  capability: ConfigurableAgentCapability,
) => {
  if (route === "auto") {
    return agentAvailable(catalog, capability)
      ? null
      : `No automatic ${capability === "walkthrough" ? "walkthrough" : "review comment"} provider is currently available.`
  }
  const provider = providerStatus(catalog, route)
  if (provider === undefined) return "This saved provider is not currently registered."
  const status = provider.capabilities.find((item) => item.capability === capability)
  return status?.status === "ready"
    ? null
    : (status?.reason ??
        `This provider is currently unavailable for ${capability === "walkthrough" ? "walkthroughs" : "review comments"}.`)
}

/** Returns whether any catalog-ordered automatic candidate is ready for a capability. */
const agentAvailable = (catalog: AgentProviderCatalog, capability: ConfigurableAgentCapability) => {
  const candidates =
    capability === "walkthrough"
      ? catalog.autoCandidates.walkthrough
      : catalog.autoCandidates.reviewThread
  return candidates.some((providerId) =>
    providerStatus(catalog, providerId)?.capabilities.some(
      (item) => item.capability === capability && item.status === "ready",
    ),
  )
}

/** Returns whether an automatic or explicit route is currently ready. */
export const agentRouteAvailable = (
  catalog: AgentProviderCatalog,
  route: AICapabilityRoute,
  capability: ConfigurableAgentCapability,
) =>
  route === "auto"
    ? agentAvailable(catalog, capability)
    : providerStatus(catalog, route)?.capabilities.some(
        (item) => item.capability === capability && item.status === "ready",
      ) === true

const isAutoQuality = (model: string): model is AutoQuality =>
  model === "best" || model === "balanced" || model === "fast"

const providerStatus = (catalog: AgentProviderCatalog, provider: AICapabilityRoute) =>
  catalog.providers.find(({ id }) => id === provider)

const capabilityRouteKey = (capability: ConfigurableAgentCapability) =>
  capability === "walkthrough" ? "walkthrough" : "reviewThread"

const requiredModelCapabilities = (
  settings: AISettings,
  provider: AICapabilityRoute,
  capability: ConfigurableAgentCapability,
): readonly ConfigurableAgentCapability[] => {
  const otherCapability = capability === "walkthrough" ? "review-thread" : "walkthrough"
  const otherRoute = settings.routes[capabilityRouteKey(otherCapability)]
  return otherRoute === provider ? [capability, otherCapability] : [capability]
}

const compatibleProviderModels = (
  catalog: AgentProviderCatalog,
  provider: AICapabilityRoute,
  capabilities: readonly ConfigurableAgentCapability[],
) =>
  (providerStatus(catalog, provider)?.models ?? []).filter((model) =>
    capabilities.every((capability) => model.capabilities.includes(capability)),
  )
