import { Context, Effect, Layer, Match, Option, Schema } from "effect"

import {
  AgentCapabilityUnavailableError,
  AgentPolicyEnforcementError,
  AgentProviderId,
  type AgentProviderRegistration,
  type AgentProviderResolutionError,
  DuplicateAgentProviderError,
  InvalidAgentProviderRegistrationError,
  MissingAgentProviderError,
  UnsupportedAgentCapabilityError,
  type ReviewThreadCapability,
  type WalkthroughCapability,
} from "./agent-provider"

/** Explicit route for one capability. Auto is never treated as a provider ID. */
export const AgentProviderRoute = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("auto") }),
  Schema.Struct({ mode: Schema.Literal("provider"), providerId: AgentProviderId }),
])

/** Explicit route for one capability. Auto is never treated as a provider ID. */
export type AgentProviderRoute = typeof AgentProviderRoute.Type

/** Independently ordered automatic candidates for walkthrough and review-thread routing. */
export interface AgentAutoRoutingPolicies {
  readonly walkthrough: readonly AgentProviderId[]
  readonly reviewThread: readonly AgentProviderId[]
}

/** Derives independent automatic routes from manifest capability priorities. */
export const agentAutoRoutingPolicies = (
  registrations: readonly AgentProviderRegistration[],
): AgentAutoRoutingPolicies => ({
  walkthrough: orderedAutoCandidates(registrations, "walkthrough"),
  reviewThread: orderedAutoCandidates(registrations, "reviewThread"),
})

/** No automatic candidate can safely serve a capability. */
export class NoAgentProviderAvailableError extends Schema.TaggedError<NoAgentProviderAvailableError>()(
  "NoAgentProviderAvailableError",
  { capability: Schema.Literals(["walkthrough", "review-thread"]) },
) {}

/** A registered walkthrough candidate with readiness checked lazily before execution. */
export interface ResolvedWalkthroughCandidate {
  readonly registration: AgentProviderRegistration
  readonly capability: WalkthroughCapability
  readonly ready: Effect.Effect<void, AgentProviderResolutionError>
}

/** A registered review-thread candidate with readiness checked lazily before execution. */
export interface ResolvedReviewThreadCandidate {
  readonly registration: AgentProviderRegistration
  readonly capability: ReviewThreadCapability
  readonly ready: Effect.Effect<void, AgentProviderResolutionError>
}

/** Provider registration registry with fail-closed capability resolution. */
export class AgentProviderRegistry extends Context.Service<
  AgentProviderRegistry,
  {
    readonly list: Effect.Effect<readonly AgentProviderRegistration[]>
    readonly autoCandidates: AgentAutoRoutingPolicies
    readonly resolveWalkthroughCandidates: (
      route: AgentProviderRoute,
    ) => Effect.Effect<
      readonly ResolvedWalkthroughCandidate[],
      AgentProviderResolutionError | NoAgentProviderAvailableError
    >
    readonly resolveReviewThreadCandidates: (
      route: AgentProviderRoute,
    ) => Effect.Effect<
      readonly ResolvedReviewThreadCandidate[],
      AgentProviderResolutionError | NoAgentProviderAvailableError
    >
  }
>()("@diffdash/AgentProviderRegistry") {
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
          yield* validateRegistration(registration)
          providers.set(providerId, registration)
        }

        const get = (providerId: AgentProviderId) =>
          Effect.fromOption(Option.fromNullishOr(providers.get(providerId)), () =>
            MissingAgentProviderError.make({ providerId }),
          )

        const walkthrough = candidateResolver(
          "walkthrough",
          get,
          policies.walkthrough,
          (registration) => registration.walkthrough,
        )
        const reviewThread = candidateResolver(
          "review-thread",
          get,
          policies.reviewThread,
          (registration) => registration.reviewThread,
        )

        return AgentProviderRegistry.of({
          list: Effect.succeed([...providers.values()]),
          autoCandidates: policies,
          resolveWalkthroughCandidates: walkthrough,
          resolveReviewThreadCandidates: reviewThread,
        })
      }),
    )
}

const orderedAutoCandidates = (
  registrations: readonly AgentProviderRegistration[],
  capability: "walkthrough" | "reviewThread",
): readonly AgentProviderId[] =>
  [...registrations]
    .flatMap((registration) => {
      const declaration = registration.manifest.capabilities[capability]
      return declaration.supported && declaration.autoPriority !== null
        ? [{ id: registration.manifest.descriptor.id, priority: declaration.autoPriority }]
        : []
    })
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 is required by Electron's build target.
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
    .map(({ id }) => id)

