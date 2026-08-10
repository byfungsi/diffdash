import {
  AgentCapabilityUnavailableError,
  AgentPolicyEnforcementError,
  AgentProviderFailure,
  type AgentProviderFailureCategory,
  AgentProviderId,
  AgentProviderOperationError,
  type AgentProviderProcessFailureKind,
} from "@diffdash/agent-provider"
import { NoAgentProviderAvailableError } from "@diffdash/agent-provider/registry"
import { WalkthroughPromptPreparationError } from "@diffdash/domain/walkthrough"
import { WalkthroughStoreError } from "@diffdash/persistence/walkthrough-store"
import { ProcessExitError } from "@diffdash/process"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { UNKNOWN_TRANSPORT_ERROR_MESSAGE } from "@diffdash/protocol/transport-error"
import {
  WalkthroughGenerationError,
  WalkthroughModelUnavailableError,
} from "@diffdash/agents/walkthrough"
import { describe, expect, it } from "vitest"
import {
  ReviewContextError,
  WalkthroughOperationInterrupted,
  WalkthroughOperationTerminalFailure,
} from "@diffdash/core"
import {
  WalkthroughExpectedFailure,
  WalkthroughOperationId,
} from "@diffdash/domain/walkthrough-operation"
import { toPublicWalkthroughError } from "./walkthrough-public-error"

const operation = InvokeChannel.generateLocalWalkthrough
const failure = (
  providerId: string,
  category: AgentProviderFailureCategory,
  processKind: AgentProviderProcessFailureKind | null = null,
) =>
  AgentProviderFailure.make({
    version: 1,
    providerId: AgentProviderId.make(providerId),
    capability: "walkthrough",
    category,
    processKind,
    exitCode: null,
    signal: null,
    httpStatus: null,
    retryAfterSeconds: null,
    resetsAt: null,
  })

