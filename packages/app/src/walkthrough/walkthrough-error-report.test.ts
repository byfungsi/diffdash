import { transportError } from "@diffdash/protocol/transport-error"
import { describe, expect, it } from "vitest"
import { walkthroughErrorPresentation } from "./walkthrough-error-report"

const context = {
  action: "generate",
  appVersion: "0.5.0",
  model: "gpt-5",
  occurredAt: "2026-08-05T12:34:56.000Z",
  platform: "MacIntel",
  provider: "Codex",
  reviewType: "Local changes",
} as const

describe("walkthroughErrorPresentation", () => {
  it("builds actionable provider guidance and a structured report", () => {
    const result = walkthroughErrorPresentation(
      transportError(
        "AgentProviderOperationError",
        "Provider codex could not complete walkthrough generation.",
        "localWalkthroughs:generate",
      ),
      context,
    )

    expect(result.message).toBe(
      "The configured AI provider could not generate this walkthrough. Check its setup, then retry.",
    )
    expect(result.report).toBe(`DiffDash walkthrough error

App version: 0.5.0
Occurred at: 2026-08-05T12:34:56.000Z
Review type: Local changes
Action: Generate
Configured route: Codex
Configured model or quality: gpt-5
Platform: MacIntel
Operation: localWalkthroughs:generate
Error code: AgentProviderOperationError
Details: Provider codex could not complete walkthrough generation.`)
  })

  it("gives invalid model output a clean recovery message", () => {
    const result = walkthroughErrorPresentation(
      transportError(
        "WalkthroughValidationError",
        "The AI agent returned a walkthrough that did not pass validation after retrying.",
        "localWalkthroughs:generate",
      ),
      context,
    )

    expect(result.message).toBe(
      "The AI agent returned an invalid walkthrough. DiffDash retried once; retry or select another model.",
    )
  })

  it("does not claim an empty provider response was retried", () => {
    const result = walkthroughErrorPresentation(
      transportError(
        "InvalidAgentProviderResponseError",
        "Provider codex completed without usable walkthrough text.",
        "localWalkthroughs:generate",
      ),
      context,
    )

    expect(result.message).toBe(
      "The AI provider returned no usable walkthrough. Retry or select another model.",
    )
    expect(result.message).not.toContain("retried")
  })

  it("never copies unknown renderer error details", () => {
    const result = walkthroughErrorPresentation(
      new Error("private failure at /Users/example/secret-repository"),
      context,
    )

    expect(result.message).toContain("unexpected walkthrough error")
    expect(result.report).toContain("Error code: UNKNOWN_RENDERER_ERROR")
    expect(result.report).toContain("Details: DiffDash could not complete the request.")
    expect(result.report).not.toContain("secret-repository")
  })

  it("normalizes copied context to bounded single lines", () => {
    const result = walkthroughErrorPresentation(
      transportError("EXPECTED", "Safe reason", "localWalkthroughs:generate"),
      { ...context, model: `model\n${"x".repeat(300)}` },
    )

    expect(result.report).not.toContain("model\n")
    expect(result.report).not.toContain("x".repeat(201))
  })
})
