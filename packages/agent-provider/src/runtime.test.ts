import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { AgentProviderFailure, AgentProviderId } from "./agent-provider"
import {
  boundedProviderReason,
  classifyProviderFailureText,
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

  it.each([
    ["Authentication failed", "authentication"],
    ["Authentication required", "authentication"],
    ["Authorization denied for this model", "authorization"],
    ["HTTP 429 too many requests", "rate-limited"],
    ["Weekly usage limit reached and resets tomorrow", "usage-limited"],
    ["Billing quota exhausted", "quota-exhausted"],
    ["ECONNREFUSED while connecting", "network"],
    ["Model is unavailable", "model-unavailable"],
    ["Request timed out", "timeout"],
  ] as const)("classifies %s without retaining provider text", (reason, category) => {
    expect(classifyProviderFailureText(reason)).toBe(category)
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
    expect(
      errors.fromCause("walkthrough")({
        _tag: "ProcessExitError",
        stdout: "Failed to authenticate. OAuth session expired and could not be refreshed.",
        stderr: "",
        exitCode: 1,
        signal: null,
      }).failure,
    ).toMatchObject({
      category: "authentication",
      processKind: "exit",
      exitCode: 1,
    })
    expect(errors.fromReason("review-thread", "vendor-secret token=assigned-secret").reason).toBe(
      "[vendor-redacted] token=[redacted]",
    )
    expect(
      errors.fromReason("review-thread", "Session limit reached; resets at 3pm").failure.category,
    ).toBe("usage-limited")
    expect(errors.fromReason("review-thread", "Rate limit reached").failure.category).toBe(
      "rate-limited",
    )
    expect(
      errors.fromCause("review-thread")({ status: 429, message: "request failed" }).failure,
    ).toMatchObject({ category: "rate-limited", httpStatus: 429 })
    expect(
      errors.fromCause("review-thread")({ statusCode: 402, message: "request failed" }).failure,
    ).toMatchObject({ category: "quota-exhausted", httpStatus: 402 })
    expect(
      errors.fromCause("review-thread")({ statusCode: 408, message: "request failed" }).failure,
    ).toMatchObject({ category: "timeout", httpStatus: 408 })
    expect(
      errors.fromCause("review-thread")({ status: 403, message: "authentication required" })
        .failure,
    ).toMatchObject({ category: "authorization", httpStatus: 403 })
  })

  it("rejects impossible provider reset timestamps", () => {
    expect(() =>
      AgentProviderFailure.make({
        version: 1,
        providerId: "fixture",
        capability: "walkthrough",
        category: "usage-limited",
        processKind: null,
        exitCode: null,
        signal: null,
        httpStatus: null,
        retryAfterSeconds: null,
        resetsAt: "2026-99-99T99:99:99Z",
      }),
    ).toThrow(/Schema validation failed/)
  })
})
