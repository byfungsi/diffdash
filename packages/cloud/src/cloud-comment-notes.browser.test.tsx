import { CommentNoteSubject, HostedCommentNoteContext } from "@diffdash/domain/comment-note"
import { PositiveInteger } from "@diffdash/domain/domain-scalar"
import { makeHostedReviewLocator } from "@diffdash/domain/git-provider"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import { MarkdownBody } from "@diffdash/domain/review-thread"
import {
  CreateCommentNoteRequest,
  DeleteCommentNoteRequest,
  ListCommentNotesRequest,
} from "@diffdash/protocol/comment-notes"
import { expect, it } from "vitest"
import { CloudCommentNotes } from "./cloud-comment-notes"

it("isolates review collections and commits concurrent note writes without losing entries", async () => {
  const notes = new CloudCommentNotes()
  const projectId = ReviewProjectId.make(`notes-storage-${crypto.randomUUID()}`)
  const collection = (number: number) =>
    ListCommentNotesRequest.make({
      projectId,
      context: HostedCommentNoteContext.make({
        review: makeHostedReviewLocator("github", "fixture", "notes", number),
        baseRefName: RepositoryComparisonRef.make("main"),
      }),
    })
  const first = collection(1)
  const second = collection(2)
  const subject = CommentNoteSubject.cases.CodeLine.make({
    workspaceRevision: ReviewRevision.make("fixture-revision"),
    gitRevision: null,
    path: RepositoryRelativePath.make("notes.ts"),
    lineNumber: PositiveInteger.make(1),
    lineContent: "captured source",
  })
  const create = (request: ListCommentNotesRequest, body: string) =>
    notes.create(
      CreateCommentNoteRequest.make({ ...request, subject, body: MarkdownBody.make(body) }),
    )
  try {
    const [left, right, other] = await Promise.all([
      create(first, "First note"),
      create(first, "Second note"),
      create(second, "Other review"),
    ])
    expect((await new CloudCommentNotes().list(first)).map(({ id }) => id).toSorted()).toEqual(
      [left.id, right.id].toSorted(),
    )
    await notes.delete(DeleteCommentNoteRequest.make({ ...first, noteId: other.id }))
    expect(await notes.list(second)).toHaveLength(1)
    await notes.clear(first)
    expect(await notes.list(first)).toEqual([])
    expect(await notes.list(second)).toHaveLength(1)
    await notes.delete(DeleteCommentNoteRequest.make({ ...second, noteId: other.id }))
    expect(await notes.list(second)).toEqual([])
  } finally {
    await notes.clear(first)
    await notes.clear(second)
  }
})
