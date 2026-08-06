import { AgentProviderId } from "@diffdash/protocol/agent-providers"
import { InvokeChannel } from "@diffdash/protocol/channels"
import {
  bridgeTransportError,
  transportError,
  TransportErrorDiagnosticTrace,
} from "@diffdash/protocol/transport-error"
import { describe, expect, it } from "vitest"
import { walkthroughErrorPresentation } from "./walkthrough-error-report"

const context = {
  action: "generate",
  appVersion: "0.5.0",
  model: "claude-sonnet-5",
  occurredAt: "2026-08-05T12:34:56.000Z",
  platform: "MacIntel",
  provider: "Claude",
  reviewSource: "repositoryComparison",
} as const

describe("walkthroughErrorPresentation", () => {
  it("decodes bridge-safe provider diagnostics into an actionable report", () => {
    const error = bridgeTransportError(
      transportError(
        "AgentProviderExitError",
        "Provider claude exited before completing the walkthrough.",
        InvokeChannel.generateRepositoryComparisonWalkthrough,
        new TransportErrorDiagnosticTrace({
          provider: AgentProviderId.make("claude"),
          errorTag: "AgentProviderOperationError",
          causeTag: "ProcessExitError",
          exitCode: 9,
          signal: null,
          reason: "Authentication or authorization failure reported.",
          stderr: "Provider diagnostics were redacted.",
          stackFrames: ["at runClaude", "at generateWalkthrough"],
        }),
      ),
    )

    const result = walkthroughErrorPresentation({ message: error.message }, context)

    expect(result.message).toBe(
      "The AI provider stopped before finishing the walkthrough. Check sign-in, connection, and quota, then retry.",
    )
    expect(result.report).toContain("Review type: Repository comparison")
    expect(result.report).toContain(
      `Operation: ${InvokeChannel.generateRepositoryComparisonWalkthrough}`,
    )
    expect(result.report).toContain("Error code: AgentProviderExitError")
    expect(result.report).toContain("Cause tag: ProcessExitError")
    expect(result.report).toContain("Exit code: 9")
    expect(result.report).toContain("- at runClaude")
  })

  it.each([
    ["hosted", InvokeChannel.generateWalkthrough],
    ["local", InvokeChannel.generateLocalWalkthrough],
    ["repositoryComparison", InvokeChannel.generateRepositoryComparisonWalkthrough],
  ] as const)("derives the expected %s generation operation for renderer fallbacks", (source, operation) => {
    const result = walkthroughErrorPresentation(new Error("private renderer failure"), {
      ...context,
      reviewSource: source,
    })

    expect(result.report).toContain("Error code: WALKTHROUGH_RENDERER_ERROR")
    expect(result.report).toContain(`Operation: ${operation}`)
    expect(result.report).not.toContain("UNKNOWN_RENDERER_ERROR")
    expect(result.report).not.toContain("Operation: unknown")
    expect(result.report).not.toContain("private renderer failure")
  })

  it("uses explicit internal and malformed transport fallback codes", () => {
    const internal = walkthroughErrorPresentation(
      bridgeTransportError(transportError("INTERNAL_ERROR", "Safe generic failure")),
      context,
    )
    const malformed = walkthroughErrorPresentation(
      new Error("DIFFDASH_TRANSPORT_ERROR_V1:not-json"),
      context,
    )

    expect(internal.report).toContain("Error code: WALKTHROUGH_INTERNAL_ERROR")
    expect(malformed.report).toContain("Error code: WALKTHROUGH_TRANSPORT_ERROR")
    expect(internal.report).not.toContain("Operation: unknown")
    expect(malformed.report).not.toContain("Operation: unknown")
  })

  it("normalizes copied context to bounded single lines", () => {
    const result = walkthroughErrorPresentation(
      bridgeTransportError(transportError("EXPECTED", "Safe reason")),
      { ...context, model: `model\n${"x".repeat(600)}` },
    )

    expect(result.report).not.toContain("model\n")
    expect(result.report).not.toContain("x".repeat(501))
  })
})
