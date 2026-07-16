import { Context, Effect, Layer, Match, Schema } from "effect"

import {
  AgentCapabilityUnavailableError,
  AgentPolicyEnforcementError,
  AgentProviderId,
  type AgentProviderRegistration,
  type AgentProviderResolutionError,
  DuplicateAgentProviderError,
  MissingAgentProviderError,
  UnsupportedAgentCapabilityError,
  type ReviewThreadCapability,
  type WalkthroughCapability,
} from "./agent-provider"

/** Explicit route for one capability. Auto is never treated as a provider ID. */
export const AgentProviderRoute = Schema.Union(
  Schema.Struct({ mode: Schema.Literal("auto") }),
  Schema.Struct({ mode: Schema.Literal("provider"), providerId: AgentProviderId }),
)

/** Explicit route for one capability. Auto is never treated as a provider ID. */
export type AgentProviderRoute = typeof AgentProviderRoute.Type

/** Independently ordered automatic candidates for walkthrough and review-thread routing. */
export interface AgentAutoRoutingPolicies {
  readonly walkthrough: readonly AgentProviderId[]
  readonly reviewThread: readonly AgentProviderId[]
}

/** No automatic candidate can safely serve a capability. */
export class NoAgentProviderAvailableError extends Schema.TaggedError<NoAgentProviderAvailableError>()(
  "NoAgentProviderAvailableError",
  { capability: Schema.Literal("walkthrough", "review-thread") },
) {}

/** Provider registration registry with fail-closed capability resolution. */
export class AgentProviderRegistry extends Context.Tag("@diffdash/AgentProviderRegistry")<
  AgentProviderRegistry,
  {
    readonly list: Effect.Effect<readonly AgentProviderRegistration[]>
    readonly get: (
      providerId: AgentProviderId,
    ) => Effect.Effect<AgentProviderRegistration, MissingAgentProviderError>
    readonly resolveWalkthrough: (
      route: AgentProviderRoute,
    ) => Effect.Effect<
      WalkthroughCapability,
      AgentProviderResolutionError | NoAgentProviderAvailableError
    >
    readonly resolveReviewThread: (
      route: AgentProviderRoute,
    ) => Effect.Effect<
      ReviewThreadCapability,
      AgentProviderResolutionError | NoAgentProviderAvailableError
    >
  }
>() {
  /** Builds a registry and rejects duplicate IDs before exposing any provider. */
  static readonly layer = (
    registrations: readonly AgentProviderRegistration[],
    policies: AgentAutoRoutingPolicies,
  ) =>
    Layer.effect(
      AgentProviderRegistry,
      Effect.gen(function* () {
        const providers = new Map<AgentProviderId, AgentProviderRegistration>()
        for (const registration of registrations) {
          const providerId = registration.manifest.descriptor.id
          if (providers.has(providerId)) {
            return yield* DuplicateAgentProviderError.make({ providerId })
          }
          providers.set(providerId, registration)
        }

        const get = (providerId: AgentProviderId) =>
          Effect.fromNullable(providers.get(providerId)).pipe(
            Effect.orElseFail(() => MissingAgentProviderError.make({ providerId })),
          )

        const walkthrough = capabilityResolver(
          "walkthrough",
          get,
          policies.walkthrough,
          (registration) => registration.walkthrough,
        )
        const reviewThread = capabilityResolver(
          "review-thread",
          get,
          policies.reviewThread,
          (registration) => registration.reviewThread,
        )

        return AgentProviderRegistry.of({
          list: Effect.succeed([...providers.values()]),
          get,
          resolveWalkthrough: walkthrough,
          resolveReviewThread: reviewThread,
        })
      }),
    )
}

const capabilityResolver = <Capability extends WalkthroughCapability | ReviewThreadCapability>(
  capabilityName: "walkthrough" | "review-thread",
  get: (
    providerId: AgentProviderId,
  ) => Effect.Effect<AgentProviderRegistration, MissingAgentProviderError>,
  autoCandidates: readonly AgentProviderId[],
  select: (registration: AgentProviderRegistration) => Capability | undefined,
) => {
  const resolveExplicit = (
    providerId: AgentProviderId,
  ): Effect.Effect<Capability, AgentProviderResolutionError> =>
    Effect.gen(function* () {
      const registration = yield* get(providerId)
      const capability = select(registration)
      if (capability === undefined) {
        return yield* UnsupportedAgentCapabilityError.make({
          providerId,
          capability: capabilityName,
        })
      }
      const probe = yield* capability.probe
      return yield* Match.valueTags(probe, {
        AgentCapabilityReady: () => Effect.succeed(capability),
        AgentCapabilityPolicyUnsupported: ({ reason }) =>
          AgentPolicyEnforcementError.make({
            providerId,
            capability: capabilityName,
            reason,
          }),
        AgentCapabilityUnavailable: ({ reason }) =>
          AgentCapabilityUnavailableError.make({
            providerId,
            capability: capabilityName,
            reason,
          }),
      })
    })

  const resolveAuto = (
    remaining: readonly AgentProviderId[],
  ): Effect.Effect<Capability, NoAgentProviderAvailableError> => {
    const [providerId, ...rest] = remaining
    if (providerId === undefined) {
      return Effect.fail(NoAgentProviderAvailableError.make({ capability: capabilityName }))
    }
    return resolveExplicit(providerId).pipe(Effect.catchAll(() => resolveAuto(rest)))
  }

  return (
    route: AgentProviderRoute,
  ): Effect.Effect<Capability, AgentProviderResolutionError | NoAgentProviderAvailableError> =>
    route.mode === "provider" ? resolveExplicit(route.providerId) : resolveAuto(autoCandidates)
}
