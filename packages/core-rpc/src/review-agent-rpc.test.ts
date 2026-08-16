import { AgentPromptVersion, CancelledAgentRun, RunningAgentRun } from "@diffdash/domain/agent-run"
import { AgentRunId } from "@diffdash/domain/agent-run-id"
import { workingTreeReviewTarget } from "@diffdash/domain/local-review"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { ReviewAgentProviderId } from "@diffdash/domain/review-agent-provider-id"
import { ReviewKey, ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import { ReviewThreadId } from "@diffdash/domain/review-thread"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Layer, Option, Result, Schema } from "effect"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcTest from "effect/unstable/rpc/RpcTest"

import {
  ReviewAgentCancelAdmissionMiddleware,
  ReviewAgentGetOperationAdmissionMiddleware,
  ReviewAgentStartAdmissionMiddleware,
} from "./admission"
import { ApplicationInstanceId, CoreProcessEpoch, HostRequestId } from "./identity"
import { getCoreRpcMethodPolicy } from "./method-policy"
import {
  ReviewAgentOperationAccepted,
  ReviewAgentOperationRequest,
  ReviewAgentStartFailure,
  StartReviewAgentOperationRequest,
} from "./review-agent"
import {
  ReviewAgentBusinessRpcs,
  ReviewAgentCancelRpc,
  ReviewAgentGetOperationRpc,
  ReviewAgentStartRpc,
} from "./review-agent-rpc"

const identity = {
  applicationInstanceId: ApplicationInstanceId.make("app-review-agent"),
  processEpoch: CoreProcessEpoch.make("epoch-review-agent"),
  requestId: HostRequestId.make("h:review-agent"),
} as const
const runId = AgentRunId.make("run-review-agent")
const running = RunningAgentRun.make({
  id: runId,
  threadId: ReviewThreadId.make("thread-review-agent"),
  reviewKey: ReviewKey.make("local:review-agent"),
  baseRevision: ReviewRevision.make("base-review-agent"),
  headRevision: ReviewRevision.make("head-review-agent"),
  provider: ReviewAgentProviderId.make("opencode"),
  model: "openai/gpt-5",
  promptVersion: AgentPromptVersion.make("review-thread-v3"),
  startedAt: "2026-08-16T00:00:00.000Z",
})
const cancelled = CancelledAgentRun.make({
  id: running.id,
  threadId: running.threadId,
  reviewKey: running.reviewKey,
  baseRevision: running.baseRevision,
  headRevision: running.headRevision,
  provider: running.provider,
  model: running.model,
  promptVersion: running.promptVersion,
  startedAt: running.startedAt,
  completedAt: "2026-08-16T00:00:01.000Z",
})
const startRequest = StartReviewAgentOperationRequest.make({
  ...identity,
  threadId: running.threadId,
  target: workingTreeReviewTarget(RepositoryCheckoutPath.make("/workspace/diffdash")),
  repoId: ReviewProjectId.make("project-review-agent"),
  reviewKey: running.reviewKey,
  expectedBaseRevision: running.baseRevision,
  expectedHeadRevision: running.headRevision,
})
const operationRequest = ReviewAgentOperationRequest.make({ ...identity, runId })
const accepted = ReviewAgentOperationAccepted.make({ ...identity, runId })
const passAdmissionLayer = Layer.mergeAll(
  Layer.succeed(ReviewAgentStartAdmissionMiddleware, (effect) => effect),
  Layer.succeed(ReviewAgentGetOperationAdmissionMiddleware, (effect) => effect),
  Layer.succeed(ReviewAgentCancelAdmissionMiddleware, (effect) => effect),
)

