import { CommentDestination, CommentSubmission, CommentSubject } from "@diffdash/domain/comment"
import { CommentNoteSubject, type CommentNote } from "@diffdash/domain/comment-note"
import { MarkdownBody } from "@diffdash/domain/review-thread"
import { Option } from "effect"
import { Loader2, MessageSquareText, Trash2, X } from "lucide-react"
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react"

import type {
  CodeSourceContributionProps,
  CodeSourceLineTarget,
  ProjectActivityPaneProps,
} from "../extension-registry"
import { useCodeSourceContributionRegistration } from "@/source-surface/code-source-contribution-host"
import { Button } from "@/shared/ui/button"
import { EmptyState } from "@/shared/ui/empty-state"
import { Textarea } from "@/shared/ui/textarea"
import { formatError } from "@/shared/errors"
import { useCommentSubmission } from "./comment-submission-context"
import { type CodeCommentDraft, useReviewCommentsState } from "./review-comments-provider"
import { ReviewCommentsReviewContextPane } from "./review-comments-review-contribution"
import { useCodeSurfaceCapability } from "../code/code-surface-capability"
import { CommentNoteList } from "./comment-note-list"

/** Review Comments behavior mounted into one active Code source host. */
export const ReviewCommentsCodeSourceContribution = ({ source }: CodeSourceContributionProps) => {
  const reviewComments = useReviewCommentsState()
  const toggleCodeDraft = reviewComments.toggleCodeDraft
  const codeDraft = reviewComments.codeDraft
  const discardCodeDraft = reviewComments.discardCodeDraft
  const matchingNotes = useMemo(
    () =>
      (reviewComments.mode === "notes" ? reviewComments.notes : []).filter(
        (note) =>
          CommentNoteSubject.guards.CodeLine(note.subject) &&
          note.subject.workspaceRevision === source.workspaceRevision &&
          note.subject.path === source.path,
      ),
    [reviewComments.mode, reviewComments.notes, source.path, source.workspaceRevision],
  )
  const draftAnnotationLine = Option.match(
    Option.filter(codeDraft, (draft) => codeDraftMatchesSource(draft, source)),
    { onNone: () => null, onSome: (draft) => draft.lineNumber },
  )
  useEffect(() => {
    Option.map(codeDraft, (draft) => {
      if (
        draft.projectId === source.projectId &&
        draft.workspaceRevision !== source.workspaceRevision
      ) {
        discardCodeDraft(draft)
      }
    })
  }, [codeDraft, discardCodeDraft, source])
  const output = useMemo(() => {
    return {
      handleLineAction: (target: CodeSourceLineTarget) => {
        toggleCodeDraft(target)
        return true
      },
      annotations: [
        ...matchingNotes.map((note) => ({
          lineNumber: CommentNoteSubject.guards.CodeLine(note.subject)
            ? note.subject.lineNumber
            : 1,
          render: () => <CodeNoteAnnotation note={note} />,
        })),
        ...(draftAnnotationLine === null
          ? []
          : [
              {
                lineNumber: draftAnnotationLine,
                render: () => <CodeCommentAnnotation />,
              },
            ]),
      ],
    }
  }, [draftAnnotationLine, matchingNotes, toggleCodeDraft])
  useCodeSourceContributionRegistration(output)
  return null
}

