import type { AgentProviderFailure } from "@diffdash/domain/provider-failure"
import { InvokeChannel } from "@diffdash/protocol/channels"
import {
  WalkthroughStartBridgeFailure,
  type WalkthroughStartBridgeFailure as WalkthroughStartBridgeFailureType,
} from "@diffdash/protocol/walkthrough-operation"
import {
  decodeTransportError,
  hasBridgeTransportErrorEncoding,
  sanitizeTransportErrorMessage,
  UNKNOWN_TRANSPORT_ERROR_MESSAGE,
} from "@diffdash/protocol/transport-error"
import { rendererFailureInput } from "@/shared/errors"
import { Result, Schema } from "effect"

/** Review source used to derive the expected walkthrough generation operation. */
export type WalkthroughErrorReviewSource = "hosted" | "local" | "repositoryComparison"

/** Safe product context included when a user copies walkthrough error details. */
export interface WalkthroughErrorReportContext {
  readonly action: "generate" | "regenerate"
  readonly appVersion: string
  readonly model: string
  readonly occurredAt: string
  readonly platform: string
  readonly provider: string
  readonly reviewSource: WalkthroughErrorReviewSource
}

/** Separate user guidance and support diagnostics for one walkthrough failure. */
export interface WalkthroughErrorPresentation {
  readonly message: string
  readonly report: string
}

/** Builds actionable walkthrough guidance plus bounded details safe for a user report. */
export const walkthroughErrorPresentation = <Value>(
  error: Value,
  context: WalkthroughErrorReportContext,
): WalkthroughErrorPresentation => {
  const publicFailure = Schema.decodeUnknownResult(WalkthroughStartBridgeFailure)(error)
  if (Result.isSuccess(publicFailure)) {
    return walkthroughPublicFailurePresentation(publicFailure.success, context)
  }

  const input = rendererFailureInput(error)
  const transport = decodeTransportError(input)
  const code =
    transport?.code === "INTERNAL_ERROR"
      ? "WALKTHROUGH_INTERNAL_ERROR"
      : (transport?.code ??
        (hasBridgeTransportErrorEncoding(input)
          ? "WALKTHROUGH_TRANSPORT_ERROR"
          : "WALKTHROUGH_RENDERER_ERROR"))
  const details = sanitizeTransportErrorMessage(
    transport?.message ?? UNKNOWN_TRANSPORT_ERROR_MESSAGE,
  )
  const operation = transport?.operation ?? walkthroughGenerationOperation(context.reviewSource)
  const diagnostic = transport?.diagnostic
  const providerFailure = transport?.providerFailure
  const errorSource = transport === null ? "Renderer" : "Main process"

  return {
    message: walkthroughUserMessage(code, details, providerFailure),
    report: [
      "DiffDash walkthrough error",
      "",
      `App version: ${safeReportLine(context.appVersion)}`,
      `Occurred at: ${safeReportLine(context.occurredAt)}`,
      `Review type: ${walkthroughReviewType(context.reviewSource)}`,
      `Action: ${context.action === "regenerate" ? "Regenerate" : "Generate"}`,
      `Configured route: ${safeReportLine(context.provider)}`,
      `Configured model or quality: ${safeReportLine(context.model)}`,
      `Platform: ${safeReportLine(context.platform)}`,
      `Operation: ${safeReportLine(operation)}`,
      `Error source: ${errorSource}`,
      `Error code: ${safeReportLine(code)}`,
      ...(providerFailure === undefined
        ? []
        : [
            `Failure category: ${providerFailure.category}`,
            `Failure capability: ${providerFailure.capability}`,
          ]),
      `Details: ${details}`,
      ...(diagnostic === undefined
        ? []
        : [
            "",
            "Diagnostic trace:",
            `Provider tag: ${safeReportLine(diagnostic.provider)}`,
            `Error tag: ${safeReportLine(diagnostic.errorTag)}`,
            `Cause tag: ${safeReportLine(diagnostic.causeTag)}`,
            `Exit code: ${diagnostic.exitCode ?? "none"}`,
            `Signal: ${diagnostic.signal === null ? "none" : safeReportLine(diagnostic.signal)}`,
            `Reason: ${safeReportLine(diagnostic.reason)}`,
            `Stderr: ${safeReportLine(diagnostic.stderr)}`,
            "Internal stack frames:",
            ...(diagnostic.stackFrames.length === 0
              ? ["- none"]
              : diagnostic.stackFrames.map((frame) => `- ${safeReportLine(frame)}`)),
          ]),
    ].join("\n"),
  }
}

