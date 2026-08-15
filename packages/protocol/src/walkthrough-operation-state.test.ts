import { describe, expect, it } from "@effect/vitest"
import { Match, Result, Schema } from "effect"

import {
  WalkthroughBridgeOperationSnapshot,
  WalkthroughGetOperationBridgeFailure,
  WalkthroughGetOperationBridgeResult,
} from "./walkthrough-operation-state"

const identity = {
  applicationInstanceId: "app-operation-query",
  processEpoch: "epoch-operation-query",
  requestId: "h:operation-query",
} as const
const operationId = "operation-query"
const activeOperation = Schema.decodeUnknownSync(WalkthroughBridgeOperationSnapshot)({
  acceptedRequest: {
    applicationInstanceId: "app-operation-accepted",
    processEpoch: "epoch-accepted",
    requestId: "h:accepted-request",
  },
  operationId,
  stateVersion: 4,
  idempotencyKey: "w:operation-query",
  reviewGeneration: {
    kind: "local",
    projectId: "project-query",
    snapshotId: "snapshot:v1:00000000000000000000000000000000",
    reviewKey: "local:query",
    baseRevision: "base-query",
    headRevision: "head-query",
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

describe("walkthrough operation-state bridge", () => {
  it("roundtrips an authoritative snapshot with separate current query identity", () => {
    const result = Schema.decodeUnknownSync(WalkthroughGetOperationBridgeResult)({
      _tag: "Success",
      value: { ...identity, operationId, operation: activeOperation },
    })

    const encoded = Schema.encodeSync(WalkthroughGetOperationBridgeResult)(result)
    const cloned = structuredClone(encoded)

    expect(Schema.decodeUnknownSync(WalkthroughGetOperationBridgeResult)(cloned)).toEqual(result)
    const contexts = Match.valueTags(result, {
      Success: (success) => [
        [success.value.applicationInstanceId, success.value.processEpoch],
        [
          success.value.operation.acceptedRequest.applicationInstanceId,
          success.value.operation.acceptedRequest.processEpoch,
        ],
      ],
      Failure: () => [null, null],
    })
    expect(contexts[0]).not.toEqual(contexts[1])
  })

  it("rejects mismatched wrapper and snapshot operation identities", () => {
    const result = Schema.decodeUnknownResult(WalkthroughGetOperationBridgeResult)({
      _tag: "Success",
      value: { ...identity, operationId: "another-operation", operation: activeOperation },
    })

    expect(Result.isFailure(result)).toBe(true)
  })

  it("rejects failed snapshots whose provider is absent from attempt history", () => {
    const result = Schema.decodeUnknownResult(WalkthroughBridgeOperationSnapshot)({
      ...activeOperation,
      state: "failed",
      phase: undefined,
      attempts: [],
      failure: {
        code: "AGENT_PROVIDER_EXIT",
        providerId: "claude",
        modelId: "claude-opus-5",
        retryClass: "userAction",
        remediation: "reauthenticateProvider",
        safeMessage: "The provider exited before completing the walkthrough.",
        diagnostic: null,
      },
      terminalAt: "2026-08-15T10:00:02.000Z",
    })

    expect(Result.isFailure(result)).toBe(true)
  })

  it("preserves every terminal state with only its state-specific data", () => {
    const terminalAt = "2026-08-15T10:00:02.000Z"
    const terminalOperations = [
      {
        ...activeOperation,
        state: "completed",
        terminalAt,
        stored: {
          reviewGeneration: activeOperation.reviewGeneration,
          promptVersion: activeOperation.promptVersion,
          createdAt: terminalAt,
          walkthrough: {
            title: "Review path",
            summary: "Review the changed behavior.",
            chapters: [
              {
                id: "chapter-1",
                title: "Core behavior",
                summary: "Trace the operation state.",
                stops: [
                  {
                    id: "stop-1",
                    title: "Operation query",
                    summary: "Verify the durable operation snapshot.",
                    risk: "review",
                    hunkIds: ["hunk-1"],
                  },
                ],
              },
            ],
            support: [],
          },
        },
      },
      {
        ...activeOperation,
        state: "failed",
        terminalAt,
        failure: {
          code: "WALKTHROUGH_INTERNAL_ERROR",
          providerId: null,
          modelId: null,
          retryClass: "notRetryable",
          remediation: "contactSupport",
          safeMessage: "DiffDash could not complete the walkthrough.",
          diagnostic: null,
        },
      },
      { ...activeOperation, state: "cancelled", terminalAt },
      {
        ...activeOperation,
        state: "superseded",
        supersededByOperationId: "replacement-operation",
        terminalAt,
      },
      { ...activeOperation, state: "interrupted", terminalAt },
    ]

    expect(
      terminalOperations.map(
        (operation) =>
          Schema.decodeUnknownSync(WalkthroughBridgeOperationSnapshot)(operation).state,
      ),
    ).toEqual(["completed", "failed", "cancelled", "superseded", "interrupted"])
  })

  it("keeps admission failures identity-complete and detail-free", () => {
    const failure = {
      _tag: "WalkthroughPublicFailure",
      ...identity,
      method: "Walkthroughs.getOperation",
      operationId,
      code: "CORE_RESTARTED",
      providerId: null,
      modelId: null,
      retryClass: "automatic",
      remediation: "retry",
      safeMessage: "DiffDash Core restarted before reading the walkthrough operation.",
      attempts: [],
      diagnostic: null,
    } as const

    expect(Schema.decodeUnknownSync(WalkthroughGetOperationBridgeFailure)(failure)).toEqual(failure)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughGetOperationBridgeFailure)({
          ...failure,
          attempts: [
            {
              providerId: "claude",
              modelId: null,
              attempt: 1,
              stage: "execute",
              outcome: "provider-exit",
            },
          ],
        }),
      ),
    ).toBe(true)
  })
})
