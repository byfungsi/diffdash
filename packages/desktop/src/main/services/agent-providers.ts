import { Context, Effect, Layer, Match } from "effect"

import type {
  AgentCapability,
  AgentCapabilityProbe,
  AgentProviderRegistration,
} from "@diffdash/agent-provider"
import { agentAutoRoutingPolicies, AgentProviderRegistry } from "@diffdash/agent-provider/registry"
import {
  AgentProviderAutoCandidates,
  AgentProviderCapabilityStatus,
  AgentProviderCatalog,
  AgentProviderDefaults,
  AgentProviderModel,
  AgentProviderSetupRequirement,
  AgentProviderStatus,
} from "@diffdash/protocol/agent-providers"

/** Renderer-safe catalog assembled from registered provider manifests and probes. */
export class AgentProviders extends Context.Tag("@diffdash/AgentProviders")<
  AgentProviders,
  { readonly catalog: Effect.Effect<AgentProviderCatalog> }
>() {
  static readonly layer = Layer.effect(
    AgentProviders,
    Effect.gen(function* () {
      const registry = yield* AgentProviderRegistry
      return AgentProviders.of({
        catalog: registry.list.pipe(Effect.flatMap(makeCatalog)),
      })
    }),
  )
}

const makeCatalog = (registrations: readonly AgentProviderRegistration[]) => {
  const policies = agentAutoRoutingPolicies(registrations)
  return Effect.all(registrations.map(providerStatus), { concurrency: "unbounded" }).pipe(
    Effect.map((providers) =>
      AgentProviderCatalog.make({
        providers,
        autoCandidates: AgentProviderAutoCandidates.make({
          walkthrough: policies.walkthrough,
          reviewThread: policies.reviewThread,
        }),
      }),
    ),
  )
}

const providerStatus = (registration: AgentProviderRegistration) =>
  Effect.all(
    [
      capabilityStatus("walkthrough", registration.walkthrough?.probe),
      capabilityStatus("review-thread", registration.reviewThread?.probe),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map((capabilities) => {
      const manifest = registration.manifest
      return AgentProviderStatus.make({
        ...manifest.descriptor,
        capabilities,
        models: manifest.models.map((model) => AgentProviderModel.make(model)),
        defaults: AgentProviderDefaults.make(manifest.defaults),
        setup: manifest.requirements.map((requirement) =>
          AgentProviderSetupRequirement.make(requirement),
        ),
      })
    }),
  )

const capabilityStatus = (
  capability: AgentCapability,
  probe: Effect.Effect<AgentCapabilityProbe, unknown> | undefined,
) => {
  if (probe === undefined) {
    return Effect.succeed(
      AgentProviderCapabilityStatus.make({
        capability,
        status: "unsupported",
        runtimeVersion: null,
        reason: "This provider does not implement this capability.",
      }),
    )
  }
  return probe.pipe(
    Effect.map((result) =>
      Match.valueTags(result, {
        AgentCapabilityReady: ({ runtimeVersion }) =>
          AgentProviderCapabilityStatus.make({
            capability,
            status: "ready",
            runtimeVersion,
            reason: null,
          }),
        AgentCapabilityPolicyUnsupported: ({ reason }) =>
          AgentProviderCapabilityStatus.make({
            capability,
            status: "policy-unsupported",
            runtimeVersion: null,
            reason,
          }),
        AgentCapabilityUnavailable: ({ reason }) =>
          AgentProviderCapabilityStatus.make({
            capability,
            status: "unavailable",
            runtimeVersion: null,
            reason,
          }),
      }),
    ),
    Effect.catchAll((error) =>
      Effect.succeed(
        AgentProviderCapabilityStatus.make({
          capability,
          status: "unavailable",
          runtimeVersion: null,
          reason: error instanceof Error ? error.message : "The provider probe failed.",
        }),
      ),
    ),
  )
}