describe("review-agent RPC declarations", () => {
  it.effect("runs short start, state, and cancellation through native Effect RPC", () => {
    const handlers = ReviewAgentBusinessRpcs.toLayer({
      "ReviewThreads.runAgent": () => Effect.succeed(accepted),
      "ReviewAgents.getOperation": () => Effect.succeed(running),
      "ReviewAgents.cancel": () => Effect.succeed(cancelled),
    })

    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(ReviewAgentBusinessRpcs)
      expect(yield* client["ReviewThreads.runAgent"](startRequest)).toEqual(accepted)
      expect(yield* client["ReviewAgents.getOperation"](operationRequest)).toEqual(running)
      expect(yield* client["ReviewAgents.cancel"](operationRequest)).toEqual(cancelled)
    }).pipe(Effect.provide(handlers), Effect.provide(passAdmissionLayer))
  })

  it.effect("preserves method identity and AgentRunId in plain expected failures", () => {
    const failure = ReviewAgentStartFailure.make({
      _tag: "ReviewAgentOperationFailure",
      ...identity,
      method: "ReviewThreads.runAgent",
      runId,
      code: "REVIEW_AGENT_OPERATION_REJECTED",
      safeMessage: "This thread already has an active review-agent response.",
    })
    const handlers = ReviewAgentBusinessRpcs.toLayer({
      "ReviewThreads.runAgent": () => Effect.fail(failure),
      "ReviewAgents.getOperation": () => Effect.succeed(running),
      "ReviewAgents.cancel": () => Effect.succeed(cancelled),
    })

    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(ReviewAgentBusinessRpcs)
      const received = yield* client["ReviewThreads.runAgent"](startRequest).pipe(Effect.flip)
      expect(received).toEqual(failure)
      expect(received).not.toBeInstanceOf(Error)
      expect(received.runId).toBe(runId)
    }).pipe(Effect.provide(handlers), Effect.provide(passAdmissionLayer))
  })

  it("declares detached start and operation-resumable query/cancel policies", () => {
    expect(getCoreRpcMethodPolicy(ReviewAgentStartRpc)).toEqual(
      Option.some({
        deadlineMs: 5_000,
        maxRequestBytes: 16 * 1_024,
        maxResponseBytes: 2 * 1_024,
        cancellation: "detachedAfterAcceptance",
        requiredScope: "review",
        mutationClass: "uncertainMutation",
        idempotency: "nonIdempotent",
        restartBehavior: "failOnRestart",
        requiredHostCapabilities: [],
      }),
    )
    expect(getCoreRpcMethodPolicy(ReviewAgentGetOperationRpc)).toEqual(
      Option.some({
        deadlineMs: 2_000,
        maxRequestBytes: 2 * 1_024,
        maxResponseBytes: 64 * 1_024,
        cancellation: "interruptible",
        requiredScope: "operation",
        mutationClass: "read",
        idempotency: "idempotent",
        restartBehavior: "resumeByOperationId",
        requiredHostCapabilities: [],
      }),
    )
    expect(getCoreRpcMethodPolicy(ReviewAgentCancelRpc)).toEqual(
      Option.some({
        deadlineMs: 5_000,
        maxRequestBytes: 2 * 1_024,
        maxResponseBytes: 64 * 1_024,
        cancellation: "uninterruptible",
        requiredScope: "operation",
        mutationClass: "idempotentMutation",
        idempotency: "idempotent",
        restartBehavior: "resumeByOperationId",
        requiredHostCapabilities: [],
      }),
    )
  })

  it("rejects a cancellation failure at the start method boundary", () => {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(ReviewAgentStartRpc.errorSchema)({
          _tag: "ReviewAgentOperationFailure",
          ...identity,
          method: "ReviewAgents.cancel",
          runId,
          code: "REVIEW_AGENT_OPERATION_STORE",
          safeMessage: "Cancellation could not be persisted.",
        }),
      ),
    ).toBe(true)
  })

  it("roundtrips cancelled operation state through native MessagePack", () => {
    const codec = Schema.toCodecJson(Rpc.exitSchema(ReviewAgentCancelRpc))
    const encoded = Schema.encodeSync(codec)(Exit.succeed(cancelled))
    const parser = RpcSerialization.makeMsgPack({ maxBufferSize: 128 * 1_024 }).makeUnsafe()
    const bytes = parser.encode(encoded)
    if (!(bytes instanceof Uint8Array)) throw new Error("Expected native MessagePack bytes")
    const [decoded] = parser.decode(bytes)

    expect(Schema.decodeUnknownSync(codec)(decoded)).toEqual(Exit.succeed(cancelled))
  })
})
