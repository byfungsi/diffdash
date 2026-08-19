import { AgentModelId, AgentProviderId } from "@diffdash/domain/agent-provider"
import { WalkthroughOperationId } from "@diffdash/domain/walkthrough-operation"
import { ApplicationInstanceId, CoreProcessEpoch, HostRequestId } from "@diffdash/core-rpc/identity"
import {
  WalkthroughGetOperationFailure,
  WalkthroughOperationSnapshot,
  WalkthroughStartFailure,
} from "@diffdash/core-rpc/walkthrough"
import { WalkthroughStartBridgeFailure } from "@diffdash/protocol/walkthrough-operation"
import {
  WalkthroughBridgeOperationSnapshot,
  WalkthroughGetOperationBridgeFailure,
  WalkthroughGetOperationBridgeResult,
} from "@diffdash/protocol/walkthrough-operation-state"
import { describe, expect, it } from "@effect/vitest"
import { Match, Schema } from "effect"

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

  it("preserves an authoritative Core operation under the current query identity", () => {
    const operation = Schema.decodeUnknownSync(WalkthroughOperationSnapshot)({
      acceptedRequest: {
        applicationInstanceId: "app-accepted",
        processEpoch: "epoch-accepted",
        requestId: "h:accepted-request",
      },
      operationId: "operation-context-bridge",
      stateVersion: 4,
      idempotencyKey: "w:context-bridge",
      reviewGeneration: {
        kind: "local",
        projectId: "project-context-bridge",
        snapshotId: "snapshot:v1:00000000000000000000000000000000",
        reviewKey: "local:context-bridge",
        baseRevision: "base-context-bridge",
        headRevision: "head-context-bridge",
      },
      promptVersion: "walkthrough-v4",
      configuredRoute: { mode: "auto", quality: "balanced" },
      candidatePlanFingerprint: `walkthrough-plan:v1:${"0".repeat(64)}`,
      attempts: [],
      acceptedAt: "2026-08-15T10:00:00.000Z",
      updatedAt: "2026-08-15T10:00:01.000Z",
      state: "active",
      phase: "running",
    })
    const encodedOperation = Schema.encodeSync(WalkthroughOperationSnapshot)(operation)
    const queryIdentity = {
      applicationInstanceId: "app-context-bridge",
      processEpoch: "epoch-current-query",
      requestId: "h:current-query",
      operationId: "operation-context-bridge",
    } as const
    const cloned = structuredClone({
      _tag: "Success",
      value: { ...queryIdentity, operation: encodedOperation },
    })
    const decoded = Schema.decodeUnknownSync(WalkthroughGetOperationBridgeResult)(cloned)

    expect(decoded).toMatchObject({
      _tag: "Success",
      value: {
        ...queryIdentity,
        operation: {
          state: "active",
          acceptedRequest: { processEpoch: "epoch-accepted" },
        },
      },
    })
    const roundtripOperation = Match.valueTags(decoded, {
      Success: (success) =>
        Schema.encodeSync(WalkthroughBridgeOperationSnapshot)(success.value.operation),
      Failure: () => null,
    })
    expect(roundtripOperation).toEqual(encodedOperation)
  })

  it("preserves get-operation expected failures without widening classifications", () => {
    const failure = Schema.decodeUnknownSync(WalkthroughGetOperationFailure)({
      _tag: "WalkthroughPublicFailure",
      applicationInstanceId: "app-context-bridge",
      processEpoch: "epoch-context-bridge",
      requestId: "h:get-operation-request",
      method: "Walkthroughs.getOperation",
      operationId: "operation-context-bridge",
      code: "WALKTHROUGH_OPERATION_NOT_FOUND",
      providerId: null,
      modelId: null,
      retryClass: "notRetryable",
      remediation: "none",
      safeMessage: "The walkthrough operation no longer exists.",
      attempts: [],
      diagnostic: null,
    })
    const encoded = Schema.encodeSync(WalkthroughGetOperationFailure)(failure)
    const decoded = Schema.decodeUnknownSync(WalkthroughGetOperationBridgeFailure)(
      structuredClone(encoded),
    )

    expect(Schema.encodeSync(WalkthroughGetOperationBridgeFailure)(decoded)).toEqual(encoded)
  })
})
