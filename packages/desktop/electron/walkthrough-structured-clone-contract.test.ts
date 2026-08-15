import { AgentModelId, AgentProviderId } from "@diffdash/domain/agent-provider"
import { WalkthroughOperationId } from "@diffdash/domain/walkthrough-operation"
import { ApplicationInstanceId, CoreProcessEpoch, HostRequestId } from "@diffdash/core-rpc/identity"
import { WalkthroughStartFailure } from "@diffdash/core-rpc/walkthrough"
import { WalkthroughStartBridgeFailure } from "@diffdash/protocol/walkthrough-operation"
import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

describe("walkthrough structured-clone contract", () => {
  it("preserves the complete classified Core failure as plain cloned data", () => {
    const failure = Schema.decodeUnknownSync(WalkthroughStartFailure)({
      _tag: "WalkthroughPublicFailure",
      applicationInstanceId: ApplicationInstanceId.make("app-context-bridge"),
      processEpoch: CoreProcessEpoch.make("epoch-context-bridge"),
      requestId: HostRequestId.make("h:context-bridge-request"),
      method: "Walkthroughs.start",
      operationId: WalkthroughOperationId.make("operation-context-bridge"),
      code: "AGENT_PROVIDER_EXIT",
      providerId: AgentProviderId.make("claude"),
      modelId: AgentModelId.make("claude-opus-5"),
      retryClass: "userAction",
      remediation: "reauthenticateProvider",
      safeMessage: "The configured provider exited before completing the walkthrough.",
      attempts: [
        {
          providerId: AgentProviderId.make("claude"),
          modelId: AgentModelId.make("claude-opus-5"),
          attempt: 1,
          stage: "execute",
          outcome: "provider-exit",
        },
      ],
      diagnostic: {
        causeTags: ["AgentProviderOperationError", "ProcessExitError"],
        exitCode: 1,
        signal: null,
        providerExcerpt: "Authentication required. Run the provider and sign in.",
        internalFrames: ["WalkthroughService.generate", "executeWalkthroughCandidate"],
        truncated: false,
      },
    })
    const encoded = Schema.encodeSync(WalkthroughStartFailure)(failure)
    const cloned = structuredClone(encoded)
    const decoded = Schema.decodeUnknownSync(WalkthroughStartBridgeFailure)(cloned)

    expect(decoded).toMatchObject({
      _tag: "WalkthroughPublicFailure",
      applicationInstanceId: "app-context-bridge",
      processEpoch: "epoch-context-bridge",
      requestId: "h:context-bridge-request",
      method: "Walkthroughs.start",
      operationId: "operation-context-bridge",
      code: "AGENT_PROVIDER_EXIT",
      providerId: "claude",
      modelId: "claude-opus-5",
      retryClass: "userAction",
      remediation: "reauthenticateProvider",
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
        exitCode: 1,
        providerExcerpt: "Authentication required. Run the provider and sign in.",
      },
    })
    expect(cloned).not.toBeInstanceOf(Error)
    expect(cloned).not.toHaveProperty("stack")
    expect(cloned).not.toHaveProperty("cause")
    expect(Schema.encodeSync(WalkthroughStartBridgeFailure)(decoded)).toEqual(encoded)
  })
})
