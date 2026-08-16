import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { HostedReviewTarget, MarkdownBody } from "@diffdash/domain/review-thread"
import { ProjectWorkspaceStateInput } from "@diffdash/domain/project-workspace"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import {
  AddReviewThreadUserMessageRequest,
  RunReviewThreadAgentRequest,
} from "@diffdash/protocol/review-threads"
import { loadAtomicWebhookReplayScenario } from "./atomic-webhook-replay"
import { createDemoRuntime } from "./demo-api"
import {
  HostedProviderRequest,
  HostedReviewRequest,
  SubmitHostedReviewDecisionRequest,
} from "@diffdash/protocol/hosted-git"
import {
  GitProviderId,
  HostedRepositoryLocator,
  HostedRepositoryName,
  HostedReviewLocator,
  HostedReviewNumber,
  RepositoryNamespace,
} from "@diffdash/domain/git-provider"
import { LocalViewedFilesRequest } from "@diffdash/protocol/viewed-files"
import { buildWalkthroughHunkDigest, walkthroughLocalDiffScope } from "@diffdash/domain/walkthrough"
import { createDemoLocalReviewFixtures } from "./local-review-fixtures"

const review = HostedReviewLocator.make({
  repository: HostedRepositoryLocator.make({
    providerId: GitProviderId.make("github"),
    namespace: RepositoryNamespace.make("emberline"),
    name: HostedRepositoryName.make("dispatch"),
  }),
  number: HostedReviewNumber.make(417),
})

