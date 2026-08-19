import { legacyBridgeTransportError } from "@diffdash/protocol/testing"
import { transportError } from "@diffdash/protocol/transport-error"
import { describe, expect, it } from "vitest"
import { formatError } from "./errors"

describe("formatError", () => {
  it("decodes protocol errors after a contextBridge-style clone", () => {
    const encoded = legacyBridgeTransportError(
      transportError("EXPECTED", "Safe renderer message", "Walkthroughs.start"),
    )

    expect(formatError({ message: encoded.message }, "Fallback")).toBe("Safe renderer message")
  })

  it("adds caller context to safe domain reasons and removes preload channel metadata", () => {
    const encoded = legacyBridgeTransportError(
      transportError(
        "RepositoryLinkError",
        "repositories:openProject failed: Select a Git repository with a GitHub origin.",
        "repositories:openProject",
      ),
    )

    expect(formatError({ message: encoded.message }, "Could not open repository")).toBe(
      "Could not open repository: Select a Git repository with a GitHub origin.",
    )
  })

  it("removes preload channel metadata from other public transport messages", () => {
    const encoded = legacyBridgeTransportError(
      transportError(
        "APP_STATE_UNAVAILABLE",
        "appState:get failed: Application runtime unavailable",
        "appState:get",
      ),
    )

    expect(formatError({ message: encoded.message }, "Could not load application state")).toBe(
      "Application runtime unavailable",
    )
  })
})
