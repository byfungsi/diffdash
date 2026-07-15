import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  AddReviewThreadUserMessageRequest,
  MarkdownBody,
  PullRequestReviewTarget,
  RunReviewThreadAgentRequest,
} from "../shared/review-thread"
import { loadAtomicWebhookReplayScenario } from "./atomic-webhook-replay"
import { createDemoRuntime } from "./demo-api"

describe("scenario-backed DiffDash API", () => {
  it.effect("serves the real renderer contract without external services", () =>
    Effect.gen(function* () {
      const scenario = yield* loadAtomicWebhookReplayScenario
      const { api, timeline } = createDemoRuntime(scenario)

      const repositories = yield* Effect.promise(() => api.repositories.list())
      const reviewRequests = yield* Effect.promise(() => api.gitProvider.listReviewRequests())
      const detail = yield* Effect.promise(() =>
        api.gitProvider.getPullRequestDetail("emberline", "dispatch", 417),
      )
      const diff = yield* Effect.promise(() =>
        api.gitProvider.getPullRequestDiff("emberline", "dispatch", 417),
      )

      expect(repositories.map((repository) => repository.id)).toEqual(["github:emberline/dispatch"])
      expect(reviewRequests[0]?.title).toBe("Make webhook replay claims atomic")
      expect(detail.headRefOid).toBe("c8a4f38d5f31dd16f39a6f42c4a8e44bed782e69")
      expect(diff.diff).toContain("WHERE replay_claim.claimed_until < excluded.claimed_at")
      expect(timeline.getState().revisionId).toBe("01-initial")
    }),
  )

  it.effect("holds an agent turn until capture automation releases it", () =>
    Effect.gen(function* () {
      const scenario = yield* loadAtomicWebhookReplayScenario
      const { api, timeline } = createDemoRuntime(scenario)
      const target = PullRequestReviewTarget.make({
        kind: "pullRequest",
        owner: "emberline",
        name: "dispatch",
        number: 417,
      })
      const summaries = yield* Effect.promise(() => api.reviewThreads.list(target))
      const threadId = summaries[0]?.id
      expect(threadId).toBeDefined()
      if (threadId === undefined) return

      const initial = yield* Effect.promise(() => api.reviewThreads.get(threadId))
      expect(initial.messages).toHaveLength(2)

      yield* Effect.promise(() =>
        api.reviewThreads.addUserMessage(
          AddReviewThreadUserMessageRequest.make({
            threadId,
            bodyMarkdown: MarkdownBody.make(
              "Can two regions disagree if their worker clocks drift?",
            ),
          }),
        ),
      )
      const progressStages: string[] = []
      const unsubscribe = api.reviewThreads.onAgentProgress((progress) => {
        progressStages.push(progress.stage)
      })
      const pending = api.reviewThreads.runAgent(
        RunReviewThreadAgentRequest.make({ threadId, target }),
      )
      const pendingDetails = yield* Effect.promise(() => api.reviewThreads.get(threadId))

      expect(pendingDetails.messages.at(-1)?.status).toBe("pending")
      expect(timeline.getState().pendingAgentTurnIds).toEqual(["turn-lease-follow-up"])

      yield* Effect.promise(() => timeline.release("turn-lease-follow-up"))
      const completed = yield* Effect.promise(() => pending)
      unsubscribe()

      expect(completed.messages.at(-1)?.status).toBe("complete")
      expect(completed.messages.at(-1)?.bodyMarkdown).toContain("transaction_timestamp()")
      expect(progressStages).toContain("reviewing")
      expect(progressStages.at(-1)).toBe("restoring-workspace")
      expect(timeline.getState().pendingAgentTurnIds).toEqual([])
    }),
  )

  it.effect(
    "advances revisions, viewed state, approvals, and update events deterministically",
    () =>
      Effect.gen(function* () {
        const scenario = yield* loadAtomicWebhookReplayScenario
        const { api, timeline } = createDemoRuntime(scenario)
        const updateTags: string[] = []
        const unsubscribe = api.updates.onStateChanged((state) => updateTags.push(state["_tag"]))

        expect(timeline.getState().viewedFileKeys).toHaveLength(1)
        yield* Effect.promise(() => timeline.release("revision-updated"))
        expect(timeline.getState().revisionId).toBe("02-database-clock")
        expect(timeline.getState().viewedFileKeys).toEqual([])

        yield* Effect.promise(() =>
          api.gitProvider.approvePullRequest("emberline", "dispatch", 417),
        )
        expect(timeline.getState().approved).toBe(true)

        yield* Effect.promise(() => timeline.release("update-available"))
        yield* Effect.promise(() => api.updates.download())
        yield* Effect.promise(() => timeline.release("update-downloaded"))
        unsubscribe()

        expect(updateTags).toEqual(["available", "downloading", "downloaded"])
        expect(timeline.getState().updateState).toBe("downloaded")
        expect(timeline.getActionLog().map((action) => action.type)).toContain(
          "gitProvider.approvePullRequest",
        )
      }),
  )
})