describe("scenario-backed DiffDash API", () => {
  it.effect("opens, remembers workspace state, and forgets projects deterministically", () =>
    Effect.gen(function* () {
      const scenario = yield* loadAtomicWebhookReplayScenario
      const { api } = createDemoRuntime(scenario)
      const projectId = ReviewProjectId.make(scenario.repository.id)

      const opened = yield* Effect.promise(() =>
        api.repositories.openProject(RepositoryCheckoutPath.make("/Users/demo/emberline-dispatch")),
      )
      expect(opened["_tag"]).toBe("opened")
      if (opened["_tag"] !== "opened") return
      expect(opened.repo.localPath).toEqual(
        RepositoryCheckoutPath.make("/Users/demo/emberline-dispatch"),
      )

      const saved = yield* Effect.promise(() =>
        api.projectWorkspace.save(
          ProjectWorkspaceStateInput.make({
            projectId,
            activeRibbon: "files",
            selectedReviewTarget: null,
          }),
        ),
      )
      expect(yield* Effect.promise(() => api.projectWorkspace.get(projectId))).toEqual(saved)

      const forgotten = yield* Effect.promise(() => api.repositories.forget(projectId))
      expect(forgotten.isFavorite).toBe(false)
      expect(forgotten.lastOpenedAt).toBeNull()
    }),
  )

  it.effect("serves the real renderer contract without external services", () =>
    Effect.gen(function* () {
      const scenario = yield* loadAtomicWebhookReplayScenario
      const { api, timeline } = createDemoRuntime(scenario)

      const repositories = yield* Effect.promise(() => api.repositories.list())
      const reviewRequests = yield* Effect.promise(() =>
        api.hostedReviews.listAssigned(
          HostedProviderRequest.make({ providerId: GitProviderId.make("github") }),
        ),
      )
      const manifest = yield* Effect.promise(() =>
        api.reviewSnapshots.acquireHosted(HostedReviewRequest.make({ review })),
      )
      const session = yield* Effect.promise(() =>
        api.progressiveReviews.openSession({
          projectId: manifest.projectId,
          reviewKey: manifest.reviewKey,
          snapshotId: manifest.snapshotId,
        }),
      )
      if (session._tag !== "ready") return
      const page = yield* Effect.promise(() =>
        api.progressiveReviews.inventory({ identity: session.identity, offset: 0, limit: 8 }),
      )
      const range = yield* Effect.promise(() =>
        api.progressiveReviews.readRange({
          identity: session.identity,
          fileId: page.files[0]?.fileId ?? manifest.files[0]!.fileId,
          startLine: 0,
        }),
      )

      expect(repositories.map((repository) => repository.id)).toEqual(["github:emberline/dispatch"])
      expect(reviewRequests[0]?.title).toBe("Make webhook replay claims atomic")
      expect(manifest.detail.summary.head.revision).toBe("c8a4f38d5f31dd16f39a6f42c4a8e44bed782e69")
      expect(page.files).toHaveLength(8)
      expect(page.nextOffset).not.toBeNull()
      expect(new TextDecoder().decode(range.blocks[0]?.bytes)).toContain("diff --git")
      expect(timeline.getState().revisionId).toBe("01-initial")
    }),
  )

  it.effect("holds an agent turn until capture automation releases it", () =>
    Effect.gen(function* () {
      const scenario = yield* loadAtomicWebhookReplayScenario
      const { api, timeline } = createDemoRuntime(scenario)
      const target = HostedReviewTarget.make({ kind: "hosted", review })
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
        RunReviewThreadAgentRequest.make({
          threadId,
          target,
          repoId: ReviewProjectId.make(initial.thread.repoId),
          reviewKey: initial.thread.reviewKey,
          expectedBaseRevision: initial.thread.currentBaseRevision,
          expectedHeadRevision: initial.thread.currentHeadRevision,
        }),
      )
      const pendingDetails = yield* Effect.promise(() => api.reviewThreads.get(threadId))

      expect(pendingDetails.messages.at(-1)?._tag).toBe("Pending")
      expect(timeline.getState().pendingAgentTurnIds).toEqual(["turn-lease-follow-up"])

      yield* Effect.promise(() => timeline.release("turn-lease-follow-up"))
      const completed = yield* Effect.promise(() => pending)
      unsubscribe()

      const completedMessage = completed.messages.at(-1)
      expect(completedMessage?._tag).toBe("Completed")
      if (completedMessage?._tag !== "Completed") throw new Error("Expected completed response")
      expect(completedMessage.bodyMarkdown).toContain("transaction_timestamp()")
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
          api.hostedReviews.submitDecision(
            SubmitHostedReviewDecisionRequest.make({ review, decision: "approved" }),
          ),
        )
        expect(timeline.getState().approved).toBe(true)

        yield* Effect.promise(() => timeline.release("update-available"))
        yield* Effect.promise(() => api.updates.download())
        yield* Effect.promise(() => timeline.release("update-downloaded"))
        unsubscribe()

        expect(updateTags).toEqual(["available", "downloading", "downloaded"])
        expect(timeline.getState().updateState).toBe("downloaded")
        expect(timeline.getActionLog().map((action) => action.type)).toContain(
          "gitProvider.submitReviewDecision",
        )
      }),
  )

  it.effect("keeps working-tree and merge-base branch reviews isolated", () =>
    Effect.gen(function* () {
      const scenario = yield* loadAtomicWebhookReplayScenario
      const [working, branch] = createDemoLocalReviewFixtures(scenario)
      const { api } = createDemoRuntime(scenario)
      const resolvedBranch = yield* Effect.promise(() =>
        api.localReviews.resolveBranch(
          working.target.rootPath,
          RepositoryComparisonRef.make("dev"),
        ),
      )
      const [workingManifest, branchManifest] = yield* Effect.promise(() =>
        Promise.all([
          api.reviewSnapshots.acquireLocal(working.target),
          api.reviewSnapshots.acquireLocal(resolvedBranch),
        ]),
      )
      const [workingThreads, branchThreads] = yield* Effect.promise(() =>
        Promise.all([
          api.reviewThreads.list(working.target),
          api.reviewThreads.list(resolvedBranch),
        ]),
      )
      const [workingViewed, branchViewed] = yield* Effect.promise(() =>
        Promise.all([
          api.viewedFiles.listLocal(
            LocalViewedFilesRequest.make({
              target: working.target,
              sourceBranch: RepositoryComparisonRef.make("nina/webhook-replay-claims"),
            }),
          ),
          api.viewedFiles.listLocal(
            LocalViewedFilesRequest.make({
              target: resolvedBranch,
              sourceBranch: RepositoryComparisonRef.make("nina/webhook-replay-claims"),
            }),
          ),
        ]),
      )

      expect(branch.target.comparison["_tag"]).toBe("branch")
      if (branch.target.comparison["_tag"] === "branch") {
        expect(branch.target.comparison.baseSha).toBe(branch.snapshot.baseRevision)
        expect(branch.target.comparison.baseSha).not.toBe(branch.comparisonTargetSha)
      }
      expect(branch.excludedTargetOnlyPaths).toEqual(["docs/dev-release-notes.md"])
      expect(
        branch.snapshot.parsedDiff.files.some((file) =>
          branch.excludedTargetOnlyPaths.includes(file.path),
        ),
      ).toBe(false)
      expect(working.snapshot.diff.diff).not.toBe(branch.snapshot.diff.diff)
      expect(working.snapshot.reviewKey).not.toBe(branch.snapshot.reviewKey)
      expect(working.snapshot.snapshotId).not.toBe(branch.snapshot.snapshotId)
      expect(workingManifest.snapshotId).not.toBe(branchManifest.snapshotId)
      expect(workingThreads.map(({ id }) => id)).not.toEqual(branchThreads.map(({ id }) => id))
      expect(workingThreads[0]?.reviewKey).toBe(working.snapshot.reviewKey)
      expect(branchThreads[0]?.reviewKey).toBe(branch.snapshot.reviewKey)
      expect(workingViewed.map(({ reviewKey }) => reviewKey)).not.toEqual(
        branchViewed.map(({ reviewKey }) => reviewKey),
      )

      for (const fixture of [working, branch]) {
        const localHunkIds = new Set(
          buildWalkthroughHunkDigest(
            fixture.snapshot.parsedDiff.files,
            walkthroughLocalDiffScope(fixture.snapshot.headRevision),
          ).map(({ id }) => id),
        )
        const walkthroughHunkIds = [
          ...fixture.walkthrough.walkthrough.chapters.flatMap((chapter) =>
            chapter.stops.flatMap((stop) => stop.hunkIds),
          ),
          ...fixture.walkthrough.walkthrough.support.flatMap((item) => item.hunkIds),
        ]
        expect(walkthroughHunkIds.every((id) => localHunkIds.has(id))).toBe(true)
      }
    }),
  )
})
