import { AgentModelId, AgentProviderId } from "@diffdash/domain/agent-provider"
import {
  WalkthroughOperationId,
  WalkthroughOperationStateVersion,
} from "@diffdash/domain/walkthrough-operation"
import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"

import {
  WalkthroughApplicationInstanceId,
  WalkthroughBridgeOperationAccepted,
  WalkthroughBridgeSafeDiagnostic,
  WalkthroughBridgeStartRequest,
  WalkthroughProcessEpoch,
  WalkthroughRequestId,
  WalkthroughStartBridgeFailure,
  WalkthroughStartBridgeResult,
} from "./walkthrough-operation"

const identity = {
  applicationInstanceId: WalkthroughApplicationInstanceId.make("app-bridge"),
  processEpoch: WalkthroughProcessEpoch.make("epoch-bridge"),
  requestId: WalkthroughRequestId.make("h:bridge-request"),
} as const
const operationId = WalkthroughOperationId.make("walkthrough-operation-bridge")
const providerId = AgentProviderId.make("claude")
const modelId = AgentModelId.make("claude-opus-5")
const accepted = WalkthroughBridgeOperationAccepted.make({
  ...identity,
  operationId,
  stateVersion: WalkthroughOperationStateVersion.make(3),
  created: true,
})
const failure = Schema.decodeUnknownSync(WalkthroughStartBridgeFailure)({
  _tag: "WalkthroughPublicFailure",
  ...identity,
  method: "Walkthroughs.start",
  operationId,
  code: "AGENT_PROVIDER_EXIT",
  providerId,
  modelId,
  retryClass: "userAction",
  remediation: "reauthenticateProvider",
  safeMessage: "The configured provider exited before completing the walkthrough.",
  attempts: [
    {
      providerId,
      modelId,
      attempt: 1,
      stage: "execute",
      outcome: "provider-exit",
    },
  ],
  diagnostic: WalkthroughBridgeSafeDiagnostic.make({
    causeTags: ["AgentProviderOperationError", "ProcessExitError"],
    exitCode: 1,
    signal: null,
    providerExcerpt: "Authentication required. Run the provider and sign in.",
    internalFrames: ["WalkthroughService.generate", "executeWalkthroughCandidate"],
    truncated: false,
  }),
})

describe("walkthrough operation bridge", () => {
  it("requires a renderer-owned idempotency key on source-neutral starts", () => {
    const request = {
      target: { kind: "local", rootPath: "/workspace/repo", comparison: { _tag: "workingTree" } },
      regenerate: false,
      idempotencyKey: "w:renderer-retained",
    }

    expect(Schema.decodeUnknownSync(WalkthroughBridgeStartRequest)(request).idempotencyKey).toBe(
      "w:renderer-retained",
    )
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughBridgeStartRequest)({
          ...request,
          idempotencyKey: "generated elsewhere",
        }),
      ),
    ).toBe(true)
  })
  it("roundtrips accepted and classified failure values as plain envelopes", () => {
    const results = [
      { _tag: "Success", value: accepted },
      { _tag: "Failure", error: failure },
    ] as const

    for (const result of results) {
      const encoded = Schema.encodeSync(WalkthroughStartBridgeResult)(result)
      const cloned = structuredClone(encoded)
      expect(Schema.decodeUnknownSync(WalkthroughStartBridgeResult)(cloned)).toEqual(result)
      expect(cloned).not.toBeInstanceOf(Error)
    }
  })

  it("rejects unknown classifications and missing request or operation identity", () => {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughStartBridgeFailure)({
          ...failure,
          code: "UNKNOWN_RENDERER_ERROR",
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughStartBridgeFailure)({
          ...failure,
          requestId: undefined,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughStartBridgeFailure)({
          ...failure,
          operationId: null,
        }),
      ),
    ).toBe(true)
  })

  it("permits only identity-free pre-acceptance failures without an operation ID", () => {
    const preAcceptance = {
      ...failure,
      operationId: null,
      code: "CORE_DRAINING",
      providerId: null,
      modelId: null,
      attempts: [],
      diagnostic: null,
    } as const

    expect(Schema.decodeUnknownSync(WalkthroughStartBridgeFailure)(preAcceptance)).toEqual(
      preAcceptance,
    )
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughStartBridgeFailure)({
          ...preAcceptance,
          attempts: failure.attempts,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughStartBridgeFailure)({
          ...preAcceptance,
          operationId,
        }),
      ),
    ).toBe(true)
  })

  it("rejects unsafe diagnostics and strips arbitrary private fields when encoding", () => {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughBridgeSafeDiagnostic)({
          ...failure.diagnostic,
          providerExcerpt: "token=secret at /Users/example/private/repository",
        }),
      ),
    ).toBe(true)

    const decoded = Schema.decodeUnknownSync(WalkthroughStartBridgeFailure)({
      ...failure,
      rawStderr: "private stderr",
      cwd: "/Users/example/private/repository",
      argv: ["provider", "--secret"],
      stack: "private stack",
    })
    const encoded = Schema.encodeSync(WalkthroughStartBridgeFailure)(decoded)
    expect(encoded).not.toHaveProperty("rawStderr")
    expect(encoded).not.toHaveProperty("cwd")
    expect(encoded).not.toHaveProperty("argv")
    expect(encoded).not.toHaveProperty("stack")
  })

  it("rejects oversized attempts and diagnostics", () => {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughStartBridgeFailure)({
          ...failure,
          attempts: Array.from({ length: 33 }, () => failure.attempts[0]),
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughBridgeSafeDiagnostic)({
          ...failure.diagnostic,
          providerExcerpt: "x".repeat(2_049),
        }),
      ),
    ).toBe(true)
  })
})
