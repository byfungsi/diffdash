import { Context, Effect, Layer } from "effect"

import type { CommentNote } from "@diffdash/domain/comment-note"
import { InvokeChannel } from "@diffdash/protocol/channels"
import type {
  ClearCommentNotesRequest,
  CreateCommentNoteRequest,
  DeleteCommentNoteRequest,
  ListCommentNotesRequest,
  SendCommentNotesReceipt,
  SendCommentNotesRequest,
} from "@diffdash/protocol/comment-notes"
import { PreloadClient } from "./preload-client"
import { invokePreload, type RendererApiError } from "./renderer-api-error"

/** Renderer operations for collecting and sending context-scoped source notes. */
export interface CommentNotesOperations {
  readonly list: (
    request: ListCommentNotesRequest,
  ) => Effect.Effect<readonly CommentNote[], RendererApiError>
  readonly create: (
    request: CreateCommentNoteRequest,
  ) => Effect.Effect<CommentNote, RendererApiError>
  readonly delete: (request: DeleteCommentNoteRequest) => Effect.Effect<void, RendererApiError>
  readonly clear: (request: ClearCommentNotesRequest) => Effect.Effect<void, RendererApiError>
  readonly send: (
    request: SendCommentNotesRequest,
  ) => Effect.Effect<SendCommentNotesReceipt, RendererApiError>
}

/** Renderer capabilities for collecting and sending context-scoped source notes. */
export class CommentNotes extends Context.Service<CommentNotes, CommentNotesOperations>()(
  "@diffdash/app/CommentNotes",
) {}

/** Desktop implementation of renderer comment-note capabilities. */
export const commentNotesLayer = Layer.effect(
  CommentNotes,
  Effect.gen(function* () {
    const api = yield* PreloadClient

    return CommentNotes.of({
      list: (request) =>
        invokePreload(InvokeChannel.listCommentNotes, () => api.commentNotes.list(request)),
      create: (request) =>
        invokePreload(InvokeChannel.createCommentNote, () => api.commentNotes.create(request)),
      delete: (request) =>
        invokePreload(InvokeChannel.deleteCommentNote, () => api.commentNotes.delete(request)),
      clear: (request) =>
        invokePreload(InvokeChannel.clearCommentNotes, () => api.commentNotes.clear(request)),
      send: (request) =>
        invokePreload(InvokeChannel.sendCommentNotes, () => api.commentNotes.send(request)),
    })
  }),
)
