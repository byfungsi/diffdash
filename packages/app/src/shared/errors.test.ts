import { bridgeTransportError, transportError } from "@diffdash/protocol/transport-error"
import { describe, expect, it } from "vitest"
import { formatError } from "./errors"

describe("formatError", () => {
  it("decodes protocol errors after a contextBridge-style clone", () => {
    const encoded = bridgeTransportError(
      transportError("EXPECTED", "Safe renderer message", "walkthroughs:generate"),
    )

    expect(formatError({ message: encoded.message }, "Fallback")).toBe("Safe renderer message")
  })
})
