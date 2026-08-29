import { describe, expect, it } from "@effect/vitest"

import { makeHostedRepositoryLocator, makeHostedReviewLocator } from "./git-provider"
import { LocalReviewTarget, RevisionRangeComparison } from "./local-review"
import { RepositoryCheckoutPath } from "./repository"
import {
  GitCommitSha,
  RepositoryComparisonRef,
  RepositoryComparisonTarget,
} from "./repository-comparison"
import { RepositoryRelativePath } from "./repository-path"
import { ReviewProjectId, ReviewRevision } from "./review-identity"
import { MarkdownBody } from "./review-thread"
import {
  commentNoteContextKey,
  CommentNote,
  CommentNoteId,
  CommentNoteSubject,
  formatCommentNotes,
  HostedCommentNoteContext,
  LocalCommentNoteContext,
  RepositoryComparisonCommentNoteContext,
} from "./comment-note"

describe("collected comment notes", () => {
  it("formats ordered committed and working-tree Code notes as one prompt", () => {
    const projectId = ReviewProjectId.make("project-1")
    const first = CommentNote.make({
      id: CommentNoteId.make("note-1"),
      projectId,
      subject: CommentNoteSubject.cases.CodeLine.make({
        workspaceRevision: ReviewRevision.make("workspace-1"),
        gitRevision: GitCommitSha.make("a".repeat(40)),
        path: RepositoryRelativePath.make("src/first.ts"),
        lineNumber: 4,
        lineContent: "const first = true",
      }),
      body: MarkdownBody.make("Rename this value."),
      createdAt: "2026-08-29T10:00:00.000Z",
    })
    const second = CommentNote.make({
      id: CommentNoteId.make("note-2"),
      projectId,
      subject: CommentNoteSubject.cases.CodeLine.make({
        workspaceRevision: ReviewRevision.make("workspace-2"),
        gitRevision: null,
        path: RepositoryRelativePath.make("src/second.ts"),
        lineNumber: 9,
        lineContent: "const second = false",
      }),
      body: MarkdownBody.make("Explain why this is false."),
      createdAt: "2026-08-29T10:01:00.000Z",
    })

    const prompt = formatCommentNotes([first, second])

    expect(prompt).toContain("## Note 1")
    expect(prompt).toContain("Path: src/first.ts")
    expect(prompt).toContain(`Git revision: ${"a".repeat(40)}`)
    expect(prompt).toContain("## Note 2")
    expect(prompt).toContain("Git revision: uncommitted working tree")
    expect(prompt.indexOf("Rename this value.")).toBeLessThan(
      prompt.indexOf("Explain why this is false."),
    )
  })

  it("keeps hosted notes across commits but separates reviews and base branches", () => {
    const review = makeHostedReviewLocator("github", "fungsi", "diffdash", 42)
    const main = HostedCommentNoteContext.make({
      review,
      baseRefName: RepositoryComparisonRef.make("main"),
    })
    const sameReview = HostedCommentNoteContext.make({
      review,
      baseRefName: RepositoryComparisonRef.make("main"),
    })
    const changedBase = HostedCommentNoteContext.make({
      review,
      baseRefName: RepositoryComparisonRef.make("release"),
    })
    const anotherReview = HostedCommentNoteContext.make({
      review: makeHostedReviewLocator("github", "fungsi", "diffdash", 43),
      baseRefName: RepositoryComparisonRef.make("main"),
    })

    expect(commentNoteContextKey(sameReview)).toBe(commentNoteContextKey(main))
    expect(commentNoteContextKey(changedBase)).not.toBe(commentNoteContextKey(main))
    expect(commentNoteContextKey(anotherReview)).not.toBe(commentNoteContextKey(main))
  })

  it("keeps repository-comparison notes across resolved revision changes", () => {
    const target = RepositoryComparisonTarget.make({
      kind: "repositoryComparison",
      repository: makeHostedRepositoryLocator("github", "fungsi", "diffdash"),
      baseRef: RepositoryComparisonRef.make("main"),
      headRef: RepositoryComparisonRef.make("feature"),
      baseSha: GitCommitSha.make("a".repeat(40)),
      headSha: GitCommitSha.make("b".repeat(40)),
      mergeBaseSha: GitCommitSha.make("a".repeat(40)),
    })
    const refreshed = RepositoryComparisonTarget.make({
      ...target,
      baseSha: GitCommitSha.make("c".repeat(40)),
      headSha: GitCommitSha.make("d".repeat(40)),
      mergeBaseSha: GitCommitSha.make("c".repeat(40)),
    })

    expect(
      commentNoteContextKey(RepositoryComparisonCommentNoteContext.make({ target: refreshed })),
    ).toBe(commentNoteContextKey(RepositoryComparisonCommentNoteContext.make({ target })))
  })

  it("keeps local comparison notes across resolved revision changes", () => {
    const comparison = RevisionRangeComparison.make({
      baseRef: RepositoryComparisonRef.make("main"),
      headRef: RepositoryComparisonRef.make("feature"),
      baseSha: ReviewRevision.make("a".repeat(40)),
      headSha: ReviewRevision.make("b".repeat(40)),
      mergeBaseSha: ReviewRevision.make("a".repeat(40)),
    })
    const target = LocalReviewTarget.make({
      kind: "local",
      rootPath: RepositoryCheckoutPath.make("/workspace/diffdash"),
      comparison,
    })
    const refreshed = LocalReviewTarget.make({
      ...target,
      comparison: RevisionRangeComparison.make({
        ...comparison,
        baseSha: ReviewRevision.make("c".repeat(40)),
        headSha: ReviewRevision.make("d".repeat(40)),
        mergeBaseSha: ReviewRevision.make("c".repeat(40)),
      }),
    })

    expect(
      commentNoteContextKey(
        LocalCommentNoteContext.make({ target: refreshed, sourceBranch: null }),
      ),
    ).toBe(commentNoteContextKey(LocalCommentNoteContext.make({ target, sourceBranch: null })))
  })
})
