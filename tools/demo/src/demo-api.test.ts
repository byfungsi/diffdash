import { describe, expect, it } from "@effect/vitest"
import { Effect, Match } from "effect"

import {
  CommentDestination,
  CommentSubmission,
  CommentSubmissionReceipt,
  CommentSubject,
} from "@diffdash/domain/comment"
import { HostedReviewTarget, MarkdownBody } from "@diffdash/domain/review-thread"
import {
  ProjectWorkspaceActivityId,
  ProjectWorkspaceNavigationContributionId,
  ProjectWorkspaceStateInput,
} from "@diffdash/domain/project-workspace"
import { ReviewHunkId, ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { GitCommitSha, RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { SubmitCommentRequest } from "@diffdash/protocol/ai-connection"
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
import { WalkthroughBridgeIdempotencyKey } from "@diffdash/protocol/walkthrough-operation"
import { buildWalkthroughHunkDigest, walkthroughLocalDiffScope } from "@diffdash/domain/walkthrough"
import { createDemoLocalReviewFixtures } from "./local-review-fixtures"

const filesActivityId = ProjectWorkspaceActivityId.make("diffdash.fixture.files")
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
            activeSurface: "review",
            activeActivity: filesActivityId,
            navigation: {
              contributionId: ProjectWorkspaceNavigationContributionId.make(
                "diffdash.fixture.navigation",
              ),
              location: { selectedReview: null },
            },
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
          fileId: page.files[0]?.fileId ?? scenario.currentRevision.parsedDiff.files[0]!.fileId,
          startLine: 0,
        }),
      )
      const laterFile = scenario.currentRevision.parsedDiff.files
        .slice(8)
        .find((file) => file.hunks.length > 0)
      expect(laterFile).toBeDefined()
      if (laterFile === undefined) return
      const resolved = yield* Effect.promise(() =>
        api.progressiveReviews.resolveTarget({
          identity: session.identity,
          fileId: laterFile.fileId,
          target: { _tag: "HunkLine", hunkId: laterFile.hunks[0]?.id ?? null, line: 0 },
        }),
      )

      expect(repositories.map((repository) => repository.id)).toEqual(["github:emberline/dispatch"])
      expect(reviewRequests[0]?.title).toBe("Make webhook replay claims atomic")
      expect(manifest.detail.summary.head.revision).toBe("c8a4f38d5f31dd16f39a6f42c4a8e44bed782e69")
      expect(page.files).toHaveLength(8)
      expect(page.nextOffset).not.toBeNull()
      expect(resolved.file.fileId).toBe(laterFile.fileId)
      yield* Effect.promise(() =>
        expect(
          api.progressiveReviews.resolveTarget({
            identity: session.identity,
            fileId: laterFile.fileId,
            target: {
              _tag: "HunkLine",
              hunkId: ReviewHunkId.make("missing-demo-hunk"),
              line: 0,
            },
          }),
        ).rejects.toThrow("Demo review target is unavailable"),
      )
      expect(new TextDecoder().decode(range.blocks[0]?.bytes)).toContain("diff --git")
      expect(timeline.getState().revisionId).toBe("01-initial")
    }),
  )

  it.effect("cancels pending walkthrough hints when the scenario resets", () =>
    Effect.gen(function* () {
      const scenario = yield* loadAtomicWebhookReplayScenario
      const { api, timeline } = createDemoRuntime(scenario)
      const hints: unknown[] = []
      const unsubscribe = api.walkthroughOperations.onHint((hint) => hints.push(hint))

      yield* Effect.promise(() =>
        api.walkthroughOperations.start({
          target: HostedReviewTarget.make({ kind: "hosted", review }),
          regenerate: false,
          idempotencyKey: WalkthroughBridgeIdempotencyKey.make("w:demo-reset"),
        }),
      )
      yield* Effect.promise(() => timeline.reset(scenario.manifest.id))
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)))
      unsubscribe()

      expect(hints).toEqual([])
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

  it.effect("routes DiffDash review comments through the demo review thread store", () =>
    Effect.gen(function* () {
      const scenario = yield* loadAtomicWebhookReplayScenario
      const { api, timeline } = createDemoRuntime(scenario)
      const source = scenario.threads[0]
      const initialRevision = scenario.revisions[0]
      expect(source).toBeDefined()
      expect(initialRevision).toBeDefined()
      if (source === undefined || initialRevision === undefined) return
      const subject = CommentSubject.cases.ReviewLine.make({
        target: HostedReviewTarget.make({ kind: "hosted", review }),
        expectedBaseRevision: initialRevision.manifest.baseRevision,
        expectedHeadRevision: initialRevision.manifest.headRevision,
        anchor: source.thread.originalAnchor,
      })

      const started = yield* Effect.promise(() =>
        api.ai.submitComment(
          SubmitCommentRequest.make({
            destination: CommentDestination.cases.DiffDash.make({}),
            submission: CommentSubmission.cases.Start.make({
              subject,
              body: MarkdownBody.make("Check the transaction boundary"),
            }),
          }),
        ),
      )
      expect(CommentSubmissionReceipt.guards.StoredLocally(started)).toBe(true)
      if (!CommentSubmissionReceipt.guards.StoredLocally(started)) return
      const startedDetails = yield* Effect.promise(() => api.reviewThreads.get(started.threadId))
      const startedMessage = startedDetails.messages.at(-2)
      expect(startedMessage).toBeDefined()
      if (startedMessage === undefined) return
      expect(
        Match.valueTags(startedMessage, {
          User: ({ bodyMarkdown }) => bodyMarkdown,
          Pending: () => null,
          Completed: () => null,
          Failed: () => null,
        }),
      ).toBe("Check the transaction boundary")
      expect(startedDetails.messages.at(-1)?._tag).toBe("Pending")

      const initialTurnId = Object.keys(scenario.agentTurns)[0]
      expect(initialTurnId).toBeDefined()
      if (initialTurnId === undefined) return
      yield* Effect.promise(() => timeline.release(initialTurnId))
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))

      yield* Effect.promise(() =>
        expect(
          api.ai.submitComment(
            SubmitCommentRequest.make({
              destination: CommentDestination.cases.DiffDash.make({}),
              submission: CommentSubmission.cases.FollowUp.make({
                subject: CommentSubject.cases.ReviewLine.make({
                  ...subject,
                  expectedHeadRevision: ReviewRevision.make("stale-head"),
                }),
                threadId: started.threadId,
                body: MarkdownBody.make("Stale follow-up"),
              }),
            }),
          ),
        ).rejects.toThrow("Demo comment subject does not match the current review thread"),
      )

      const followedUp = yield* Effect.promise(() =>
        api.ai.submitComment(
          SubmitCommentRequest.make({
            destination: CommentDestination.cases.DiffDash.make({}),
            submission: CommentSubmission.cases.FollowUp.make({
              subject,
              threadId: started.threadId,
              body: MarkdownBody.make("What happens during a retry?"),
            }),
          }),
        ),
      )
      expect(CommentSubmissionReceipt.guards.StoredLocally(followedUp)).toBe(true)
      if (!CommentSubmissionReceipt.guards.StoredLocally(followedUp)) return
      const followedUpDetails = yield* Effect.promise(() =>
        api.reviewThreads.get(followedUp.threadId),
      )
      const followUpMessage = followedUpDetails.messages.at(-2)
      expect(followUpMessage).toBeDefined()
      if (followUpMessage === undefined) return
      expect(
        Match.valueTags(followUpMessage, {
          User: ({ bodyMarkdown }) => bodyMarkdown,
          Pending: () => null,
          Completed: () => null,
          Failed: () => null,
        }),
      ).toBe("What happens during a retry?")
      expect(followedUpDetails.messages.at(-1)?._tag).toBe("Pending")
      expect(timeline.getActionLog().map(({ type }) => type)).toEqual(
        expect.arrayContaining(["reviewThreads.create", "reviewThreads.addUserMessage"]),
      )

      yield* Effect.promise(() => timeline.release("revision-updated"))
      yield* Effect.promise(() =>
        expect(
          api.ai.submitComment(
            SubmitCommentRequest.make({
              destination: CommentDestination.cases.DiffDash.make({}),
              submission: CommentSubmission.cases.FollowUp.make({
                subject,
                threadId: started.threadId,
                body: MarkdownBody.make("Follow-up after the revision changed"),
              }),
            }),
          ),
        ).rejects.toThrow("Demo comment subject does not match the current review thread"),
      )

      yield* Effect.promise(() =>
        expect(
          api.ai.submitComment(
            SubmitCommentRequest.make({
              destination: CommentDestination.cases.DiffDash.make({}),
              submission: CommentSubmission.cases.Start.make({
                subject: CommentSubject.cases.CodeLine.make({
                  projectId: ReviewProjectId.make(scenario.repository.id),
                  revision: GitCommitSha.make(source.thread.currentHeadRevision),
                  path: RepositoryRelativePath.make("src/example.ts"),
                  lineNumber: 1,
                  lineContent: "const example = true",
                }),
                body: MarkdownBody.make("Explain this line"),
              }),
            }),
          ),
        ).rejects.toMatchObject({
          _tag: "CommentSubmissionUnsupportedError",
          destination: "DiffDash",
          subject: "CodeLine",
        }),
      )
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
        expect(branch.target.comparison.baseSha).toBe(branch.manifest.baseRevision)
        expect(branch.target.comparison.baseSha).not.toBe(branch.comparisonTargetSha)
      }
      expect(branch.excludedTargetOnlyPaths).toEqual(["docs/dev-release-notes.md"])
      expect(
        branch.parsedDiff.files.some((file) => branch.excludedTargetOnlyPaths.includes(file.path)),
      ).toBe(false)
      expect(working.diff.diff).not.toBe(branch.diff.diff)
      expect(working.manifest.reviewKey).not.toBe(branch.manifest.reviewKey)
      expect(working.manifest.snapshotId).not.toBe(branch.manifest.snapshotId)
      expect(workingManifest.snapshotId).not.toBe(branchManifest.snapshotId)
      expect(workingThreads.map(({ id }) => id)).not.toEqual(branchThreads.map(({ id }) => id))
      expect(workingThreads[0]?.reviewKey).toBe(working.manifest.reviewKey)
      expect(branchThreads[0]?.reviewKey).toBe(branch.manifest.reviewKey)
      expect(workingViewed.map(({ reviewKey }) => reviewKey)).not.toEqual(
        branchViewed.map(({ reviewKey }) => reviewKey),
      )

      for (const fixture of [working, branch]) {
        const localHunkIds = new Set(
          buildWalkthroughHunkDigest(
            fixture.parsedDiff.files,
            walkthroughLocalDiffScope(fixture.manifest.headRevision),
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
