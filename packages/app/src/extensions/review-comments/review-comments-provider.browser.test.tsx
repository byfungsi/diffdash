import {
  commentNoteContextKey,
  CommentNote,
  type CommentNoteContext,
  CommentNoteId,
  CommentNoteSubject,
  HostedCommentNoteContext,
} from "@diffdash/domain/comment-note"
import { makeHostedReviewLocator } from "@diffdash/domain/git-provider"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import { MarkdownBody } from "@diffdash/domain/review-thread"
import { Effect, Option } from "effect"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { CommentNotesOperations } from "@/platform/comment-notes"
import {
  ReviewCommentsStateControllerProvider,
  useReviewCommentsState,
} from "./review-comments-provider"

const projectId = ReviewProjectId.make("review-context-notes")
const firstContext = HostedCommentNoteContext.make({
  review: makeHostedReviewLocator("github", "fungsi", "diffdash", 42),
  baseRefName: RepositoryComparisonRef.make("main"),
})
const secondContext = HostedCommentNoteContext.make({
  review: makeHostedReviewLocator("github", "fungsi", "diffdash", 43),
  baseRefName: RepositoryComparisonRef.make("main"),
})

let root: Root | null = null

afterEach(() => {
  root?.unmount()
  root = null
  document.body.replaceChildren()
})

describe("Review Comments note context", () => {
  it("loads an independent note collection when the review context changes", async () => {
    const firstNote = note("first-note", "First review note")
    const secondNote = note("second-note", "Second review note")
    const notesByContext = new Map([
      [commentNoteContextKey(firstContext), [firstNote]],
      [commentNoteContextKey(secondContext), [secondNote]],
    ])
    const list = vi.fn<CommentNotesOperations["list"]>((request) =>
      Effect.succeed(notesByContext.get(commentNoteContextKey(request.context)) ?? []),
    )
    const operations: CommentNotesOperations = {
      list,
      create: () => Effect.die("Create must not run"),
      delete: () => Effect.die("Delete must not run"),
      clear: () => Effect.die("Clear must not run"),
      send: () => Effect.die("Send must not run"),
    }

    render(firstContext, operations)
    await vi.waitFor(() => expect(document.body.textContent).toContain("First review note"))

    render(secondContext, operations)
    await vi.waitFor(() => expect(document.body.textContent).toContain("Second review note"))

    expect(list.mock.calls.map(([request]) => request.context)).toEqual([
      firstContext,
      secondContext,
    ])
  })
})

const note = (id: string, body: string) =>
  CommentNote.make({
    id: CommentNoteId.make(id),
    projectId,
    subject: CommentNoteSubject.cases.CodeLine.make({
      workspaceRevision: ReviewRevision.make("workspace"),
      gitRevision: null,
      path: RepositoryRelativePath.make("src/example.ts"),
      lineNumber: 1,
      lineContent: "example",
    }),
    body: MarkdownBody.make(body),
    createdAt: "2026-08-29T12:00:00.000Z",
  })

const render = (noteContext: CommentNoteContext, commentNotes: CommentNotesOperations) => {
  const container = document.body.firstElementChild ?? document.createElement("div")
  if (!container.isConnected) {
    document.body.append(container)
    root = createRoot(container)
  }
  root?.render(
    <ReviewCommentsStateControllerProvider
      commentNotes={commentNotes}
      connection={Option.none()}
      mode="notes"
      noteContext={noteContext}
      projectId={projectId}
      onModeChange={() => Promise.resolve()}
    >
      <NoteBodies />
    </ReviewCommentsStateControllerProvider>,
  )
}

const NoteBodies = () => {
  const { notes } = useReviewCommentsState()
  return notes.map((current) => current.body).join(", ")
}
