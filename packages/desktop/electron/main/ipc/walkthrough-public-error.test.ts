import { AgentProviderId, AgentProviderOperationError } from "@diffdash/agent-provider"
import { WalkthroughPromptPreparationError } from "@diffdash/domain/walkthrough"
import { WalkthroughStoreError } from "@diffdash/persistence/walkthrough-store"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { UNKNOWN_TRANSPORT_ERROR_MESSAGE } from "@diffdash/protocol/transport-error"
import { WalkthroughGenerationError } from "@diffdash/walkthrough"
import { describe, expect, it } from "vitest"
import { ReviewContextError } from "../../../src/main/services/review-context"
import { toPublicWalkthroughError } from "./walkthrough-public-error"

const operation = InvokeChannel.generateLocalWalkthrough

describe("toPublicWalkthroughError", () => {
  it("classifies a provider failure without its reason or private cause", () => {
    const error = AgentProviderOperationError.make({
      providerId: AgentProviderId.make("codex"),
      capability: "walkthrough",
      reason: "Failure in /Users/example/secret-repository with private stderr",
      cause: new Error("private cause at /Users/example/secret-repository"),
    })

    const result = toPublicWalkthroughError(error, operation)

    expect(result).toMatchObject({
      code: "AgentProviderOperationError",
      message: "Provider codex could not complete walkthrough generation.",
      operation,
    })
    expect(JSON.stringify(result)).not.toContain("secret-repository")
    expect(JSON.stringify(result)).not.toContain("private stderr")
  })

  it("identifies a provider timeout without exposing process diagnostics", () => {
    const result = toPublicWalkthroughError(
      AgentProviderOperationError.make({
        providerId: AgentProviderId.make("codex"),
        capability: "walkthrough",
        reason: "Command timed out in /Users/example/secret-repository",
        cause: { _tag: "ProcessTimeoutError", stderr: "private stderr" },
      }),
      operation,
    )

    expect(result).toMatchObject({
      code: "AgentProviderTimeoutError",
      message: "Provider codex timed out during walkthrough generation.",
    })
    expect(JSON.stringify(result)).not.toContain("private")
  })

  it.each([
    ["ProcessSpawnError", "AgentProviderSpawnError"],
    ["ProcessExitError", "AgentProviderExitError"],
    ["ProcessOutputError", "AgentProviderIoError"],
    ["ProcessStdinError", "AgentProviderIoError"],
    ["ProcessCleanupError", "AgentProviderCleanupError"],
  ])("classifies %s without copying diagnostics", (causeTag, expectedCode) => {
    const result = toPublicWalkthroughError(
      AgentProviderOperationError.make({
        providerId: AgentProviderId.make("codex"),
        capability: "walkthrough",
        reason: "private provider reason",
        cause: { _tag: causeTag, stderr: "private stderr" },
      }),
      operation,
    )

    expect(result.code).toBe(expectedCode)
    expect(JSON.stringify(result)).not.toContain("private")
  })

  it("replaces unsafe open provider identifiers in public diagnostics", () => {
    const result = toPublicWalkthroughError(
      AgentProviderOperationError.make({
        providerId: AgentProviderId.make("/Users/example/secret-provider"),
        capability: "walkthrough",
        reason: "private provider reason",
      }),
      operation,
    )

    expect(result.message).toBe("Provider custom could not complete walkthrough generation.")
    expect(JSON.stringify(result)).not.toContain("secret-provider")
  })

  it("classifies review context, prompt preparation, and cache failures", () => {
    expect(
      toPublicWalkthroughError(
        ReviewContextError.make({
          operation: "local.snapshot",
          reason: "Unable to load review context",
          cause: new Error("private git stderr"),
        }),
        operation,
      ),
    ).toMatchObject({ code: "ReviewContextError", message: "Unable to load review context" })

    expect(
      toPublicWalkthroughError(
        WalkthroughPromptPreparationError.make({
          message: "Cannot generate a walkthrough because the diff has no reviewable changes.",
          details: ["private parsing details"],
        }),
        operation,
      ),
    ).toMatchObject({
      code: "WalkthroughPromptPreparationError",
      message: "Cannot generate a walkthrough because the diff has no reviewable changes.",
    })

    expect(
      toPublicWalkthroughError(
        WalkthroughStoreError.make({
          operation: "save.query",
          cause: new Error("private sqlite path"),
        }),
        operation,
      ),
    ).toMatchObject({
      code: "WalkthroughStoreError",
      message: "DiffDash could not save the generated walkthrough.",
    })
  })

  it("does not expose model output or parsing causes", () => {
    const result = toPublicWalkthroughError(
      WalkthroughGenerationError.make({
        operation: "parseModelJson",
        output: "private model response",
        cause: new Error("private parser cause"),
      }),
      operation,
    )

    expect(result).toMatchObject({
      code: "WalkthroughGenerationError",
      message: "The AI agent returned invalid walkthrough data after retrying.",
    })
    expect(JSON.stringify(result)).not.toContain("private")
  })

  it("keeps unexpected failures on the generic fallback", () => {
    expect(
      toPublicWalkthroughError(new Error("private unexpected failure"), operation),
    ).toMatchObject({
      code: "INTERNAL_ERROR",
      message: UNKNOWN_TRANSPORT_ERROR_MESSAGE,
      operation,
    })
  })
})