const candidateResolver = <Capability extends WalkthroughCapability | ReviewThreadCapability>(
  capabilityName: "walkthrough" | "review-thread",
  get: (
    providerId: AgentProviderId,
  ) => Effect.Effect<AgentProviderRegistration, MissingAgentProviderError>,
  autoCandidates: readonly AgentProviderId[],
  select: (registration: AgentProviderRegistration) => Capability | undefined,
) => {
  const resolveExplicit = (
    providerId: AgentProviderId,
  ): Effect.Effect<
    {
      readonly registration: AgentProviderRegistration
      readonly capability: Capability
      readonly ready: Effect.Effect<void, AgentProviderResolutionError>
    },
    AgentProviderResolutionError
  > =>
    Effect.gen(function* () {
      const registration = yield* get(providerId)
      const capability = select(registration)
      if (capability === undefined) {
        return yield* UnsupportedAgentCapabilityError.make({
          providerId,
          capability: capabilityName,
        })
      }
      const ready = probeCapability(providerId, capabilityName, capability)
      yield* ready
      return { registration, capability, ready: Effect.void }
    })

  const resolveAutoCandidate = (
    providerId: AgentProviderId,
  ): Effect.Effect<
    {
      readonly registration: AgentProviderRegistration
      readonly capability: Capability
      readonly ready: Effect.Effect<void, AgentProviderResolutionError>
    },
    MissingAgentProviderError | UnsupportedAgentCapabilityError
  > =>
    Effect.gen(function* () {
      const registration = yield* get(providerId)
      const capability = select(registration)
      if (capability === undefined) {
        return yield* UnsupportedAgentCapabilityError.make({
          providerId,
          capability: capabilityName,
        })
      }
      return {
        registration,
        capability,
        ready: probeCapability(providerId, capabilityName, capability),
      }
    })

  const resolveAuto = Effect.fn("AgentProviderRegistry.resolveAutoCandidates")(function* () {
    const candidates = yield* Effect.forEach(
      autoCandidates,
      (providerId) => resolveAutoCandidate(providerId).pipe(Effect.option),
      { concurrency: 1 },
    )
    const available = candidates.flatMap((candidate) =>
      Option.isSome(candidate) ? [candidate.value] : [],
    )
    return available.length === 0
      ? yield* NoAgentProviderAvailableError.make({ capability: capabilityName })
      : available
  })

  return (
    route: AgentProviderRoute,
  ): Effect.Effect<
    readonly {
      readonly registration: AgentProviderRegistration
      readonly capability: Capability
      readonly ready: Effect.Effect<void, AgentProviderResolutionError>
    }[],
    AgentProviderResolutionError | NoAgentProviderAvailableError
  > =>
    route.mode === "provider"
      ? resolveExplicit(route.providerId).pipe(Effect.map((candidate) => [candidate]))
      : resolveAuto()
}

const probeCapability = (
  providerId: AgentProviderId,
  capabilityName: "walkthrough" | "review-thread",
  capability: WalkthroughCapability | ReviewThreadCapability,
): Effect.Effect<void, AgentProviderResolutionError> =>
  Effect.gen(function* () {
    const probe = yield* capability.probe
    if (probe.capability !== capabilityName) {
      return yield* InvalidAgentProviderRegistrationError.make({
        providerId,
        capability: capabilityName,
        reason: `Capability probe returned ${probe.capability}.`,
      })
    }
    return yield* Match.valueTags(probe, {
      AgentCapabilityReady: () => Effect.void,
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

const validateRegistration = (registration: AgentProviderRegistration) => {
  const providerId = registration.manifest.descriptor.id
  return Effect.forEach(
    [
      ["walkthrough", registration.walkthrough] as const,
      ["reviewThread", registration.reviewThread] as const,
    ],
    ([manifestCapability, implementation]) => {
      const declaration = registration.manifest.capabilities[manifestCapability]
      const capability = manifestCapability === "walkthrough" ? "walkthrough" : "review-thread"
      if (declaration.supported !== (implementation !== undefined)) {
        return InvalidAgentProviderRegistrationError.make({
          providerId,
          capability,
          reason: declaration.supported
            ? "Manifest declares support but no implementation is registered."
            : "An implementation is registered but the manifest declares it unsupported.",
        })
      }
      if (!declaration.supported && declaration.autoPriority !== null) {
        return InvalidAgentProviderRegistrationError.make({
          providerId,
          capability,
          reason: "Unsupported capabilities cannot declare an automatic-routing priority.",
        })
      }
      return Effect.void
    },
    { discard: true },
  )
}