/** Comments activity pane shown while the Code source surface remains visible. */
export const ReviewCommentsCodeActivityPane = ({ location }: ProjectActivityPaneProps) => {
  const reviewComments = useReviewCommentsState()
  const code = useCodeSurfaceCapability()
  const activeDraft = Option.filter(
    reviewComments.codeDraft,
    (draft) =>
      draft.projectId === location.projectId &&
      (code.workspaceRevision === null || draft.workspaceRevision === code.workspaceRevision),
  )
  if (reviewComments.mode === "notes") {
    return (
      <CommentNoteList
        isStale={(note) =>
          CommentNoteSubject.match(note.subject, {
            ReviewLine: () => false,
            CodeLine: ({ workspaceRevision }) =>
              code.workspaceRevision !== null && workspaceRevision !== code.workspaceRevision,
          })
        }
        onNavigate={(note) => {
          if (CommentNoteSubject.guards.CodeLine(note.subject)) code.selectPath(note.subject.path)
        }}
      />
    )
  }

  return (
    <aside className="bg-review-sidebar text-review-sidebar-fg flex h-full min-h-0 flex-col">
      <header className="border-review-sidebar-divider flex h-9 shrink-0 items-center border-b px-3">
        <h2 className="text-caption font-semibold tracking-wide uppercase">Comments</h2>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {Option.match(reviewComments.connection, {
          onNone: () => (
            <div className="border-review-sidebar-divider bg-review-sidebar-control/35 rounded-lg border p-3 text-xs">
              <p className="font-medium">Code comments need OpenCode</p>
              <p className="text-review-sidebar-muted mt-1">
                Connect an OpenCode session from the titlebar to send comments on repository code.
              </p>
            </div>
          ),
          onSome: ({ planMode, session }) => (
            <div className="border-review-sidebar-divider bg-review-sidebar-control/35 rounded-lg border p-3 text-xs">
              <p className="truncate font-medium">{session.title}</p>
              <p className="text-review-sidebar-muted mt-1 truncate font-mono text-caption">
                {session.directory}
              </p>
              <p className="text-review-sidebar-muted mt-1">
                {planMode ? "Plan mode" : "Build mode"}
              </p>
            </div>
          ),
        })}
        {Option.match(activeDraft, {
          onNone: () => (
            <EmptyState className="p-5 text-xs">
              Select a source line to start a comment.
            </EmptyState>
          ),
          onSome: (draft) => (
            <section className="border-review-sidebar-divider bg-review-sidebar-control/20 overflow-hidden rounded-lg border">
              <div className="space-y-1 p-3">
                <p className="truncate font-mono text-xs" title={draft.path}>
                  {draft.path}:{draft.lineNumber}
                </p>
                <p className="text-review-sidebar-muted line-clamp-3 whitespace-pre-wrap text-caption">
                  {draft.body.trim().length === 0 ? "No comment text yet." : draft.body}
                </p>
              </div>
              <div className="border-review-sidebar-divider flex gap-1 border-t p-2">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    code.selectPath(draft.path)
                    reviewComments.requestCodeDraftFocus()
                  }}
                >
                  <MessageSquareText /> Resume / Focus
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Discard code comment draft"
                  onClick={() => reviewComments.discardCodeDraft(draft)}
                >
                  <Trash2 />
                </Button>
              </div>
            </section>
          ),
        })}
      </div>
    </aside>
  )
}

/** Comments context pane selected for the active source surface. */
export const ReviewCommentsActivityPane = (props: ProjectActivityPaneProps) =>
  props.location.surface === "review" ? (
    <ReviewCommentsReviewContextPane {...props} />
  ) : (
    <ReviewCommentsCodeActivityPane {...props} />
  )

