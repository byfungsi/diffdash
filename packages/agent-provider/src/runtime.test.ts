import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { AgentProviderId } from "./agent-provider"
import {
  boundedProviderReason,
  makeAgentProviderOperationErrorFactory,
  parseAgentRuntimeVersion,
  probeAgentRuntime,
  projectAgentCapabilityProbe,
} from "./runtime"

const redact = (value: string) => value.replaceAll("secret", "[redacted]")

describe("provider runtime helpers", () => {
  it("extracts semantic versions and bounds unstructured output", () => {
    expect(parseAgentRuntimeVersion("tool v1.2.3-beta.1")).toBe("1.2.3-beta.1")
    expect(parseAgentRuntimeVersion("  ")).toBeNull()
    expect(parseAgentRuntimeVersion("x".repeat(120))).toHaveLength(100)
  })

  it("prefers stderr, then error messages, then the fallback", () => {
    expect(boundedProviderReason({ stderr: "secret stderr" }, "fallback", redact)).toBe(
      "[redacted] stderr",
    )
    expect(boundedProviderReason({ reason: "secret reason" }, "fallback", redact)).toBe(
      "[redacted] reason",
    )
    expect(boundedProviderReason(new Error("secret message"), "fallback", redact)).toBe(
      "[redacted] message",
    )
    expect(boundedProviderReason(new Error("Failed to spawn command"), "fallback", redact)).toBe(
      "fallback",
    )
    expect(
      boundedProviderReason(
        { _tag: "ProcessSpawnError", message: "Failed to spawn command" },
        "fallback",
      ),
    ).toBe("fallback")
    expect(
      boundedProviderReason(
        new Error("ENOENT: no such file or directory, open '/tmp/x'"),
        "fallback",
      ),
    ).toBe("ENOENT: no such file or directory, open '/tmp/x'")
    expect(boundedProviderReason(null, "fallback", redact)).toBe("fallback")
  })

  it("always applies baseline redaction, whitespace normalization, and a default bound", () => {
    const reason = boundedProviderReason(
      { stderr: `Bearer secret\nAuthorization: token\n${"x".repeat(700)}` },
      "fallback",
    )

    expect(reason).toHaveLength(600)
    expect(reason).not.toContain("secret")
    expect(reason).not.toContain("Authorization")
    expect(reason).not.toContain("\n")
  })

  it.effect("probes a runtime once per execution and projects capability status", () =>
    Effect.gen(function* () {
      const ready = probeAgentRuntime({
        versionOutput: Effect.succeed("provider 2.3.4"),
        unavailableReason: "provider unavailable",
      })
      const readyCapability = yield* projectAgentCapabilityProbe(ready, "walkthrough")
      const unsupportedCapability = yield* projectAgentCapabilityProbe(
        ready,
        "review-thread",
        () => "missing permission control",
      )
      const unavailableCapability = yield* projectAgentCapabilityProbe(
        probeAgentRuntime({
          versionOutput: Effect.fail({ stderr: "Bearer runtime-secret" }),
          unavailableReason: "provider unavailable",
        }),
        "walkthrough",
      )

      expect(readyCapability).toMatchObject({
        _tag: "AgentCapabilityReady",
        runtimeVersion: "2.3.4",
      })
      expect(unsupportedCapability).toMatchObject({
        _tag: "AgentCapabilityPolicyUnsupported",
        reason: "missing permission control",
      })
      expect(unavailableCapability).toMatchObject({
        _tag: "AgentCapabilityUnavailable",
        reason: "Bearer [redacted]",
      })
    }),
  )

  it("creates bounded, sanitized operation errors from causes and direct reasons", () => {
    const errors = makeAgentProviderOperationErrorFactory({
      providerId: AgentProviderId.make("fixture"),
      fallbackReason: "Fixture execution failed",
      extraRedaction: (value) => value.replaceAll("vendor-secret", "[vendor-redacted]"),
    })

    expect(errors.fromCause("walkthrough")({ stderr: "Bearer shared-secret" }).reason).toBe(
      "Bearer [redacted]",
    )
    expect(errors.fromReason("review-thread", "vendor-secret token=assigned-secret").reason).toBe(
      "[vendor-redacted] token=[redacted]",
    )
  })
})
