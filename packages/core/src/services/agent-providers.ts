import { Context, Effect, Layer, Match } from "effect"

import type {
  AgentCapability,
  AgentCapabilityProbe,
  AgentProviderProbeError,
  AgentProviderRegistration,
} from "@diffdash/agent-provider"
import {
  type AgentAutoRoutingPolicies,
  AgentProviderRegistry,
} from "@diffdash/agent-provider/registry"
import { boundedProviderDiagnostic, boundedProviderReason } from "@diffdash/agent-provider/runtime"
import {
  AgentProviderAutoCandidates,
  AgentProviderCapabilityStatus,
  AgentProviderCatalog,
  AgentProviderStatus,
} from "@diffdash/protocol/agent-providers"

/** Renderer-safe catalog assembled from registered provider manifests and probes. */
export class AgentProviders extends Context.Service<
  AgentProviders,
  { readonly catalog: Effect.Effect<AgentProviderCatalog> }
>()("@diffdash/AgentProviders") {
  static readonly layer = Layer.effect(
    AgentProviders,
    Effect.gen(function* () {
      const registry = yield* AgentProviderRegistry
      return AgentProviders.of({
        catalog: registry.list.pipe(
          Effect.flatMap((registrations) => makeCatalog(registrations, registry.autoCandidates)),
        ),
      })
    }),
  )
}

const makeCatalog = (
  registrations: readonly AgentProviderRegistration[],
  policies: AgentAutoRoutingPolicies,
) => {
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
    {
      walkthrough: capabilityStatus("walkthrough", registration.walkthrough?.probe),
      "review-thread": capabilityStatus("review-thread", registration.reviewThread?.probe),
    },
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map((capabilities) => {
      const manifest = registration.manifest
      return AgentProviderStatus.make({
        ...manifest.descriptor,
        capabilities,
        models: manifest.models,
        defaults: manifest.defaults,
        setup: manifest.requirements,
      })
    }),
  )

const capabilityStatus = (
  capability: AgentCapability,
  probe: Effect.Effect<AgentCapabilityProbe, AgentProviderProbeError> | undefined,
) => {
  if (probe === undefined) {
    return Effect.succeed(
      AgentProviderCapabilityStatus.cases.Unsupported.make({
        reason: "This provider does not implement this capability.",
      }),
    )
  }
  return probe.pipe(
    Effect.map((result) =>
      Match.valueTags(result, {
        AgentCapabilityReady: ({ runtimeVersion }) =>
          AgentProviderCapabilityStatus.cases.Ready.make({
            runtimeVersion,
          }),
        AgentCapabilityPolicyUnsupported: ({ reason }) =>
          AgentProviderCapabilityStatus.cases.PolicyUnsupported.make({
            reason: boundedProviderDiagnostic(reason),
          }),
        AgentCapabilityUnavailable: ({ reason }) =>
          AgentProviderCapabilityStatus.cases.Unavailable.make({
            reason: boundedProviderDiagnostic(reason),
          }),
      }),
    ),
    Effect.catch((error) =>
      Effect.succeed(
        AgentProviderCapabilityStatus.cases.Unavailable.make({
          reason: boundedProviderReason(error, "The provider probe failed."),
        }),
      ),
    ),
  )
}
