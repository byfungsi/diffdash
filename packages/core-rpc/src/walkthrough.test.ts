import { AgentModelId, AgentProviderId } from "@diffdash/domain/agent-provider"
import {
  ReviewKey,
  ReviewProjectId,
  ReviewRevision,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import {
  WalkthroughChapterId,
  WalkthroughHunkId,
  WalkthroughStopId,
} from "@diffdash/domain/walkthrough"
import {
  WalkthroughOperationId,
  WalkthroughOperationPromptVersion,
  WalkthroughOperationStateVersion,
  WalkthroughOperationTimestamp,
} from "@diffdash/domain/walkthrough-operation"
import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"

import { ApplicationInstanceId, CoreProcessEpoch, HostRequestId } from "./identity"
import {
  CancelWalkthroughRequest,
  GetStoredWalkthroughRequest,
  GetStoredWalkthroughResult,
  GetWalkthroughOperationRequest,
  StartWalkthroughRequest,
  WalkthroughAttemptSummaries,
  WalkthroughAttemptSummary,
  WalkthroughCandidatePlanFingerprint,
  WalkthroughConfiguredRoute,
  WalkthroughFailureCode,
  WalkthroughFailureDetail,
  WalkthroughIdempotencyKey,
  WalkthroughOperationAccepted,
  WalkthroughOperationSnapshot,
  WalkthroughPublicArtifact,
  WalkthroughPublicFailure,
  WalkthroughReviewGeneration,
  WalkthroughSafeDiagnostic,
  WalkthroughStoredArtifact,
} from "./walkthrough"

const reviewGeneration = WalkthroughReviewGeneration.make({
  kind: "local",
  projectId: ReviewProjectId.make("project-1"),
  snapshotId: ReviewSnapshotId.make("snapshot:v1:0123456789abcdef0123456789abcdef"),
  reviewKey: ReviewKey.make("local:project-1:working-tree"),
  baseRevision: ReviewRevision.make("base-1"),
  headRevision: ReviewRevision.make("head-1"),
})
const target = Schema.decodeUnknownSync(StartWalkthroughRequest.fields.target)({
  kind: "local",
  rootPath: "/workspace/diffdash",
  comparison: { _tag: "workingTree" },
})
const requestIdentity = {
  applicationInstanceId: ApplicationInstanceId.make("app-1"),
  processEpoch: CoreProcessEpoch.make("epoch-1"),
  requestId: HostRequestId.make("h:walkthrough-1"),
} as const
const operationId = WalkthroughOperationId.make("walkthrough-operation-1")
const stateVersion = WalkthroughOperationStateVersion.make(1)
const promptVersion = WalkthroughOperationPromptVersion.make("walkthrough-v4")
const timestamp = WalkthroughOperationTimestamp.make("2026-08-14T12:00:00.000Z")
const idempotencyKey = WalkthroughIdempotencyKey.make("w:intent-1")
const candidatePlanFingerprint = WalkthroughCandidatePlanFingerprint.make(
  `walkthrough-plan:v1:${"a".repeat(64)}`,
)
const configuredRoute = Schema.decodeUnknownSync(WalkthroughConfiguredRoute)({
  mode: "auto",
  quality: "balanced",
})
const attempts = Schema.decodeUnknownSync(WalkthroughAttemptSummaries)([
  {
    stage: "execute",
    outcome: "provider-exit",
    providerId: "claude",
    modelId: "claude-opus-5",
    attempt: 1,
  },
])
const completedAttempts = Schema.decodeUnknownSync(WalkthroughAttemptSummaries)([
  {
    stage: "execute",
    outcome: "succeeded",
    providerId: "claude",
    modelId: "claude-opus-5",
    attempt: 1,
  },
])
const publicArtifact = WalkthroughPublicArtifact.make({
  title: "Review path",
  summary: "Inspect authentication before persistence.",
  chapters: [
    {
      id: WalkthroughChapterId.make("chapter-1"),
      title: "Authentication",
      summary: "Verify the request boundary.",
      stops: [
        {
          id: WalkthroughStopId.make("stop-1"),
          title: "Validate identity",
          summary: "Check the exact process epoch.",
          risk: "critical",
          hunkIds: [WalkthroughHunkId.make("hunk-1")],
        },
      ],
    },
  ],
  support: [],
  generation: {
    mode: "standard",
    totalFiles: 1,
    analyzedFiles: 1,
    totalFolders: 1,
    analyzedFolders: 1,
  },
})
const storedArtifact = WalkthroughStoredArtifact.make({
  reviewGeneration,
  promptVersion,
  walkthrough: publicArtifact,
  createdAt: timestamp,
})
const operationCommon = {
  acceptedRequest: requestIdentity,
  operationId,
  stateVersion,
  idempotencyKey,
  reviewGeneration,
  promptVersion,
  configuredRoute,
  candidatePlanFingerprint,
  attempts,
  acceptedAt: timestamp,
  updatedAt: timestamp,
} as const

describe("walkthrough RPC values", () => {
  it("decodes exact review, idempotency, plan, route, and attempt values", () => {
    const decodedIdempotencyKey = Schema.decodeUnknownSync(WalkthroughIdempotencyKey)("w:intent-1")
    const fingerprint = Schema.decodeUnknownSync(WalkthroughCandidatePlanFingerprint)(
      `walkthrough-plan:v1:${"a".repeat(64)}`,
    )
    const decodedConfiguredRoute = Schema.decodeUnknownSync(WalkthroughConfiguredRoute)({
      mode: "provider",
      providerId: AgentProviderId.make("claude"),
      modelId: AgentModelId.make("claude-opus-5"),
    })
    const attempt = Schema.decodeUnknownSync(WalkthroughAttemptSummary)({
      stage: "parse",
      outcome: "invalid-json",
      providerId: AgentProviderId.make("claude"),
      modelId: AgentModelId.make("claude-opus-5"),
      attempt: 2,
    })

    expect(reviewGeneration.snapshotId).toBe("snapshot:v1:0123456789abcdef0123456789abcdef")
    expect(decodedIdempotencyKey).toBe("w:intent-1")
    expect(fingerprint).toBe(`walkthrough-plan:v1:${"a".repeat(64)}`)
    expect(decodedConfiguredRoute).toEqual({
      mode: "provider",
      providerId: "claude",
      modelId: "claude-opus-5",
    })
    expect(attempt).toEqual({
      stage: "parse",
      outcome: "invalid-json",
      providerId: "claude",
      modelId: "claude-opus-5",
      attempt: 2,
    })
  })

  it("rejects malformed identities, impossible attempts, and oversized history", () => {
    expect(
      Result.isFailure(Schema.decodeUnknownResult(WalkthroughIdempotencyKey)("intent-1")),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughCandidatePlanFingerprint)("walkthrough-plan:v1:abc"),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughAttemptSummary)({
          stage: "probe",
          outcome: "invalid-json",
          providerId: "claude",
          modelId: null,
          attempt: 1,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughAttemptSummary)({
          stage: "execute",
          outcome: "provider-exit",
          providerId: "claude",
          modelId: null,
          attempt: 3,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughAttemptSummaries)(
          Array.from({ length: 33 }, () => ({
            stage: "probe",
            outcome: "ready",
            providerId: "claude",
            modelId: null,
            attempt: 1,
          })),
        ),
      ),
    ).toBe(true)
  })

  it("preserves every classified provider attempt and public failure category", () => {
    const outcomes = [
      ["probe", "probe-failed"],
      ["execute", "options-invalid"],
      ["execute", "authentication-failed"],
      ["execute", "authorization-failed"],
      ["execute", "rate-limited"],
      ["execute", "usage-limited"],
      ["execute", "quota-exhausted"],
      ["execute", "network-failed"],
      ["execute", "provider-unavailable"],
      ["execute", "configuration-failed"],
      ["execute", "invalid-response"],
      ["execute", "policy-unsupported"],
      ["execute", "provider-failed"],
      ["execute", "output-too-large"],
    ] as const
    for (const [stage, outcome] of outcomes) {
      expect(
        Result.isSuccess(
          Schema.decodeUnknownResult(WalkthroughAttemptSummary)({
            stage,
            outcome,
            providerId: "claude",
            modelId: "claude-opus-5",
            attempt: 1,
          }),
        ),
      ).toBe(true)
    }

    const codes = [
      "AGENT_PROVIDER_USAGE_LIMITED",
      "AGENT_PROVIDER_CONFIGURATION",
      "AGENT_PROVIDER_FAILURE",
      "WALKTHROUGH_REVIEW_RESOLUTION",
      "WALKTHROUGH_OPERATION_STATE_UNAVAILABLE",
    ] as const
    for (const code of codes) {
      expect(Schema.decodeUnknownSync(WalkthroughFailureCode)(code)).toBe(code)
      expect(code.startsWith("UNKNOWN_")).toBe(false)
    }
  })

  it("decodes state-specific operations and exact stored lookup results", () => {
    const completed = Schema.decodeUnknownSync(WalkthroughOperationSnapshot)({
      ...operationCommon,
      attempts: completedAttempts,
      state: "completed",
      stored: storedArtifact,
      terminalAt: timestamp,
    })
    const startRequest = StartWalkthroughRequest.make({
      ...requestIdentity,
      target,
      regenerate: false,
      idempotencyKey,
    })
    const accepted = WalkthroughOperationAccepted.make({
      ...requestIdentity,
      operationId,
      stateVersion,
      created: true,
    })
    const storedResult = Schema.decodeUnknownSync(GetStoredWalkthroughResult)({
      status: "found",
      stored: storedArtifact,
    })

    expect(completed.state).toBe("completed")
    expect(startRequest.idempotencyKey).toBe("w:intent-1")
    expect(accepted.operationId).toBe(operationId)
    expect(storedResult).toEqual({ status: "found", stored: storedArtifact })
  })

  it("rejects lifecycle variants without their required terminal data", () => {
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(WalkthroughOperationSnapshot)({
          ...operationCommon,
          state: "failed",
          failure: {
            code: "AGENT_PROVIDER_FAILURE",
            providerId: null,
            modelId: null,
            retryClass: "userAction",
            remediation: "retry",
            safeMessage: "DiffDash could not complete this walkthrough operation.",
            diagnostic: null,
          },
          terminalAt: timestamp,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughOperationSnapshot)({
          ...operationCommon,
          state: "completed",
          terminalAt: timestamp,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughOperationSnapshot)({
          ...operationCommon,
          state: "failed",
          failure: {
            code: "AGENT_PROVIDER_EXIT",
            providerId: "codex",
            modelId: "gpt-5",
            retryClass: "userAction",
            remediation: "reauthenticateProvider",
            safeMessage: "Codex exited before completing walkthrough generation.",
            diagnostic: null,
          },
          terminalAt: timestamp,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughOperationSnapshot)({
          ...operationCommon,
          state: "failed",
          terminalAt: timestamp,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughOperationSnapshot)({
          ...operationCommon,
          state: "superseded",
          terminalAt: timestamp,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughOperationSnapshot)({
          ...operationCommon,
          state: "completed",
          stored: {
            ...storedArtifact,
            promptVersion: "walkthrough-v5",
          },
          terminalAt: timestamp,
        }),
      ),
    ).toBe(true)
  })

  it("preserves bounded diagnostics while rejecting private diagnostic content", () => {
    const diagnostic = WalkthroughSafeDiagnostic.make({
      causeTags: ["AgentProviderOperationError", "ProcessExitError"],
      exitCode: 1,
      signal: null,
      providerExcerpt: "Authentication required.\nRun Claude and sign in.",
      internalFrames: ["WalkthroughService.generate", "executeWalkthroughCandidate"],
      truncated: false,
    })
    expect(Schema.decodeUnknownSync(WalkthroughSafeDiagnostic)(diagnostic)).toEqual(diagnostic)

    for (const providerExcerpt of [
      "password=hunter2",
      "Authorization: Bearer private-token",
      "/Users/example/private/repository",
      "/home/example/private/repository",
      "C:\\Users\\example\\private\\repository",
      "/tmp/.mount_DiffDash/private",
      "/private/var/folders/private/repository",
      "cwd=/Users/example/private/repository",
      '{"cwd":"/private/repository"}',
      "\u001b[31mprivate output\u001b[0m",
      "Error code: FORGED_FAILURE",
      "at runProvider (/private/provider.ts:10:2)",
      "credential ghp_privatevalue",
    ]) {
      expect(
        Result.isFailure(
          Schema.decodeUnknownResult(WalkthroughSafeDiagnostic)({
            ...diagnostic,
            providerExcerpt,
          }),
        ),
      ).toBe(true)
    }
  })

  it("rejects unknown failures and requires operation identity for operation methods", () => {
    const detail = WalkthroughFailureDetail.make({
      code: "AGENT_PROVIDER_EXIT",
      providerId: AgentProviderId.make("claude"),
      modelId: AgentModelId.make("claude-opus-5"),
      retryClass: "userAction",
      remediation: "reauthenticateProvider",
      safeMessage: "Provider Claude exited before completing walkthrough generation.",
      diagnostic: null,
    })
    const failure = Schema.decodeUnknownSync(WalkthroughPublicFailure)({
      _tag: "WalkthroughPublicFailure",
      ...requestIdentity,
      method: "Walkthroughs.start",
      operationId,
      attempts,
      ...detail,
    })
    expect(failure.code).toBe("AGENT_PROVIDER_EXIT")
    expect(failure).not.toBeInstanceOf(Error)
    expect(failure).not.toHaveProperty("cause")
    expect(failure).not.toHaveProperty("stack")
    expect(failure).not.toHaveProperty("path")

    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughPublicFailure)({
          ...failure,
          code: "UNKNOWN_RENDERER_ERROR",
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughPublicFailure)({
          ...failure,
          providerId: "codex",
          modelId: "gpt-5",
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughPublicFailure)({
          ...failure,
          operationId: null,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughFailureDetail)({
          ...detail,
          providerId: null,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughFailureDetail)({
          ...detail,
          code: "WALKTHROUGH_INVALID_JSON",
          providerId: null,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughFailureDetail)({
          ...detail,
          code: "CORE_DRAINING",
          providerId: null,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughPublicFailure)({
          ...failure,
          method: "Walkthroughs.cancel",
          operationId,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(WalkthroughPublicFailure)({
          ...failure,
          method: "Walkthroughs.start",
          operationId: null,
          code: "CORE_DRAINING",
          providerId: null,
          modelId: null,
          attempts: [],
        }),
      ),
    ).toBe(true)
  })

  it("rejects oversized stored walkthrough content", () => {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughPublicArtifact)({
          ...publicArtifact,
          title: "x".repeat(257),
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughPublicArtifact)({
          ...publicArtifact,
          support: [
            {
              id: "support-1",
              title: "Duplicate coverage",
              reason: "Already covered by the main path.",
              hunkIds: ["hunk-1"],
            },
          ],
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughPublicArtifact)({
          ...publicArtifact,
          chapters: Array.from({ length: 33 }, (_, index) => ({
            ...publicArtifact.chapters[0],
            id: `chapter-${index}`,
          })),
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughPublicArtifact)({
          ...publicArtifact,
          title: "é".repeat(200),
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WalkthroughPublicArtifact)({
          ...publicArtifact,
          support: Array.from({ length: 159 }, (_, index) => ({
            id: `support-${index}`,
            title: `Support ${index}`,
            reason: "x".repeat(2_048),
            hunkIds: [`support-hunk-${index}`],
          })),
        }),
      ),
    ).toBe(true)
  })

  it("roundtrips public walkthrough values through native MessagePack", () => {
    const startRequest = StartWalkthroughRequest.make({
      ...requestIdentity,
      target,
      regenerate: false,
      idempotencyKey,
    })
    const accepted = WalkthroughOperationAccepted.make({
      ...requestIdentity,
      operationId,
      stateVersion,
      created: true,
    })
    const getOperation = GetWalkthroughOperationRequest.make({
      ...requestIdentity,
      operationId,
    })
    const cancel = CancelWalkthroughRequest.make({ ...requestIdentity, operationId })
    const getStored = GetStoredWalkthroughRequest.make({
      ...requestIdentity,
      target,
      promptVersion,
    })
    const storedResult = Schema.decodeUnknownSync(GetStoredWalkthroughResult)({
      status: "found",
      stored: storedArtifact,
    })
    const completed = Schema.decodeUnknownSync(WalkthroughOperationSnapshot)({
      ...operationCommon,
      attempts: completedAttempts,
      state: "completed",
      stored: storedArtifact,
      terminalAt: timestamp,
    })
    const failure = Schema.decodeUnknownSync(WalkthroughPublicFailure)({
      _tag: "WalkthroughPublicFailure",
      ...requestIdentity,
      method: "Walkthroughs.start",
      operationId,
      code: "WALKTHROUGH_INVALID_JSON",
      providerId: "claude",
      modelId: "claude-opus-5",
      retryClass: "userAction",
      remediation: "regenerate",
      safeMessage: "The provider returned invalid walkthrough data.",
      attempts,
      diagnostic: null,
    })
    const parser = RpcSerialization.makeMsgPack({ maxBufferSize: 512 * 1_024 }).makeUnsafe()
    const encodedValues = [
      Schema.encodeSync(StartWalkthroughRequest)(startRequest),
      Schema.encodeSync(WalkthroughOperationAccepted)(accepted),
      Schema.encodeSync(GetWalkthroughOperationRequest)(getOperation),
      Schema.encodeSync(CancelWalkthroughRequest)(cancel),
      Schema.encodeSync(GetStoredWalkthroughRequest)(getStored),
      Schema.encodeSync(GetStoredWalkthroughResult)(storedResult),
      Schema.encodeSync(WalkthroughOperationSnapshot)(completed),
      Schema.encodeSync(WalkthroughPublicFailure)(failure),
    ]
    const decodedValues = encodedValues.flatMap((value) => {
      const bytes = parser.encode(value)
      if (!(bytes instanceof Uint8Array)) throw new Error("Expected native MessagePack bytes")
      return parser.decode(bytes)
    })

    expect(Schema.decodeUnknownSync(StartWalkthroughRequest)(decodedValues[0])).toEqual(
      startRequest,
    )
    expect(Schema.decodeUnknownSync(WalkthroughOperationAccepted)(decodedValues[1])).toEqual(
      accepted,
    )
    expect(Schema.decodeUnknownSync(GetWalkthroughOperationRequest)(decodedValues[2])).toEqual(
      getOperation,
    )
    expect(Schema.decodeUnknownSync(CancelWalkthroughRequest)(decodedValues[3])).toEqual(cancel)
    expect(Schema.decodeUnknownSync(GetStoredWalkthroughRequest)(decodedValues[4])).toEqual(
      getStored,
    )
    expect(Schema.decodeUnknownSync(GetStoredWalkthroughResult)(decodedValues[5])).toEqual(
      storedResult,
    )
    expect(Schema.decodeUnknownSync(WalkthroughOperationSnapshot)(decodedValues[6])).toEqual(
      completed,
    )
    const decodedFailure = Schema.decodeUnknownSync(WalkthroughPublicFailure)(decodedValues[7])
    expect(decodedFailure).toEqual(failure)
    expect(decodedFailure).not.toBeInstanceOf(Error)
    expect(decodedFailure).not.toHaveProperty("cause")
    expect(decodedFailure).not.toHaveProperty("stack")
    expect(decodedFailure).not.toHaveProperty("path")
  })
})
