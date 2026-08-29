import { describe, expect, it, vi } from "@effect/vitest"
import { Effect, Layer } from "effect"

import {
  OpenCodeConnectionSelection,
  OpenCodeSessionId,
  OpenCodeSessionSummary,
} from "@diffdash/domain/comment"
import {
  CommentNote,
  CommentNoteId,
  CommentNoteSubject,
  ProjectCommentNoteContext,
} from "@diffdash/domain/comment-note"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import { MarkdownBody } from "@diffdash/domain/review-thread"
import type { DiffDashBridgeApi } from "@diffdash/protocol/api"
import {
  ClearCommentNotesRequest,
  CreateCommentNoteRequest,
  DeleteCommentNoteRequest,
  ListCommentNotesRequest,
  SendCommentNotesReceipt,
  SendCommentNotesRequest,
} from "@diffdash/protocol/comment-notes"
import { transportError } from "@diffdash/protocol/transport-error"
import { CommentNotes, commentNotesLayer } from "./comment-notes"
import { PreloadClient } from "./preload-client"

const projectId = ReviewProjectId.make("project-1")
const context = ProjectCommentNoteContext.make({})
const subject = CommentNoteSubject.cases.CodeLine.make({
  workspaceRevision: ReviewRevision.make("workspace-1"),
  gitRevision: null,
  path: RepositoryRelativePath.make("src/example.ts"),
  lineNumber: 4,
  lineContent: "const example = true",
})
const note = CommentNote.make({
  id: CommentNoteId.make("note-1"),
  projectId,
  subject,
  body: MarkdownBody.make("Explain this line."),
  createdAt: "2026-08-29T10:00:00.000Z",
})
const connection = OpenCodeConnectionSelection.make({
  projectId,
  session: OpenCodeSessionSummary.make({
    id: OpenCodeSessionId.make("ses_commentNotes"),
    title: "Review session",
    directory: RepositoryCheckoutPath.make("/workspace/project"),
    updatedAt: 1,
  }),
  planMode: true,
})

const success = <Value>(value: Value) => Promise.resolve({ _tag: "Success" as const, value })

const serviceLayer = (commentNotes: DiffDashBridgeApi["commentNotes"]) =>
  commentNotesLayer.pipe(
    Layer.provide(
      Layer.succeed(
        PreloadClient,
        // SAFETY: CommentNotes only reads this exact bridge subtree in these focused unit tests.
        { commentNotes } as DiffDashBridgeApi,
      ),
    ),
  )

describe("CommentNotes", () => {
  it.effect("routes every operation through the preload comment-note API", () => {
    const list = vi.fn<DiffDashBridgeApi["commentNotes"]["list"]>(() => success([note]))
    const create = vi.fn<DiffDashBridgeApi["commentNotes"]["create"]>(() => success(note))
    const remove = vi.fn<() => Promise<{ readonly _tag: "Success"; readonly value: null }>>(() =>
      success(null),
    )
    const clear = vi.fn<() => Promise<{ readonly _tag: "Success"; readonly value: null }>>(() =>
      success(null),
    )
    const send = vi.fn<DiffDashBridgeApi["commentNotes"]["send"]>(() =>
      success(SendCommentNotesReceipt.make({ sentCount: 1 })),
    )
    const layer = serviceLayer({ list, create, delete: remove, clear, send })
    const listRequest = ListCommentNotesRequest.make({ projectId, context })
    const createRequest = CreateCommentNoteRequest.make({
      projectId,
      context,
      subject,
      body: MarkdownBody.make("Explain this line."),
    })
    const deleteRequest = DeleteCommentNoteRequest.make({ projectId, context, noteId: note.id })
    const clearRequest = ClearCommentNotesRequest.make({ projectId, context })
    const sendRequest = SendCommentNotesRequest.make({ projectId, context, connection })

    return Effect.gen(function* () {
      const notes = yield* CommentNotes

      expect(yield* notes.list(listRequest)).toEqual([note])
      expect(yield* notes.create(createRequest)).toEqual(note)
      yield* notes.delete(deleteRequest)
      yield* notes.clear(clearRequest)
      expect(yield* notes.send(sendRequest)).toEqual({ sentCount: 1 })

      expect(list).toHaveBeenCalledWith(listRequest)
      expect(create).toHaveBeenCalledWith(createRequest)
      expect(remove).toHaveBeenCalledWith(deleteRequest)
      expect(clear).toHaveBeenCalledWith(clearRequest)
      expect(send).toHaveBeenCalledWith(sendRequest)
    }).pipe(Effect.provide(layer))
  })

  it.effect("preserves typed preload failures", () => {
    const failure = transportError(
      "COMMENT_NOTES_UNAVAILABLE",
      "Comment notes are unavailable.",
      "commentNotes:list",
    )
    const failed = () => Promise.resolve({ _tag: "Failure" as const, error: failure })
    const layer = serviceLayer({
      list: failed,
      create: failed,
      delete: failed,
      clear: failed,
      send: failed,
    })

    return Effect.gen(function* () {
      const notes = yield* CommentNotes
      const error = yield* Effect.flip(
        notes.list(ListCommentNotesRequest.make({ projectId, context })),
      )

      expect(error).toEqual(failure)
    }).pipe(Effect.provide(layer))
  })
})
