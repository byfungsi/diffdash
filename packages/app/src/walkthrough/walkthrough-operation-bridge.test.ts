import {
  WalkthroughOperationId,
  WalkthroughOperationStateVersion,
} from "@diffdash/domain/walkthrough-operation"
import {
  WalkthroughApplicationInstanceId,
  WalkthroughBridgeOperationAccepted,
  WalkthroughProcessEpoch,
  WalkthroughRequestId,
} from "@diffdash/protocol/walkthrough-operation"
import { describe, expect, it } from "@effect/vitest"

import { decodeWalkthroughStartBridgeResult } from "./walkthrough-operation-bridge"

const context = {
  applicationInstanceId: WalkthroughApplicationInstanceId.make("app-renderer"),
  processEpoch: WalkthroughProcessEpoch.make("epoch-renderer"),
  requestId: WalkthroughRequestId.make("h:renderer-request"),
  operationId: WalkthroughOperationId.make("operation-renderer"),
} as const

describe("walkthrough operation bridge decoder", () => {
  it("preserves a valid plain result after structured cloning", () => {
    const result = {
      _tag: "Success",
      value: WalkthroughBridgeOperationAccepted.make({
        ...context,
        operationId: context.operationId,
        stateVersion: WalkthroughOperationStateVersion.make(1),
        created: true,
      }),
    } as const

    expect(decodeWalkthroughStartBridgeResult(structuredClone(result), context)).toEqual(result)
  })

  it("classifies malformed values with known method and request identity", () => {
    const result = decodeWalkthroughStartBridgeResult(
      structuredClone({ _tag: "Failure", error: { code: "UNKNOWN_RENDERER_ERROR" } }),
      context,
    )

    expect(result).toEqual({
      _tag: "Failure",
      error: {
        _tag: "WalkthroughPublicFailure",
        ...context,
        method: "Walkthroughs.start",
        code: "WALKTHROUGH_TRANSPORT_ERROR",
        providerId: null,
        modelId: null,
        retryClass: "notRetryable",
        remediation: "retry",
        safeMessage: "DiffDash received an invalid walkthrough response.",
        attempts: [],
        diagnostic: null,
      },
    })
  })

  it("rejects validly shaped responses from a stale request context", () => {
    const matching = {
      _tag: "Success",
      value: WalkthroughBridgeOperationAccepted.make({
        ...context,
        operationId: context.operationId,
        stateVersion: WalkthroughOperationStateVersion.make(1),
        created: false,
      }),
    } as const
    const staleValues = [
      { ...matching.value, applicationInstanceId: "another-app" },
      { ...matching.value, processEpoch: "another-epoch" },
      { ...matching.value, requestId: "h:another-request" },
      { ...matching.value, operationId: "another-operation" },
    ]

    for (const value of staleValues) {
      expect(decodeWalkthroughStartBridgeResult({ _tag: "Success", value }, context)).toMatchObject(
        {
          _tag: "Failure",
          error: {
            method: "Walkthroughs.start",
            requestId: context.requestId,
            operationId: context.operationId,
            code: "WALKTHROUGH_TRANSPORT_ERROR",
          },
        },
      )
    }
  })

  it("retains pre-acceptance context when no operation identity exists yet", () => {
    const preAcceptanceContext = { ...context, operationId: null }
    const result = decodeWalkthroughStartBridgeResult(undefined, preAcceptanceContext)

    expect(result).toMatchObject({
      _tag: "Failure",
      error: {
        operationId: null,
        requestId: context.requestId,
      },
    })
  })
})
