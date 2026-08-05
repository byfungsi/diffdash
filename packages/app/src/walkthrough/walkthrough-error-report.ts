import {
  sanitizeTransportErrorMessage,
  TransportError,
  UNKNOWN_TRANSPORT_ERROR_MESSAGE,
} from "@diffdash/protocol/transport-error"
import { Either, Schema } from "effect"

/** Safe product context included when a user copies walkthrough error details. */
export interface WalkthroughErrorReportContext {
  readonly action: "generate" | "regenerate"
  readonly appVersion: string
  readonly model: string
  readonly occurredAt: string
  readonly platform: string
  readonly provider: string
  readonly reviewType: string
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
  const decoded = Schema.decodeUnknownEither(TransportError)(error)
  const transport = Either.isRight(decoded) ? decoded.right : null
  const code = transport?.code ?? "UNKNOWN_RENDERER_ERROR"
  const details = sanitizeTransportErrorMessage(
    transport?.message ?? UNKNOWN_TRANSPORT_ERROR_MESSAGE,
  )
  const operation = safeReportLine(transport?.operation ?? "unknown")
  const provider = safeReportLine(context.provider)

  return {
    message: walkthroughUserMessage(code, details),
    report: [
      "DiffDash walkthrough error",
      "",
      `App version: ${safeReportLine(context.appVersion)}`,
      `Occurred at: ${safeReportLine(context.occurredAt)}`,
      `Review type: ${safeReportLine(context.reviewType)}`,
      `Action: ${context.action === "regenerate" ? "Regenerate" : "Generate"}`,
      `Configured route: ${provider}`,
      `Configured model or quality: ${safeReportLine(context.model)}`,
      `Platform: ${safeReportLine(context.platform)}`,
      `Operation: ${operation}`,
      `Error code: ${safeReportLine(code)}`,
      `Details: ${details}`,
    ].join("\n"),
  }
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
  if (code === "IPC_FAILURE") {
    return "DiffDash lost contact with its main process. Retry the walkthrough."
  }
  if (code !== "INTERNAL_ERROR" && code !== "UNKNOWN_RENDERER_ERROR") return details
  return "DiffDash hit an unexpected walkthrough error. Retry, then copy the error details if it continues."
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
    .slice(0, 200) || "unknown"