describe("toPublicWalkthroughError", () => {
  it("classifies a provider process exit with a bounded privacy-safe diagnostic trace", () => {
    const cause = ProcessExitError.make({
      command: "claude",
      args: ["--print", "private prompt"],
      cwd: "/Users/example/secret-repository",
      exitCode: 9,
      signal: null,
      stdout: "private model output",
      stderr: `Authentication failed in /Users/example/secret-repository
Authorization: Bearer provider-secret
password=hunter2
AWS_SECRET_ACCESS_KEY=cloud-secret
prompt: private prompt body
diff --git a/private.ts b/private.ts
Unlabelled private prompt sentence
 unchanged private diff context
/Users/example/secret repository/private file.ts
Unhandled provider call: --print --model private-model`,
      stdoutTruncated: false,
      stderrTruncated: false,
      outputTruncated: false,
      message: "Command exited with code 9",
    })
    const error = AgentProviderOperationError.make({
      providerId: AgentProviderId.make("claude"),
      capability: "walkthrough",
      failure: failure("claude", "authentication", "exit"),
      reason: "Authentication failed in /Users/example/secret-repository token=provider-secret",
      cause,
    })

    const result = toPublicWalkthroughError(error, operation)

    expect(result).toMatchObject({
      code: "AgentProviderAuthenticationError",
      message: "Provider claude authentication failed or expired. Sign in again, then retry.",
      operation,
      diagnostic: {
        provider: "claude",
        errorTag: "AgentProviderOperationError",
        causeTag: "ProcessExitError",
        exitCode: 9,
        signal: null,
      },
    })
    expect(result.diagnostic?.reason).toBe("Authentication or authorization failure reported.")
    expect(result.diagnostic?.stderr).toBe("Authentication or authorization failure reported.")
    expect(result.diagnostic?.stackFrames.every((frame) => /^at [\w$.<>-]+$/u.test(frame))).toBe(
      true,
    )
    const serialized = JSON.stringify(result)
    for (const privateValue of [
      "secret-repository",
      "provider-secret",
      "private prompt body",
      "private.ts",
      "private model output",
      "private-model",
      "hunter2",
      "cloud-secret",
      "Unlabelled private prompt sentence",
      "unchanged private diff context",
      "private file.ts",
      "--print",
      '"command":"claude"',
      '"args"',
      '"cwd"',
      '"stdout"',
    ]) {
      expect(serialized).not.toContain(privateValue)
    }
  })

  it("structurally classifies process causes without relying on class identity", () => {
    const result = toPublicWalkthroughError(
      {
        _tag: "AgentProviderOperationError",
        providerId: "codex",
        capability: "walkthrough",
        failure: failure("codex", "process-failure", "exit"),
        reason: "Provider failed",
        cause: {
          _tag: "ProcessExitError",
          command: "codex",
          args: [],
          cwd: null,
          exitCode: null,
          signal: "SIGTERM",
          stdout: "",
          stderr: "Process interrupted",
          stdoutTruncated: false,
          stderrTruncated: false,
          outputTruncated: false,
          message: "Command terminated by SIGTERM",
        },
      },
      operation,
    )

    expect(result).toMatchObject({
      code: "AgentProviderExitError",
      diagnostic: { causeTag: "ProcessExitError", signal: "SIGTERM" },
    })
  })

  it("identifies a provider timeout without exposing process diagnostics", () => {
    const result = toPublicWalkthroughError(
      AgentProviderOperationError.make({
        providerId: AgentProviderId.make("codex"),
        capability: "walkthrough",
        failure: failure("codex", "timeout", "timeout"),
        reason: "Command timed out in /Users/example/secret-repository",
        cause: { _tag: "ProcessTimeoutError", stderr: "private stderr" },
      }),
      operation,
    )

    expect(result).toMatchObject({
      code: "AgentProviderTimeoutError",
      message: "Provider codex timed out while producing the walkthrough generation.",
    })
    expect(JSON.stringify(result)).not.toContain("private")
  })

  it.each([
    [
      AgentCapabilityUnavailableError.make({
        providerId: AgentProviderId.make("claude"),
        capability: "walkthrough",
        reason: "OAuth session expired",
      }),
      "claude",
      "authentication",
    ],
    [
      AgentPolicyEnforcementError.make({
        providerId: AgentProviderId.make("codex"),
        capability: "walkthrough",
        reason: "Read-only policy is unavailable",
      }),
      "codex",
      "policy-violation",
    ],
    [
      NoAgentProviderAvailableError.make({ capability: "walkthrough" }),
      "unavailable",
      "configuration",
    ],
    [
      WalkthroughModelUnavailableError.make({
        providerId: AgentProviderId.make("opencode"),
        modelId: "missing-model",
      }),
      "opencode",
      "model-unavailable",
    ],
  ])("attaches typed provider metadata to walkthrough preflight failures", (error, providerId, category) => {
    expect(toPublicWalkthroughError(error, operation).providerFailure).toMatchObject({
      providerId,
      capability: "walkthrough",
      category,
    })
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
        failure: failure("codex", "process-failure"),
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
        failure: failure("custom", "unknown"),
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

  it("classifies privacy-safe persisted failures without exposing private diagnostics", () => {
    expect(
      toPublicWalkthroughError(
        WalkthroughOperationTerminalFailure.make({
          operationId: WalkthroughOperationId.make("persisted-operation"),
          failure: WalkthroughExpectedFailure.make({
            kind: "expected",
            category: "provider",
            code: "agent-provider-operation-error",
          }),
        }),
        operation,
      ),
    ).toMatchObject({
      code: "WALKTHROUGH_PROVIDER_ERROR",
      message: "The configured AI provider could not complete walkthrough generation.",
      operation,
    })

    expect(
      toPublicWalkthroughError(WalkthroughOperationInterrupted.make({}), operation),
    ).toMatchObject({
      code: "WALKTHROUGH_INTERRUPTED",
      operation,
    })
  })

  it("classifies unexpected failures with only sanitized internal frames", () => {
    const result = toPublicWalkthroughError(
      new Error("private unexpected failure at /Users/example/private-repository"),
      operation,
    )

    expect(result).toMatchObject({
      code: "WALKTHROUGH_INTERNAL_ERROR",
      message: UNKNOWN_TRANSPORT_ERROR_MESSAGE,
      operation,
      diagnostic: {
        provider: "unavailable",
        errorTag: "WalkthroughInternalError",
        causeTag: "Error",
        reason: "Unexpected walkthrough failure.",
        stderr: "No provider diagnostics were emitted.",
      },
    })
    expect(JSON.stringify(result)).not.toContain("private unexpected failure")
    expect(JSON.stringify(result)).not.toContain("private-repository")
  })
})