const walkthroughPublicFailurePresentation = (
  failure: WalkthroughStartBridgeFailureType,
  context: WalkthroughErrorReportContext,
): WalkthroughErrorPresentation => ({
  message:
    failure.remediation === "reauthenticateProvider" && failure.providerId !== null
      ? `Provider ${failure.providerId} authentication failed or expired. Sign in again, then retry.`
      : walkthroughUserMessage(failure.code, failure.safeMessage),
  report: [
    "DiffDash walkthrough error",
    "",
    `App version: ${safeReportLine(context.appVersion)}`,
    `Occurred at: ${safeReportLine(context.occurredAt)}`,
    `Review type: ${walkthroughReviewType(context.reviewSource)}`,
    `Action: ${context.action === "regenerate" ? "Regenerate" : "Generate"}`,
    `Configured route: ${safeReportLine(context.provider)}`,
    `Configured model or quality: ${safeReportLine(context.model)}`,
    `Platform: ${safeReportLine(context.platform)}`,
    `Core epoch: ${safeReportLine(failure.processEpoch)}`,
    `Method: ${failure.method}`,
    `Request ID: ${safeReportLine(failure.requestId)}`,
    `Operation ID: ${failure.operationId === null ? "not allocated" : safeReportLine(failure.operationId)}`,
    `Error source: Core`,
    `Error code: ${failure.code}`,
    `Provider: ${failure.providerId === null ? "none" : safeReportLine(failure.providerId)}`,
    `Model: ${failure.modelId === null ? "none" : safeReportLine(failure.modelId)}`,
    `Retry class: ${failure.retryClass}`,
    `Remediation: ${failure.remediation}`,
    `Details: ${safeReportLine(failure.safeMessage)}`,
    "",
    "Attempt summary:",
    ...(failure.attempts.length === 0
      ? ["- none"]
      : failure.attempts.map(
          (attempt) =>
            `- ${safeReportLine(attempt.providerId)} / ${attempt.modelId === null ? "default" : safeReportLine(attempt.modelId)} / attempt ${attempt.attempt} / ${attempt.stage} / ${attempt.outcome}`,
        )),
    ...(failure.diagnostic === null
      ? []
      : [
          "",
          "Diagnostic trace:",
          ...(failure.diagnostic.causeTags.length === 0
            ? ["- Cause tags: none"]
            : failure.diagnostic.causeTags.map((tag) => `- ${safeReportLine(tag)}`)),
          `- Exit code: ${failure.diagnostic.exitCode ?? "none"}`,
          `- Signal: ${failure.diagnostic.signal ?? "none"}`,
          `- Truncated: ${failure.diagnostic.truncated ? "yes" : "no"}`,
          "",
          "Provider diagnostic:",
          ...(failure.diagnostic.providerExcerpt === null
            ? ["> none"]
            : failure.diagnostic.providerExcerpt
                .split("\n")
                .map((line) => `> ${safeReportLine(line)}`)),
          "",
          "Internal frames:",
          ...(failure.diagnostic.internalFrames.length === 0
            ? ["- none"]
            : failure.diagnostic.internalFrames.map((frame) => `- ${safeReportLine(frame)}`)),
        ]),
  ].join("\n"),
})

const walkthroughGenerationOperation = (source: WalkthroughErrorReviewSource): string => {
  if (source === "hosted") return InvokeChannel.generateWalkthrough
  if (source === "local") return InvokeChannel.generateLocalWalkthrough
  return InvokeChannel.generateRepositoryComparisonWalkthrough
}

const walkthroughReviewType = (source: WalkthroughErrorReviewSource): string => {
  if (source === "hosted") return "Pull request"
  if (source === "local") return "Local changes"
  return "Repository comparison"
}