const CodeCommentAnnotation = () => {
  const reviewComments = useReviewCommentsState()
  const commentSubmission = useCommentSubmission()
  const draft = Option.getOrNull(reviewComments.codeDraft)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])
  useEffect(() => {
    if (draft === null) return
    Option.map(reviewComments.codeFocusRequest, (request) => {
      if (
        request.projectId !== draft.projectId ||
        request.workspaceRevision !== draft.workspaceRevision ||
        request.path !== draft.path ||
        request.lineNumber !== draft.lineNumber
      ) {
        return
      }
      textareaRef.current?.focus()
      reviewComments.completeCodeDraftFocus(request.id)
    })
  }, [draft, reviewComments])

  if (draft === null) return null
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const body = draft.body.trim()
    const revision = Option.getOrNull(draft.gitRevision)
    if (body.length === 0 || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      if (reviewComments.mode === "notes") {
        await reviewComments.createNote(
          CommentNoteSubject.cases.CodeLine.make({
            workspaceRevision: draft.workspaceRevision,
            gitRevision: revision,
            path: draft.path,
            lineNumber: draft.lineNumber,
            lineContent: draft.lineContent,
          }),
          body,
        )
      } else {
        if (revision === null) return
        await commentSubmission.submit(
          CommentSubmission.cases.Start.make({
            subject: CommentSubject.cases.CodeLine.make({
              projectId: draft.projectId,
              revision,
              path: draft.path,
              lineNumber: draft.lineNumber,
              lineContent: draft.lineContent,
            }),
            body: MarkdownBody.make(body),
          }),
        )
      }
      reviewComments.discardCodeDraft(draft)
    } catch (cause) {
      setError(formatError(cause, "Could not submit code comment"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="bg-diff-canvas px-3 py-1.5">
      {reviewComments.mode === "notes" ? (
        <CodeCommentForm
          draft={draft}
          submitting={submitting}
          error={error}
          textareaRef={textareaRef}
          submitLabel="Add note"
          onSubmit={submit}
        />
      ) : (
        CommentDestination.match(commentSubmission.destination, {
          DiffDash: () => (
            <div className="bg-card text-muted-foreground rounded-lg border px-3 py-2 text-xs shadow-xs">
              Code comments in DiffDash are not supported yet. Connect OpenCode to comment on code.
            </div>
          ),
          OpenCode: () =>
            Option.match(draft.gitRevision, {
              onNone: () => (
                <div className="bg-card text-muted-foreground rounded-lg border px-3 py-2 text-xs shadow-xs">
                  OpenCode comments require a committed Git revision.
                </div>
              ),
              onSome: () => (
                <CodeCommentForm
                  draft={draft}
                  submitting={submitting}
                  error={error}
                  textareaRef={textareaRef}
                  submitLabel="Send to OpenCode"
                  onSubmit={submit}
                />
              ),
            }),
        })
      )}
    </div>
  )
}

const CodeCommentForm = ({
  draft,
  submitting,
  error,
  textareaRef,
  submitLabel,
  onSubmit,
}: {
  readonly draft: CodeCommentDraft
  readonly submitting: boolean
  readonly error: string | null
  readonly textareaRef: React.RefObject<HTMLTextAreaElement | null>
  readonly submitLabel: string
  readonly onSubmit: (event: FormEvent) => void
}) => {
  const reviewComments = useReviewCommentsState()
  return (
    <form className="bg-card space-y-2 rounded-lg border p-3 shadow-xs" onSubmit={onSubmit}>
      <label className="block text-xs font-semibold">
        Comment on {draft.path} line {draft.lineNumber}
        <Textarea
          ref={textareaRef}
          aria-label="Code comment"
          className="mt-2 resize-none"
          placeholder="Write a Markdown comment"
          value={draft.body}
          onChange={(event) => reviewComments.updateCodeDraftBody(event.currentTarget.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
        />
      </label>
      {error === null ? null : (
        <p role="alert" className="text-destructive text-caption">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-1.5">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => reviewComments.discardCodeDraft(draft)}
        >
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={draft.body.trim().length === 0 || submitting}>
          {submitting ? <Loader2 className="animate-spin" /> : null}
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}

const CodeNoteAnnotation = ({ note }: { readonly note: CommentNote }) => {
  const reviewComments = useReviewCommentsState()
  return (
    <div className="bg-diff-canvas px-3 py-1.5">
      <div className="bg-card flex items-start gap-2 rounded-lg border p-3 text-xs shadow-xs">
        <p className="min-w-0 flex-1 whitespace-pre-wrap">{note.body}</p>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Remove note"
          onClick={() => void reviewComments.deleteNote(note.id)}
        >
          <X />
        </Button>
      </div>
    </div>
  )
}

const codeDraftMatchesSource = (
  draft: CodeCommentDraft,
  source: CodeSourceContributionProps["source"],
): boolean =>
  draft.projectId === source.projectId &&
  draft.workspaceRevision === source.workspaceRevision &&
  draft.path === source.path
