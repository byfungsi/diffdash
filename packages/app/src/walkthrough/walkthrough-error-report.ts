import { InvokeChannel } from "@diffdash/protocol/channels"
import {
  decodeTransportError,
  hasBridgeTransportErrorEncoding,
  sanitizeTransportErrorMessage,
  UNKNOWN_TRANSPORT_ERROR_MESSAGE,
} from "@diffdash/protocol/transport-error"

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
export const walkthroughErrorPresentation = (
  error: unknown,
  context: WalkthroughErrorReportContext,
): WalkthroughErrorPresentation => {
  const transport = decodeTransportError(error)
  const code =
    transport?.code === "INTERNAL_ERROR"
      ? "WALKTHROUGH_INTERNAL_ERROR"
      : (transport?.code ??
        (hasBridgeTransportErrorEncoding(error)
          ? "WALKTHROUGH_TRANSPORT_ERROR"
          : "WALKTHROUGH_RENDERER_ERROR"))
  const details = sanitizeTransportErrorMessage(
    transport?.message ?? UNKNOWN_TRANSPORT_ERROR_MESSAGE,
  )
  const operation = transport?.operation ?? walkthroughGenerationOperation(context.reviewSource)
  const diagnostic = transport?.diagnostic

  return {
    message: walkthroughUserMessage(code, details),
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
      `Error code: ${safeReportLine(code)}`,
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

const walkthroughUserMessage = (code: string, details: string): string => {
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
