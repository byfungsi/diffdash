import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { CoreArtifactVerificationError } from "./core-artifact"
import { CoreHostSelectionError } from "./core-host-selection"
import { CoreStartupReadinessError, formatDesktopStartupError } from "./desktop-startup-error"

describe("desktop startup error reporting", () => {
  it("reports a safe reason for a typed Promise rejection with an empty message", async () => {
    const failure = CoreHostSelectionError.make({
      mode: "auto",
      host: "bun",
      reason: "fallback-disabled",
      qualificationCapability: "version",
      safeMessage: "DiffDash Core is unavailable.",
    })
    const message = await Effect.runPromise(Effect.fail(failure)).catch(formatDesktopStartupError)

    expect(message).toContain("DiffDash Core is unavailable.")
    expect(message).toContain("fallback-disabled")
    expect(message).toContain("version")
  })

  it("reports the packaged artifact verification reason", () => {
    const failure = CoreArtifactVerificationError.make({
      reason: "entrypoint-checksum-mismatch",
      safeMessage: "DiffDash could not verify its packaged Core artifact.",
    })

    expect(formatDesktopStartupError(failure)).toContain("entrypoint-checksum-mismatch")
  })

  it.each(["failed", "draining", "timeout"] as const)("reports Core readiness %s", (reason) => {
    expect(formatDesktopStartupError(CoreStartupReadinessError.make({ reason }))).toContain(
      `CoreStartupReadinessError: ${reason}`,
    )
  })

  it("does not trust arbitrary safeMessage properties", () => {
    expect(formatDesktopStartupError({ safeMessage: "secret=private-token" })).not.toContain(
      "private-token",
    )
  })

  it.each([
    new Error(""),
    new Error("secret=private-token /private/path"),
    null,
    undefined,
    {},
  ])("gives an opaque nonempty message for unexpected failures (%s)", (failure) => {
    const message = formatDesktopStartupError(failure)
    expect(message).toContain("DiffDash could not finish starting.")
    expect(message).not.toContain("private-token")
    expect(message).not.toContain("/private/path")
  })
})
