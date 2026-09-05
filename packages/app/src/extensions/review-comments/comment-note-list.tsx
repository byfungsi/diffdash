import { CommentNoteSubject, type CommentNote } from "@diffdash/domain/comment-note"
import { LanguagePosition, LanguageRange } from "@diffdash/domain/language"
import { Option } from "effect"
import { Check, Copy, Trash2, X } from "lucide-react"
import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/shared/ui/dialog"

import { Button } from "@/shared/ui/button"
import { EmptyState } from "@/shared/ui/empty-state"
import { useReviewCommentsState } from "./review-comments-provider"
import { useProjectSurfaceRuntime } from "../project-surface-runtime"
import { useTrustedExtensionRegistry } from "../extension-registry-context"
import { createCodeFileNavigationState } from "../code/code-navigation"
import { encodeReviewNavigationState } from "../review/review-navigation"
import { REVIEW_COMMENTS_ACTIVITY_ID } from "./review-comments-identities"

/** Shared Notes-mode ribbon list used by Code and Review surfaces. */
export const CommentNoteList = ({
  isStale,
  onNavigate,
}: {
  readonly isStale: (note: CommentNote) => boolean
  readonly onNavigate: (note: CommentNote) => void
}) => {
  const comments = useReviewCommentsState()
  const [clearOpen, setClearOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const host = useProjectSurfaceRuntime()
  const { projectNavigation } = useTrustedExtensionRegistry()
  const navigate = (note: CommentNote) => {
    const surface = CommentNoteSubject.match(note.subject, {
      CodeLine: () => "code" as const,
      ReviewLine: () => "review" as const,
    })
    if (surface === host.activeSurface) {
      onNavigate(note)
      return
    }
    const contribution = projectNavigation.find((candidate) => candidate.surface === surface)
    if (contribution === undefined) return
    const state = CommentNoteSubject.match(note.subject, {
      CodeLine: ({ path, lineNumber }) => {
        const line = Math.max(0, lineNumber - 1)
        return createCodeFileNavigationState({
          projectId: note.projectId,
          path,
          revealRange: Option.some(
            LanguageRange.make({
              start: LanguagePosition.make({ line, character: 0 }),
              end: LanguagePosition.make({ line, character: 0 }),
            }),
          ),
        })
      },
      ReviewLine: ({ target }) => {
        const selectedReview =
          target.kind === "hosted"
            ? target
            : target.kind === "local"
              ? { kind: "localDiff" as const, target }
              : { kind: "repositoryComparison" as const, target }
        return encodeReviewNavigationState({ selectedReview: Option.some(selectedReview) })
      },
    })
    host.navigate(contribution, REVIEW_COMMENTS_ACTIVITY_ID, state)
  }
  return (
    <aside className="bg-review-sidebar text-review-sidebar-fg flex h-full min-h-0 flex-col">
      <header className="border-review-sidebar-divider flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <h2 className="text-caption min-w-0 flex-1 font-semibold tracking-wide uppercase">Notes</h2>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Copy all notes"
          title={copied ? "Copied" : "Copy all notes"}
          disabled={comments.notesLoading || comments.notes.length === 0}
          onClick={() => {
            setCopied(false)
            void comments.copyNotes().then(
              () => setCopied(true),
              () => undefined,
            )
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
        <output className="sr-only">{copied ? "Notes copied to clipboard" : ""}</output>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Clear all notes"
          disabled={comments.notes.length === 0}
          onClick={() => {
            setClearOpen(true)
          }}
        >
          <Trash2 />
        </Button>
      </header>
      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent>
          <DialogTitle>Clear collected notes?</DialogTitle>
          <DialogDescription>
            This removes notes in the current collection from this device. Copy them first if you
            want to keep them.
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                void comments.clearNotes().then(() => setClearOpen(false))
              }}
            >
              Clear notes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {comments.notesError === null ? null : (
        <p
          role="alert"
          className="text-destructive border-review-sidebar-divider border-b p-3 text-xs"
        >
          {comments.notesError}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {comments.notesLoading ? (
          <p className="text-review-sidebar-muted p-3 text-xs">Loading notes...</p>
        ) : null}
        {!comments.notesLoading && comments.notes.length === 0 ? (
          <EmptyState className="m-2 p-5 text-xs">
            Select a source line to collect a note.
          </EmptyState>
        ) : null}
        {comments.notes.map((note) => {
          const location = CommentNoteSubject.match(note.subject, {
            CodeLine: ({ path, lineNumber }) => `${path}:${String(lineNumber)}`,
            ReviewLine: ({ anchor }) => `${anchor.filePath}:${String(anchor.lineNumber)}`,
          })
          const stale = isStale(note)
          return (
            <div
              key={note.id}
              className="border-review-sidebar-divider flex items-stretch border-b"
            >
              <button
                type="button"
                className="hover:bg-review-sidebar-control-hover min-w-0 flex-1 px-3 py-2.5 text-left"
                onClick={() => navigate(note)}
              >
                <span className="flex items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate font-mono">{location}</span>
                  {stale ? <span className="text-review-sidebar-muted shrink-0">Stale</span> : null}
                </span>
                <span className="text-review-sidebar-muted mt-1 block line-clamp-2 whitespace-pre-wrap text-caption">
                  {note.body}
                </span>
              </button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="m-2 shrink-0"
                aria-label={`Remove note at ${location}`}
                onClick={() => void comments.deleteNote(note.id)}
              >
                <X />
              </Button>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
