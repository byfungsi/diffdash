import { AgentProviderId } from "@diffdash/protocol/agent-providers"
import { AgentProviderFailure } from "@diffdash/domain/provider-failure"
import { ReviewAgentProviderId } from "@diffdash/domain/review-agent"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { legacyBridgeTransportError } from "@diffdash/protocol/testing"
import { transportError, TransportErrorDiagnosticTrace } from "@diffdash/protocol/transport-error"
import { WalkthroughStartBridgeFailure } from "@diffdash/protocol/walkthrough-operation"
import {
  WalkthroughBridgeOperationSnapshot,
  WalkthroughCancelBridgeFailure,
  WalkthroughGetOperationBridgeFailure,
} from "@diffdash/protocol/walkthrough-operation-state"
import { Schema } from "effect"
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
  it("preserves a cloned Core provider failure and its operation metadata", () => {
    const failure = Schema.decodeUnknownSync(WalkthroughStartBridgeFailure)({
      _tag: "WalkthroughPublicFailure",
      applicationInstanceId: "app-report",
      processEpoch: "epoch-report",
      requestId: "h:report-request",
      method: "Walkthroughs.start",
      operationId: "operation-report",
      code: "AGENT_PROVIDER_EXIT",
      providerId: "claude",
      modelId: "claude-opus-5",
      retryClass: "userAction",
      remediation: "reauthenticateProvider",
      safeMessage: "The configured provider exited before completing the walkthrough.",
      attempts: [
        {
          providerId: "claude",
          modelId: "claude-opus-5",
          attempt: 1,
          stage: "execute",
          outcome: "provider-exit",
        },
      ],
      diagnostic: {
        causeTags: ["AgentProviderOperationError", "ProcessExitError"],
        exitCode: 9,
        signal: null,
        providerExcerpt: "Authentication required. Sign in again.",
        internalFrames: ["WalkthroughService.generate", "executeWalkthroughCandidate"],
        truncated: false,
      },
    })
    const cloned = structuredClone({
      ...Schema.encodeSync(WalkthroughStartBridgeFailure)(failure),
      cause: new Error("token=e2e-private-token"),
      path: "/Users/example/private-repository",
      prompt: "private prompt body",
    })

    const result = walkthroughErrorPresentation(cloned, context)

    expect(result.report).toContain("Core epoch: epoch-report")
    expect(result.report).toContain("Method: Walkthroughs.start")
    expect(result.report).toContain("Request ID: h:report-request")
    expect(result.report).toContain("Operation ID: operation-report")
    expect(result.report).toContain("Error code: AGENT_PROVIDER_EXIT")
    expect(result.report).toContain("Provider: claude")
    expect(result.report).toContain("Model: claude-opus-5")
    expect(result.report).toContain("Retry class: userAction")
    expect(result.report).toContain(
      "- claude / claude-opus-5 / attempt 1 / execute / provider-exit",
    )
    expect(result.report).toContain("> Authentication required. Sign in again.")
    expect(result.report).not.toContain("UNKNOWN_RENDERER_ERROR")
    expect(result.report).not.toContain("Operation: unknown")
    expect(result.report).not.toContain("cause:")
    expect(result.report).not.toContain("stack:")
    expect(result.report).not.toContain("e2e-private-token")
    expect(result.report).not.toContain("/Users/example/private-repository")
    expect(result.report).not.toContain("private prompt body")
  })

  it("retains stale-identity transport classification without leaking rejected data", () => {
    const failure = Schema.decodeUnknownSync(WalkthroughStartBridgeFailure)({
      _tag: "WalkthroughPublicFailure",
      applicationInstanceId: "app-current",
      processEpoch: "epoch-current",
      requestId: "h:current-request",
      method: "Walkthroughs.start",
      operationId: null,
      code: "WALKTHROUGH_TRANSPORT_ERROR",
      providerId: null,
      modelId: null,
      retryClass: "notRetryable",
      remediation: "retry",
      safeMessage: "DiffDash received a stale walkthrough response.",
      attempts: [],
      diagnostic: null,
    })

    const result = walkthroughErrorPresentation(
      structuredClone({ ...failure, rejectedResponse: "private stale response" }),
      context,
    )

    expect(result.report).toContain("Error code: WALKTHROUGH_TRANSPORT_ERROR")
    expect(result.report).toContain("Method: Walkthroughs.start")
    expect(result.report).toContain("Request ID: h:current-request")
    expect(result.report).toContain("Retry class: notRetryable")
    expect(result.report).not.toContain("UNKNOWN_RENDERER_ERROR")
    expect(result.report).not.toContain("private stale response")
  })

  it("reports authoritative query and cancellation failures through the safe model", () => {
    const queryFailure = Schema.decodeUnknownSync(WalkthroughGetOperationBridgeFailure)({
      _tag: "WalkthroughPublicFailure",
      applicationInstanceId: "app-current",
      processEpoch: "epoch-current",
      requestId: "h:query-request",
      method: "Walkthroughs.getOperation",
      operationId: "operation-current",
      code: "WALKTHROUGH_OPERATION_NOT_FOUND",
      providerId: null,
      modelId: null,
      retryClass: "notRetryable",
      remediation: "regenerate",
      safeMessage: "The walkthrough operation is no longer available.",
      attempts: [],
      diagnostic: null,
    })
    const cancelFailure = Schema.decodeUnknownSync(WalkthroughCancelBridgeFailure)({
      ...queryFailure,
      requestId: "h:cancel-request",
      method: "Walkthroughs.cancel",
      code: "CORE_UNAVAILABLE",
      remediation: "retry",
      safeMessage: "Walkthrough cancellation is temporarily unavailable.",
    })

    const queryReport = walkthroughErrorPresentation(queryFailure, context).report
    const cancelReport = walkthroughErrorPresentation(cancelFailure, context).report

    expect(queryReport).toContain("Method: Walkthroughs.getOperation")
    expect(queryReport).toContain("Error code: WALKTHROUGH_OPERATION_NOT_FOUND")
    expect(cancelReport).toContain("Method: Walkthroughs.cancel")
    expect(cancelReport).toContain("Error code: CORE_UNAVAILABLE")
  })

  it("maps a cancelled authoritative snapshot through the safe report", () => {
    const cancelled = Schema.decodeUnknownSync(WalkthroughBridgeOperationSnapshot)({
      acceptedRequest: {
        applicationInstanceId: "app-current",
        processEpoch: "epoch-current",
        requestId: "h:start-request",
      },
      operationId: "operation-current",
      stateVersion: 4,
      idempotencyKey: "w:current-operation",
      reviewGeneration: {
        kind: "local",
        projectId: "project-current",
        snapshotId: "snapshot:v1:00000000000000000000000000000000",
        reviewKey: "local:current",
        baseRevision: "base-current",
        headRevision: "head-current",
      },
      promptVersion: "walkthrough-v4",
      configuredRoute: { mode: "auto", quality: "balanced" },
      candidatePlanFingerprint: `walkthrough-plan:v1:${"0".repeat(64)}`,
      attempts: [],
      acceptedAt: "2026-08-15T10:00:00.000Z",
      updatedAt: "2026-08-15T10:00:01.000Z",
      state: "cancelled",
      terminalAt: "2026-08-15T10:00:01.000Z",
    })

    const result = walkthroughErrorPresentation(cancelled, context)

    expect(result.message).toBe("Walkthrough generation was cancelled.")
    expect(result.report).toContain("Error code: WALKTHROUGH_CANCELLED")
    expect(result.report).toContain("Operation ID: operation-current")
  })

  it("decodes bridge-safe provider diagnostics into an actionable report", () => {
    const error = legacyBridgeTransportError(
      transportError(
        "AgentProviderExitError",
        "Provider claude exited before completing the walkthrough.",
        InvokeChannel.startWalkthroughOperation,
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
        AgentProviderFailure.make({
          version: 1,
          providerId: ReviewAgentProviderId.make("claude"),
          capability: "walkthrough",
          category: "authentication",
          processKind: "exit",
          exitCode: 9,
          signal: null,
          httpStatus: null,
          retryAfterSeconds: null,
          resetsAt: null,
        }),
      ),
    )

    const result = walkthroughErrorPresentation({ message: error.message }, context)

    expect(result.message).toBe(
      "Provider claude authentication failed or expired. Sign in again, then retry.",
    )
    expect(result.report).toContain("Review type: Repository comparison")
    expect(result.report).toContain(`Operation: ${InvokeChannel.startWalkthroughOperation}`)
    expect(result.report).toContain("Error code: AgentProviderExitError")
    expect(result.report).toContain("Error source: Main process")
    expect(result.report).toContain("Failure category: authentication")
    expect(result.report).toContain("Cause tag: ProcessExitError")
    expect(result.report).toContain("Exit code: 9")
    expect(result.report).toContain("- at runClaude")
  })

  it("uses the source-neutral start operation for renderer fallbacks", () => {
    const result = walkthroughErrorPresentation(new Error("private renderer failure"), context)

    expect(result.report).toContain("Error code: WALKTHROUGH_RENDERER_ERROR")
    expect(result.report).toContain("Error source: Renderer")
    expect(result.report).toContain(`Operation: ${InvokeChannel.startWalkthroughOperation}`)
    expect(result.report).not.toContain("UNKNOWN_RENDERER_ERROR")
    expect(result.report).not.toContain("Operation: unknown")
    expect(result.report).not.toContain("private renderer failure")
  })

  it("uses explicit internal and malformed transport fallback codes", () => {
    const internal = walkthroughErrorPresentation(
      legacyBridgeTransportError(transportError("INTERNAL_ERROR", "Safe generic failure")),
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

  it("builds actionable provider guidance", () => {
    const result = walkthroughErrorPresentation(
      transportError(
        "AgentProviderOperationError",
        "Provider codex could not complete walkthrough generation.",
        InvokeChannel.startWalkthroughOperation,
      ),
      { ...context, provider: "Codex", reviewSource: "local" },
    )

    expect(result.message).toBe(
      "The configured AI provider could not generate this walkthrough. Check its setup, then retry.",
    )
    expect(result.report).toContain("Review type: Local changes")
    expect(result.report).toContain("Error code: AgentProviderOperationError")
  })

  it("uses typed timeout guidance for a capability preflight failure", () => {
    const result = walkthroughErrorPresentation(
      transportError(
        "AgentCapabilityUnavailableError",
        "Provider claude is currently unavailable.",
        InvokeChannel.startWalkthroughOperation,
        undefined,
        AgentProviderFailure.make({
          version: 1,
          providerId: ReviewAgentProviderId.make("claude"),
          capability: "walkthrough",
          category: "timeout",
          processKind: null,
          exitCode: null,
          signal: null,
          httpStatus: null,
          retryAfterSeconds: null,
          resetsAt: null,
        }),
      ),
      context,
    )

    expect(result.message).toBe(
      "The AI provider timed out while generating this walkthrough. Retry or select a faster model.",
    )
  })

  it("distinguishes invalid and empty provider output guidance", () => {
    const invalid = walkthroughErrorPresentation(
      transportError(
        "WalkthroughValidationError",
        "The AI agent returned a walkthrough that did not pass validation after retrying.",
      ),
      context,
    )
    const empty = walkthroughErrorPresentation(
      transportError(
        "InvalidAgentProviderResponseError",
        "Provider codex completed without usable walkthrough text.",
      ),
      context,
    )

    expect(invalid.message).toContain("DiffDash retried once")
    expect(empty.message).toBe(
      "The AI provider returned no usable walkthrough. Retry or select another model.",
    )
    expect(empty.message).not.toContain("retried")
  })

  it("normalizes copied context to bounded single lines", () => {
    const result = walkthroughErrorPresentation(
      legacyBridgeTransportError(transportError("EXPECTED", "Safe reason")),
      { ...context, model: `model\n${"x".repeat(600)}` },
    )

    expect(result.report).not.toContain("model\n")
    expect(result.report).not.toContain("x".repeat(501))
  })
})
