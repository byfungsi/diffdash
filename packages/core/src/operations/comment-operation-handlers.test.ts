import {
  CommentSubjectMismatchError,
  CommentDestination,
  CommentSubmission,
  CommentSubmissionReceipt,
  CommentSubject,
  OpenCodeConnectionSelection,
  OpenCodeSessionId,
  OpenCodeSessionSummary,
} from "@diffdash/domain/comment"
import { ApplicationInstanceId, CoreProcessEpoch, HostRequestId } from "@diffdash/core-rpc/identity"
import type { StartReviewAgentOperationRequest } from "@diffdash/core-rpc/review-agent"
import { AgentRunId } from "@diffdash/domain/agent-run-id"
import { LocalRepositorySource } from "@diffdash/domain/git-provider"
import { workingTreeReviewTarget } from "@diffdash/domain/local-review"
import { LinkedCheckout, Repo, RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewKey,
  ReviewProjectId,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import {
  CurrentReviewAnchor,
  LineReviewAnchor,
  MarkdownBody,
  ReviewThread,
  ReviewThreadDetails,
  ReviewThreadId,
} from "@diffdash/domain/review-thread"
import { Effect, Layer } from "effect"
import { describe, expect, it, vi } from "vitest"
import type { AddReviewThreadUserMessageForSubjectInput } from "@diffdash/persistence/review-thread-store"

import { CoreMethod } from "../core-contract"
import {
  makeOpenCodeConnectionService,
  OpenCodeApiRequest,
  OpenCodeConnectionService,
  type OpenCodeApiCommand,
} from "../services/opencode-connection"
import { makeCommentOperationHandlers } from "./comment-operation-handlers"

const directory = RepositoryCheckoutPath.make("/workspace")
const projectId = ReviewProjectId.make("project-1")
const target = workingTreeReviewTarget(directory)
const baseRevision = ReviewRevision.make("base")
const headRevision = ReviewRevision.make("head")
const anchor = LineReviewAnchor.make({
  fileId: ReviewFileId.make("file-1"),
  filePath: RepositoryRelativePath.make("src/example.ts"),
  oldPath: null,
  hunkId: ReviewHunkId.make("hunk-1"),
  hunkFingerprint: ReviewHunkFingerprint.make("fingerprint-1"),
  hunkHeader: "@@ -1 +1 @@",
  side: "new",
  lineNumber: 3,
  lineContent: "return value",
})
const subject = CommentSubject.cases.ReviewLine.make({
  target,
  expectedBaseRevision: baseRevision,
  expectedHeadRevision: headRevision,
  anchor,
})
const threadId = ReviewThreadId.make("thread-1")
const details = ReviewThreadDetails.make({
  thread: ReviewThread.make({
    id: threadId,
    repoId: projectId,
    reviewKey: ReviewKey.make("review-1"),
    prNumber: null,
    baseRevision,
    headRevision,
    currentBaseRevision: baseRevision,
    currentHeadRevision: headRevision,
    originalAnchor: anchor,
    currentAnchor: CurrentReviewAnchor.cases.Active.make({ anchor }),
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  }),
  conversation: [],
})
const timestamp = "2026-08-22T00:00:00.000Z"
const repository = Repo.make({
  id: projectId,
  source: LocalRepositorySource.make(),
  checkout: LinkedCheckout.make({ remoteUrl: "file:///workspace", path: directory }),
  isFavorite: false,
  lastOpenedAt: null,
  lastSyncedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
})
const repositories = { getById: () => Effect.succeed(repository) }
const requestOptions = {
  applicationInstanceId: ApplicationInstanceId.make("app-comments"),
  processEpoch: CoreProcessEpoch.make("epoch-comments"),
  requestId: HostRequestId.make("h:comments"),
}
const resolveReview = () =>
  Effect.succeed({ projectId, reviewKey: details.thread.reviewKey, baseRevision, headRevision })

describe("comment operation handlers", () => {
  it("stores locally without invoking OpenCode", async () => {
    const command = vi.fn<OpenCodeApiCommand["run"]>(() => Effect.die("OpenCode was invoked"))
    const create = vi.fn<() => Effect.Effect<ReviewThreadDetails>>(() => Effect.succeed(details))
    const start = vi.fn<(request: StartReviewAgentOperationRequest) => Effect.Effect<AgentRunId>>(
      () => Effect.succeed(AgentRunId.make("run-comment")),
    )
    const handlers = await Effect.runPromise(
      makeCommentOperationHandlers(
        {
          [CoreMethod.createReviewThread]: create,
          [CoreMethod.addReviewThreadUserMessage]: () => Effect.succeed(details),
        },
        start,
        resolveReview,
        () => Effect.die("Follow-up persistence must not run"),
      ).pipe(
        Effect.provide(
          Layer.succeed(
            OpenCodeConnectionService,
            OpenCodeConnectionService.of(
              makeOpenCodeConnectionService({ run: command }, repositories),
            ),
          ),
        ),
      ),
    )

    const receipt = await Effect.runPromise(
      handlers[CoreMethod.submitComment](
        {
          destination: CommentDestination.cases.DiffDash.make({}),
          submission: CommentSubmission.cases.Start.make({
            subject,
            body: MarkdownBody.make("Please explain"),
          }),
        },
        requestOptions,
      ),
    )

    expect(CommentSubmissionReceipt.guards.StoredLocally(receipt)).toBe(true)
    expect(receipt).toMatchObject({
      _tag: "StoredLocally",
      threadId,
      agentAccepted: true,
    })
    expect(create).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledOnce()
    expect(command).not.toHaveBeenCalled()
  })

  it("forwards without invoking local persistence", async () => {
    const sessionId = OpenCodeSessionId.make("ses_example")
    const command = vi.fn<OpenCodeApiCommand["run"]>((request) =>
      Effect.succeed(
        OpenCodeApiRequest.match(request, {
          Get: ({ path }) =>
            path.startsWith("/api/session/")
              ? JSON.stringify({ data: { id: sessionId, location: { directory } } })
              : JSON.stringify({ _tag: "AgentNotFoundError" }),
          Post: () =>
            JSON.stringify({
              data: {
                id: "msg_example",
                sessionID: sessionId,
                type: "user",
                payload: { text: "accepted" },
                delivery: "queue",
                timeCreated: 1,
              },
            }),
        }),
      ),
    )
    const create = vi.fn<() => Effect.Effect<ReviewThreadDetails>>(() => Effect.succeed(details))
    const openCode = makeOpenCodeConnectionService({ run: command }, repositories)
    await Effect.runPromise(openCode.connect({ sessionId, projectId }))
    const handlers = await Effect.runPromise(
      makeCommentOperationHandlers(
        {
          [CoreMethod.createReviewThread]: create,
          [CoreMethod.addReviewThreadUserMessage]: () => Effect.succeed(details),
        },
        () => Effect.die("Agent start must not run"),
        resolveReview,
        () => Effect.die("Local follow-up persistence must not run"),
      ).pipe(
        Effect.provide(
          Layer.succeed(OpenCodeConnectionService, OpenCodeConnectionService.of(openCode)),
        ),
      ),
    )

    const receipt = await Effect.runPromise(
      handlers[CoreMethod.submitComment](
        {
          destination: CommentDestination.cases.OpenCode.make({
            connection: OpenCodeConnectionSelection.make({
              projectId,
              session: OpenCodeSessionSummary.make({
                id: sessionId,
                title: "Session",
                directory,
                updatedAt: 1,
              }),
              planMode: true,
            }),
          }),
          submission: CommentSubmission.cases.FollowUp.make({
            subject,
            threadId,
            body: MarkdownBody.make("Please explain"),
          }),
        },
        {},
      ),
    )

    expect(CommentSubmissionReceipt.guards.Forwarded(receipt)).toBe(true)
    expect(command).toHaveBeenCalledTimes(3)
    expect(create).not.toHaveBeenCalled()
  })

  it("reports local agent acceptance failure without making the stored comment retryable", async () => {
    const command = vi.fn<OpenCodeApiCommand["run"]>(() => Effect.die("OpenCode was invoked"))
    const create = vi.fn<() => Effect.Effect<ReviewThreadDetails>>(() => Effect.succeed(details))
    const failure = CommentSubjectMismatchError.make({ reason: "Agent acceptance failed." })
    const handlers = await Effect.runPromise(
      makeCommentOperationHandlers(
        {
          [CoreMethod.createReviewThread]: create,
          [CoreMethod.addReviewThreadUserMessage]: () => Effect.succeed(details),
        },
        () => Effect.fail(failure),
        resolveReview,
        () => Effect.die("Follow-up persistence must not run"),
      ).pipe(
        Effect.provide(
          Layer.succeed(
            OpenCodeConnectionService,
            OpenCodeConnectionService.of(
              makeOpenCodeConnectionService({ run: command }, repositories),
            ),
          ),
        ),
      ),
    )

    const receipt = await Effect.runPromise(
      handlers[CoreMethod.submitComment](
        {
          destination: CommentDestination.cases.DiffDash.make({}),
          submission: CommentSubmission.cases.Start.make({
            subject,
            body: MarkdownBody.make("Please explain"),
          }),
        },
        requestOptions,
      ),
    )

    expect(receipt).toMatchObject({
      _tag: "StoredLocally",
      threadId,
      agentAccepted: false,
    })
    expect(create).toHaveBeenCalledOnce()
  })

  it("validates the exact follow-up mapping before durably accepting the agent run", async () => {
    const command = vi.fn<OpenCodeApiCommand["run"]>(() => Effect.die("OpenCode was invoked"))
    const order: string[] = []
    const addFollowUp = vi.fn<
      (input: AddReviewThreadUserMessageForSubjectInput) => Effect.Effect<ReviewThreadDetails>
    >((input) =>
      Effect.sync(() => {
        order.push("persist")
        expect(input).toMatchObject({
          threadId,
          repoId: projectId,
          reviewKey: details.thread.reviewKey,
          currentBaseRevision: baseRevision,
          currentHeadRevision: headRevision,
          currentAnchor: anchor,
        })
        return details
      }),
    )
    const start = vi.fn<(request: StartReviewAgentOperationRequest) => Effect.Effect<AgentRunId>>(
      () =>
        Effect.sync(() => {
          order.push("accept")
          return AgentRunId.make("run-follow-up")
        }),
    )
    const handlers = await Effect.runPromise(
      makeCommentOperationHandlers(
        {
          [CoreMethod.createReviewThread]: () => Effect.die("Thread creation must not run"),
          [CoreMethod.addReviewThreadUserMessage]: () =>
            Effect.die("Unvalidated follow-up persistence must not run"),
        },
        start,
        resolveReview,
        addFollowUp,
      ).pipe(
        Effect.provide(
          Layer.succeed(
            OpenCodeConnectionService,
            OpenCodeConnectionService.of(
              makeOpenCodeConnectionService({ run: command }, repositories),
            ),
          ),
        ),
      ),
    )

    await Effect.runPromise(
      handlers[CoreMethod.submitComment](
        {
          destination: CommentDestination.cases.DiffDash.make({}),
          submission: CommentSubmission.cases.FollowUp.make({
            subject,
            threadId,
            body: MarkdownBody.make("Follow up"),
          }),
        },
        requestOptions,
      ),
    )

    expect(order).toEqual(["persist", "accept"])
    expect(addFollowUp).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledOnce()
  })
})
