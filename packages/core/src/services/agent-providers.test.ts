import {
  AgentCapabilityDeclaration,
  AgentCapabilityManifest,
  AgentCapabilityPolicyUnsupported,
  type AgentCapabilityProbe,
  AgentCapabilityUnavailable,
  AgentProviderDefaults,
  AgentProviderDescriptor,
  AgentProviderId,
  AgentProviderManifest,
  AgentProviderProbeError,
  type AgentProviderRegistration,
  AgentSessionSupport,
} from "@diffdash/agent-provider"
import { AgentProviderRegistry } from "@diffdash/agent-provider/registry"
import { AgentProviderCapabilityStatus } from "@diffdash/protocol/agent-providers"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { AgentProviders } from "./agent-providers"

const registration = (
  id: string,
  walkthroughProbe: Effect.Effect<AgentCapabilityProbe, AgentProviderProbeError>,
  reviewProbe: Effect.Effect<AgentCapabilityProbe, AgentProviderProbeError>,
): AgentProviderRegistration => {
  const providerId = AgentProviderId.make(id)
  return {
    manifest: AgentProviderManifest.make({
      descriptor: AgentProviderDescriptor.make({
        id: providerId,
        displayName: id,
        description: "Diagnostic test provider",
        homepage: null,
      }),
      models: [],
      defaults: AgentProviderDefaults.make({ walkthroughModel: null, reviewThreadModel: null }),
      requirements: [],
      capabilities: AgentCapabilityManifest.make({
        walkthrough: AgentCapabilityDeclaration.make({ supported: true, autoPriority: null }),
        reviewThread: AgentCapabilityDeclaration.make({ supported: true, autoPriority: null }),
      }),
      session: AgentSessionSupport.make({ mode: "none" }),
    }),
    walkthrough: {
      probe: walkthroughProbe,
      execute: () => Effect.die(new Error("Unused walkthrough capability")),
    },
    reviewThread: {
      probe: reviewProbe,
      execute: () => Effect.die(new Error("Unused review capability")),
    },
  }
}

describe("AgentProviders", () => {
  it.effect("bounds and redacts returned and unexpected capability probe failures", () => {
    const failingProviderId = AgentProviderId.make("failing")
    const registrations = [
      registration(
        failingProviderId,
        Effect.fail(
          AgentProviderProbeError.make({
            providerId: failingProviderId,
            capability: "walkthrough",
            reason: `${"x".repeat(700)}
Authorization: Bearer probe-bearer-secret refresh_token=probe-refresh-secret`,
          }),
        ),
        Effect.succeed(
          AgentCapabilityUnavailable.make({
            capability: "review-thread",
            reason: 'headers={"Authorization":"Basic unavailable-basic-secret"}',
          }),
        ),
      ),
      registration(
        "policy",
        Effect.succeed(
          AgentCapabilityUnavailable.make({
            capability: "walkthrough",
            reason: "GITHUB_TOKEN=unavailable-provider-secret",
          }),
        ),
        Effect.succeed(
          AgentCapabilityPolicyUnsupported.make({
            capability: "review-thread",
            reason: "access_token=policy-access-secret",
          }),
        ),
      ),
    ]
    const registry = AgentProviderRegistry.layer(registrations, {
      walkthrough: [],
      reviewThread: [],
    })
    const layer = AgentProviders.layer.pipe(Layer.provide(registry))

    return Effect.gen(function* () {
      const catalog = yield* (yield* AgentProviders).catalog
      const diagnostics = JSON.stringify(catalog)
      const failing = catalog.providers.find(({ id }) => id === failingProviderId)
      const policy = catalog.providers.find(({ id }) => id === "policy")

      expect(failing?.capabilities.walkthrough).toMatchObject({
        _tag: "Unavailable",
        reason: expect.stringContaining("Authorization: [redacted]"),
      })
      expect(failing?.capabilities.walkthrough).toMatchObject({
        reason: expect.stringContaining("refresh_token=[redacted]"),
      })
      if (AgentProviderCapabilityStatus.guards.Unavailable(failing?.capabilities.walkthrough)) {
        expect(failing.capabilities.walkthrough.reason).toHaveLength(600)
      }
      expect(failing?.capabilities["review-thread"]).toEqual({
        _tag: "Unavailable",
        reason: 'headers={"Authorization":"[redacted]"}',
      })
      expect(policy?.capabilities.walkthrough).toEqual({
        _tag: "Unavailable",
        reason: "GITHUB_TOKEN=[redacted]",
      })
      expect(policy?.capabilities["review-thread"]).toEqual({
        _tag: "PolicyUnsupported",
        reason: "access_token=[redacted]",
      })
      for (const secret of [
        "probe-bearer-secret",
        "probe-refresh-secret",
        "unavailable-basic-secret",
        "unavailable-provider-secret",
        "policy-access-secret",
      ]) {
        expect(diagnostics).not.toContain(secret)
      }
    }).pipe(Effect.provide(layer))
  })
})
