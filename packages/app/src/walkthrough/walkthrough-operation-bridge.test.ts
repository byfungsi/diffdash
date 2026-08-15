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
import {
  WalkthroughBridgeOperationSnapshot,
  WalkthroughGetOperationBridgeResult,
} from "@diffdash/protocol/walkthrough-operation-state"
import { describe, expect, it } from "@effect/vitest"
import { Option, Schema } from "effect"

import {
  decodeWalkthroughGetOperationBridgeResult,
  decodeWalkthroughStartBridgeResult,
} from "./walkthrough-operation-bridge"

const context = {
  applicationInstanceId: WalkthroughApplicationInstanceId.make("app-renderer"),
  processEpoch: WalkthroughProcessEpoch.make("epoch-renderer"),
  requestId: WalkthroughRequestId.make("h:renderer-request"),
  operationId: WalkthroughOperationId.make("operation-renderer"),
} as const
const startContext = { ...context, operationId: Option.some(context.operationId) }
const activeOperation = Schema.decodeUnknownSync(WalkthroughBridgeOperationSnapshot)({
  acceptedRequest: {
    applicationInstanceId: "app-accepted",
    processEpoch: "epoch-accepted",
    requestId: "h:accepted-request",
  },
  operationId: context.operationId,
  stateVersion: 4,
  idempotencyKey: "w:renderer-operation",
  reviewGeneration: {
    kind: "local",
    projectId: "project-renderer",
    snapshotId: "snapshot:v1:00000000000000000000000000000000",
    reviewKey: "local:renderer",
    baseRevision: "base-renderer",
    headRevision: "head-renderer",
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

    expect(decodeWalkthroughStartBridgeResult(structuredClone(result), startContext)).toEqual(
      result,
    )
  })

  it("classifies malformed values with known method and request identity", () => {
    const result = decodeWalkthroughStartBridgeResult(
      structuredClone({ _tag: "Failure", error: { code: "UNKNOWN_RENDERER_ERROR" } }),
      startContext,
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
      expect(
        decodeWalkthroughStartBridgeResult({ _tag: "Success", value }, startContext),
      ).toMatchObject({
        _tag: "Failure",
        error: {
          method: "Walkthroughs.start",
          requestId: context.requestId,
          operationId: context.operationId,
          code: "WALKTHROUGH_TRANSPORT_ERROR",
        },
      })
    }
  })

  it("retains pre-acceptance context when no operation identity exists yet", () => {
    const preAcceptanceContext = { ...context, operationId: Option.none<WalkthroughOperationId>() }
    const result = decodeWalkthroughStartBridgeResult(undefined, preAcceptanceContext)

    expect(result).toMatchObject({
      _tag: "Failure",
      error: {
        operationId: null,
        requestId: context.requestId,
      },
    })
  })

  it("preserves a valid operation query across a Core epoch boundary", () => {
    const result = Schema.decodeUnknownSync(WalkthroughGetOperationBridgeResult)({
      _tag: "Success",
      value: { ...context, operation: activeOperation },
    })

    const cloned = Schema.decodeUnknownSync(Schema.Json)(
      structuredClone(Schema.encodeSync(WalkthroughGetOperationBridgeResult)(result)),
    )
    expect(decodeWalkthroughGetOperationBridgeResult(cloned, context)).toEqual(result)
    expect(activeOperation.acceptedRequest.applicationInstanceId).not.toBe(
      context.applicationInstanceId,
    )
    expect(activeOperation.acceptedRequest.processEpoch).not.toBe(context.processEpoch)
  })

  it("rejects malformed or stale operation-query responses with current identity", () => {
    const matching = {
      _tag: "Success",
      value: { ...context, operation: activeOperation },
    } as const
    const staleValues = [
      { ...matching.value, applicationInstanceId: "another-app" },
      { ...matching.value, processEpoch: "another-epoch" },
      { ...matching.value, requestId: "h:another-request" },
      { ...matching.value, operationId: "another-operation" },
    ]

    for (const value of [...staleValues, undefined]) {
      expect(
        decodeWalkthroughGetOperationBridgeResult(
          value === undefined
            ? undefined
            : Schema.decodeUnknownSync(Schema.Json)({ _tag: "Success", value }),
          context,
        ),
      ).toMatchObject({
        _tag: "Failure",
        error: {
          ...context,
          method: "Walkthroughs.getOperation",
          code: "WALKTHROUGH_TRANSPORT_ERROR",
        },
      })
    }
  })
})
