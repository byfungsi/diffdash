import {
  CommentDestination,
  CommentSubmission,
  CommentSubmissionReceipt,
  CommentSubjectMismatchError,
  CommentSubmissionUnsupportedError,
  CommentSubject,
} from "@diffdash/domain/comment"
import {
  CommentNoteId,
  CommentNoteSubject,
  SendCommentNotesReceipt,
} from "@diffdash/domain/comment-note"
import { StartReviewAgentOperationRequest } from "@diffdash/core-rpc/review-agent"
import type { AgentRunId } from "@diffdash/domain/agent-run-id"
import type { ReviewKey, ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import {
  ReviewThreadRevisionChangedError,
  type ReviewThreadDetails,
  type ReviewThreadTarget,
} from "@diffdash/domain/review-thread"
import type { AddReviewThreadUserMessageForSubjectInput } from "@diffdash/persistence/review-thread-store"
import { Effect, Semaphore } from "effect"
import { CommentNoteStore } from "@diffdash/persistence/comment-note-store"

import {
  CoreMethod,
  type CoreOperationFailure,
  type CoreOperationOptions,
  type CoreThreadResolutionFailure,
} from "../core-contract"
import { OpenCodeConnectionService } from "../services/opencode-connection"
import type { OperationHandlersFor } from "./operation-handlers"

type CommentMethod =
  | typeof CoreMethod.connectOpenCodeSession
  | typeof CoreMethod.listOpenCodeSessions
  | typeof CoreMethod.submitComment
  | typeof CoreMethod.listCommentNotes
  | typeof CoreMethod.createCommentNote
  | typeof CoreMethod.deleteCommentNote
  | typeof CoreMethod.clearCommentNotes
  | typeof CoreMethod.sendCommentNotes

type ThreadHandlers = OperationHandlersFor<
  typeof CoreMethod.addReviewThreadUserMessage | typeof CoreMethod.createReviewThread
>
type SubmitEffect = Effect.Effect<
  typeof CommentSubmissionReceipt.Type,
  CoreOperationFailure<typeof CoreMethod.submitComment>
>
interface ResolvedCommentReview {
  readonly projectId: ReviewProjectId
  readonly reviewKey: ReviewKey
  readonly baseRevision: ReviewRevision
  readonly headRevision: ReviewRevision
}

/** Acquires authoritative OpenCode and exclusive comment-routing handlers. */
export const makeCommentOperationHandlers = (
  threads: ThreadHandlers,
  startReviewAgent: (
    request: StartReviewAgentOperationRequest,
  ) => Effect.Effect<AgentRunId, CoreOperationFailure<typeof CoreMethod.submitComment>>,
  resolveReview: (
    target: ReviewThreadTarget,
  ) => Effect.Effect<ResolvedCommentReview, CoreThreadResolutionFailure>,
  addFollowUp: (
    input: AddReviewThreadUserMessageForSubjectInput,
  ) => Effect.Effect<ReviewThreadDetails, CoreOperationFailure<typeof CoreMethod.submitComment>>,
): Effect.Effect<
  OperationHandlersFor<CommentMethod>,
  never,
  CommentNoteStore | OpenCodeConnectionService
> =>
  Effect.gen(function* () {
    const openCode = yield* OpenCodeConnectionService
    const notes = yield* CommentNoteStore
    const sendNotesLock = yield* Semaphore.make(1)

    const startLocalAgent = Effect.fn("CommentSubmission.startLocalAgent")(function* (
      details: ReviewThreadDetails,
      subject: typeof CommentSubject.cases.ReviewLine.Type,
      options: CoreOperationOptions,
    ) {
      if (
        options.applicationInstanceId === undefined ||
        options.processEpoch === undefined ||
        options.requestId === undefined
      ) {
        return yield* Effect.die(
          new Error("Comment submission request identity is required to start a local agent."),
        )
      }
      return yield* startReviewAgent(
        StartReviewAgentOperationRequest.make({
          applicationInstanceId: options.applicationInstanceId,
          processEpoch: options.processEpoch,
          requestId: options.requestId,
          threadId: details.thread.id,
          target: subject.target,
          repoId: details.thread.repoId,
          reviewKey: details.thread.reviewKey,
          expectedBaseRevision: subject.expectedBaseRevision,
          expectedHeadRevision: subject.expectedHeadRevision,
        }),
      )
    })

    const localReceipt = Effect.fn("CommentSubmission.localReceipt")(function* (
      details: ReviewThreadDetails,
      subject: typeof CommentSubject.cases.ReviewLine.Type,
      options: CoreOperationOptions,
    ) {
      const agentAccepted = yield* startLocalAgent(details, subject, options).pipe(
        Effect.match({ onFailure: () => false, onSuccess: () => true }),
      )
      return CommentSubmissionReceipt.cases.StoredLocally.make({
        threadId: details.thread.id,
        agentAccepted,
      })
    })

    const resolveSubjectReview = Effect.fn("CommentSubmission.resolveSubjectReview")(function* (
      subject: typeof CommentSubject.cases.ReviewLine.Type,
    ) {
      const review = yield* resolveReview(subject.target)
      if (
        review.baseRevision !== subject.expectedBaseRevision ||
        review.headRevision !== subject.expectedHeadRevision
      ) {
        return yield* ReviewThreadRevisionChangedError.make({
          expectedBaseRevision: subject.expectedBaseRevision,
          expectedHeadRevision: subject.expectedHeadRevision,
          currentBaseRevision: review.baseRevision,
          currentHeadRevision: review.headRevision,
        })
      }
      return review
    })

    return {
      [CoreMethod.listOpenCodeSessions]: openCode.listSessions,
      [CoreMethod.connectOpenCodeSession]: openCode.connect,
      [CoreMethod.submitComment]: (request, options) =>
        CommentDestination.match(request.destination, {
          DiffDash: (): SubmitEffect =>
            CommentSubmission.match(request.submission, {
              Start: ({ subject, body }) =>
                CommentSubject.match(subject, {
                  CodeLine: (): SubmitEffect =>
                    Effect.fail(
                      CommentSubmissionUnsupportedError.make({
                        destination: "DiffDash",
                        subject: "CodeLine",
                      }),
                    ),
                  ReviewLine: (review): SubmitEffect =>
                    threads[CoreMethod.createReviewThread](
                      {
                        target: review.target,
                        expectedBaseRevision: review.expectedBaseRevision,
                        expectedHeadRevision: review.expectedHeadRevision,
                        anchor: review.anchor,
                        bodyMarkdown: body,
                      },
                      options,
                    ).pipe(Effect.flatMap((details) => localReceipt(details, review, options))),
                }),
              FollowUp: ({ subject, threadId, body }) =>
                CommentSubject.match(subject, {
                  CodeLine: (): SubmitEffect =>
                    Effect.fail(
                      CommentSubmissionUnsupportedError.make({
                        destination: "DiffDash",
                        subject: "CodeLine",
                      }),
                    ),
                  ReviewLine: (review): SubmitEffect =>
                    Effect.gen(function* () {
                      const resolved = yield* resolveSubjectReview(review)
                      const details = yield* addFollowUp({
                        threadId,
                        bodyMarkdown: body,
                        repoId: resolved.projectId,
                        reviewKey: resolved.reviewKey,
                        currentBaseRevision: resolved.baseRevision,
                        currentHeadRevision: resolved.headRevision,
                        currentAnchor: review.anchor,
                      })
                      return yield* localReceipt(details, review, options)
                    }),
                }),
            }),
          OpenCode: ({ connection }): SubmitEffect => {
            const { subject, body } = request.submission
            return Effect.gen(function* () {
              const authorizedProjectId = yield* CommentSubject.match(subject, {
                CodeLine: ({ projectId: codeProjectId }) => Effect.succeed(codeProjectId),
                ReviewLine: (review) =>
                  resolveSubjectReview(review).pipe(Effect.map((resolved) => resolved.projectId)),
              })
              yield* openCode.forwardComment({
                projectId: authorizedProjectId,
                sessionId: connection.session.id,
                subject,
                body,
              })
              return CommentSubmissionReceipt.cases.Forwarded.make({
                sessionId: connection.session.id,
              })
            })
          },
        }),
      [CoreMethod.listCommentNotes]: (request) => notes.list(request.projectId, request.context),
      [CoreMethod.createCommentNote]: (request) =>
        Effect.gen(function* () {
          if (CommentNoteSubject.guards.ReviewLine(request.subject)) {
            const resolved = yield* resolveReview(request.subject.target)
            if (resolved.projectId !== request.projectId) {
              return yield* CommentSubjectMismatchError.make({
                reason: "The review note belongs to a different project.",
              })
            }
          }
          return yield* notes.create({
            id: CommentNoteId.make(crypto.randomUUID()),
            projectId: request.projectId,
            context: request.context,
            subject: request.subject,
            body: request.body,
            createdAt: new Date().toISOString(),
          })
        }),
      [CoreMethod.deleteCommentNote]: (request) =>
        notes.delete(request.projectId, request.context, request.noteId),
      [CoreMethod.clearCommentNotes]: (request) => notes.clear(request.projectId, request.context),
      [CoreMethod.sendCommentNotes]: (request) =>
        sendNotesLock.withPermits(1)(
          Effect.gen(function* () {
            const snapshot = yield* notes.list(request.projectId, request.context)
            if (snapshot.length === 0) return SendCommentNotesReceipt.make({ sentCount: 0 })
            yield* openCode.forwardNotes({
              projectId: request.projectId,
              sessionId: request.connection.session.id,
              notes: snapshot,
            })
            yield* notes.deleteMany(
              request.projectId,
              request.context,
              snapshot.map((note) => note.id),
            )
            return SendCommentNotesReceipt.make({ sentCount: snapshot.length })
          }),
        ),
    }
  })