const walkthroughUserMessage = (
  code: string,
  details: string,
  providerFailure?: AgentProviderFailure,
): string => {
  const categoryMessage = walkthroughProviderFailureMessage(providerFailure)
  if (categoryMessage !== null) return categoryMessage
  if (code === "AgentProviderTimeoutError") {
    return "The AI provider timed out while generating this walkthrough. Retry or select a faster model."
  }
  if (code === "AgentProviderSpawnError") {
    return "DiffDash could not start the configured AI provider. Check that it is installed, then retry."
  }
  if (code === "AgentProviderExitError") {
    return "The AI provider stopped before finishing the walkthrough. Check sign-in, connection, and quota, then retry."
  }
  if (
    code === "AgentProviderCleanupError" ||
    code === "AgentProviderIoError" ||
    code === "AgentProviderOperationError"
  ) {
    return "The configured AI provider could not generate this walkthrough. Check its setup, then retry."
  }
  if (code === "WalkthroughGenerationError" || code === "WalkthroughValidationError") {
    return "The AI agent returned an invalid walkthrough. DiffDash retried once; retry or select another model."
  }
  if (code === "InvalidAgentProviderResponseError") {
    return "The AI provider returned no usable walkthrough. Retry or select another model."
  }
  if (
    code === "AgentCapabilityUnavailableError" ||
    code === "AgentPolicyEnforcementError" ||
    code === "AgentProviderProbeError" ||
    code === "MissingAgentProviderError" ||
    code === "NoAgentProviderAvailableError" ||
    code === "UnsupportedAgentCapabilityError" ||
    code === "WalkthroughModelUnavailableError"
  ) {
    return "The selected AI provider or model cannot generate walkthroughs. Check AI Settings, then retry."
  }
  if (code === "ReviewContextError") {
    return "DiffDash could not refresh this review. Make sure the repository is available and not changing, then retry."
  }
  if (code === "WalkthroughPromptPreparationError") {
    return "There are no reviewable changes available for a walkthrough. Refresh the review and try again."
  }
  if (code === "WalkthroughStoreError") {
    return "DiffDash could not access the walkthrough cache. Retry, then copy the error details if it continues."
  }
  if (code === "IPC_FAILURE" || code === "WALKTHROUGH_TRANSPORT_ERROR") {
    return "DiffDash lost contact with its main process. Retry the walkthrough."
  }
  if (code === "WALKTHROUGH_INTERNAL_ERROR" || code === "WALKTHROUGH_RENDERER_ERROR") {
    return "DiffDash hit an unexpected walkthrough error. Retry, then copy the error details if it continues."
  }
  return details
}

const walkthroughProviderFailureMessage = (
  failure: AgentProviderFailure | undefined,
): string | null => {
  switch (failure?.category) {
    case "authentication":
      return `Provider ${failure.providerId} authentication failed or expired. Sign in again, then retry.`
    case "authorization":
      return "The AI provider denied access to this operation or model. Check the provider account, then retry."
    case "rate-limited":
      return "The AI provider is temporarily rate limited. Wait briefly, then retry."
    case "usage-limited":
      return "The AI provider reached a session or usage limit. Retry after the limit resets."
    case "quota-exhausted":
      return "The AI provider reached an account quota or billing limit. Check the provider account before retrying."
    case "network":
      return "The AI provider could not connect to its service. Check the network, then retry."
    case "model-unavailable":
      return "The AI provider could not use the selected model. Choose another model in AI Settings, then retry."
    case "provider-unavailable":
      return "The AI provider is temporarily unavailable. Retry shortly."
    case "policy-violation":
      return "The AI provider could not satisfy DiffDash's read-only policy. Check its version and configuration, then retry."
    case "timeout":
      return "The AI provider timed out while generating this walkthrough. Retry or select a faster model."
    case "configuration":
    case "invalid-response":
    case "process-failure":
    case "unknown":
    case undefined:
      return null
  }
  return null
}

const safeReportLine = (value: string): string =>
  [...value]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || (code >= 127 && code <= 159) ? " " : character
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500) || "unavailable"
