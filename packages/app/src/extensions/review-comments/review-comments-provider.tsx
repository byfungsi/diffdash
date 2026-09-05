import { AISettings } from "@diffdash/domain/ai-settings"
import type { OpenCodeConnectionSelection } from "@diffdash/domain/comment"
import {
  formatCommentNotes,
  type CommentMode,
  type CommentNote,
  type CommentNoteContext,
  type CommentNoteId,
  type CommentNoteSubject,
  commentNoteContextKey,
} from "@diffdash/domain/comment-note"
import type { GitCommitSha } from "@diffdash/domain/repository-comparison"
import type { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import type { ReviewProjectId } from "@diffdash/domain/review-identity"
import type { ReviewRevision } from "@diffdash/domain/review-identity"
import type { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import {
  ClearCommentNotesRequest,
  CreateCommentNoteRequest,
  DeleteCommentNoteRequest,
  ListCommentNotesRequest,
  SendCommentNotesRequest,
} from "@diffdash/protocol/comment-notes"
import { MarkdownBody } from "@diffdash/domain/review-thread"
import { Option } from "effect"
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  use,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react"

import type {
  TrustedExtensionRegistrationToken,
  TrustedTitlebarActionProps,
} from "../extension-registry"
import { AIConnectionMenu } from "./ai-connection-menu"
import { CommentSubmissionProvider } from "./comment-submission"
import {
  ReviewCommentsReviewStateProvider,
  useReviewCommentsReviewState,
} from "./review-comments-review-state"
import { runRendererPromise, useCommentNotes } from "@/platform/renderer-runtime"
import type { CommentNotesOperations } from "@/platform/comment-notes"
import { useSettingsMutation } from "@/settings/use-settings-mutation"
import { Button } from "@/shared/ui/button"
import { ChevronDown, Copy, Loader2, Send } from "lucide-react"
import { DropdownMenu } from "radix-ui"
import { formatError } from "@/shared/errors"
import { isEditableTarget } from "@/shared/dom"
import { useKeyboardShortcut } from "@/shell/keyboard-shortcuts"

const ReviewCommentsConnectionContext = createContext(Option.none<OpenCodeConnectionSelection>())
const ReviewCommentsDirectoryContext = createContext<RepositoryCheckoutPath | null>(null)
const ReviewCommentsConnectionChangeContext = createContext<Dispatch<
  SetStateAction<Option.Option<OpenCodeConnectionSelection>>
> | null>(null)

/** Project-scoped Code comment draft retained while source surfaces change. */
export interface CodeCommentDraft {
  readonly projectId: ReviewProjectId
  readonly workspaceRevision: ReviewRevision
  readonly gitRevision: Option.Option<GitCommitSha>
  readonly path: RepositoryRelativePath
  readonly lineNumber: number
  readonly lineContent: string
  readonly body: string
}

interface CodeCommentFocusRequest {
  readonly id: number
  readonly projectId: ReviewProjectId
  readonly workspaceRevision: ReviewRevision
  readonly path: RepositoryRelativePath
  readonly lineNumber: number
}

/** State and actions owned by the Review Comments renderer extension. */
export interface ReviewCommentsState {
  readonly mode: CommentMode
  readonly notes: readonly CommentNote[]
  readonly notesLoading: boolean
  readonly notesError: string | null
  readonly connection: Option.Option<OpenCodeConnectionSelection>
  readonly codeDraft: Option.Option<CodeCommentDraft>
  readonly codeFocusRequest: Option.Option<CodeCommentFocusRequest>
  readonly toggleCodeDraft: (draft: Omit<CodeCommentDraft, "body">) => void
  readonly updateCodeDraftBody: (body: string) => void
  readonly discardCodeDraft: (expected?: Omit<CodeCommentDraft, "body">) => void
  readonly requestCodeDraftFocus: () => void
  readonly completeCodeDraftFocus: (requestId: number) => void
  readonly createNote: (subject: CommentNoteSubject, body: string) => Promise<CommentNote>
  readonly deleteNote: (noteId: CommentNoteId) => Promise<void>
  readonly clearNotes: () => Promise<void>
  readonly sendNotes: () => Promise<void>
  readonly copyNotes: () => Promise<void>
  readonly changeMode: (mode: CommentMode) => void
}

const ReviewCommentsStateContext = createContext<ReviewCommentsState | null>(null)

/** Owns project-scoped Review Comments destination state and submission routing. */
export const ReviewCommentsProvider = ({
  active,
  children,
  directory,
  projectId,
  registrationToken: _registrationToken,
  fixedMode,
}: {
  readonly active: boolean
  readonly children: ReactNode
  readonly directory: RepositoryCheckoutPath | null
  readonly projectId: ReviewProjectId | null
  readonly registrationToken: TrustedExtensionRegistrationToken
  readonly fixedMode?: CommentMode
}) => {
  const [connection, setConnection] = useState(Option.none<OpenCodeConnectionSelection>())
  const activeConnection = Option.filter(
    connection,
    (selected) => active && projectId !== null && selected.projectId === projectId,
  )

  useEffect(() => {
    setConnection((current) =>
      Option.filter(
        current,
        (selected) => active && projectId !== null && selected.projectId === projectId,
      ),
    )
  }, [active, projectId])

  return (
    <ReviewCommentsReviewStateProvider>
      <ReviewCommentsStateProvider
        connection={activeConnection}
        projectId={active ? projectId : null}
        fixedMode={fixedMode}
      >
        <ReviewCommentsConnectionContext value={activeConnection}>
          <ReviewCommentsDirectoryContext value={directory}>
            <ReviewCommentsConnectionChangeContext value={setConnection}>
              <CommentSubmissionProvider connection={activeConnection}>
                {children}
              </CommentSubmissionProvider>
            </ReviewCommentsConnectionChangeContext>
          </ReviewCommentsDirectoryContext>
        </ReviewCommentsConnectionContext>
      </ReviewCommentsStateProvider>
    </ReviewCommentsReviewStateProvider>
  )
}

/** Owns Review Comments UI state independently from privileged submission transport. */
export const ReviewCommentsStateProvider = ({
  children,
  connection,
  projectId,
  fixedMode,
}: {
  readonly children: ReactNode
  readonly connection: Option.Option<OpenCodeConnectionSelection>
  readonly projectId: ReviewProjectId | null
  readonly fixedMode?: CommentMode | undefined
}) => {
  const commentNotes = useCommentNotes()
  const reviewState = useReviewCommentsReviewState()
  const settingsMutation = useSettingsMutation()
  return (
    <ReviewCommentsStateControllerProvider
      commentNotes={commentNotes}
      connection={connection}
      mode={fixedMode ?? settingsMutation.settings.commentMode}
      noteContext={reviewState.commentNoteContext}
      projectId={projectId}
      onModeChange={(nextMode) =>
        fixedMode !== undefined
          ? Promise.resolve()
          : settingsMutation
              .update((current) => AISettings.make({ ...current, commentMode: nextMode }))
              .then(() => undefined)
      }
    >
      {children}
    </ReviewCommentsStateControllerProvider>
  )
}

/** Owns Review Comments state with explicit dependencies for isolated surface composition. */
export const ReviewCommentsStateControllerProvider = ({
  children,
  commentNotes,
  connection,
  mode,
  noteContext,
  projectId,
  onModeChange,
}: {
  readonly children: ReactNode
  readonly commentNotes: CommentNotesOperations
  readonly connection: Option.Option<OpenCodeConnectionSelection>
  readonly mode: CommentMode
  readonly noteContext: CommentNoteContext
  readonly projectId: ReviewProjectId | null
  readonly onModeChange: (mode: CommentMode) => Promise<void>
}) => {
  const activeNoteContext = noteContext
  const activeNoteContextKey = commentNoteContextKey(activeNoteContext)
  const activeCollectionIdentity =
    projectId === null ? null : `${projectId}\u0000${activeNoteContextKey}`
  const [notes, setNotes] = useState<readonly CommentNote[]>([])
  const [notesLoading, setNotesLoading] = useState(false)
  const [notesError, setNotesError] = useState<string | null>(null)
  const collectionIdentityRef = useRef(activeCollectionIdentity)
  collectionIdentityRef.current = activeCollectionIdentity
  const noteLoadSequence = useRef(0)
  const noteMutationTail = useRef(Promise.resolve())
  const [codeDraft, setCodeDraft] = useState<Option.Option<CodeCommentDraft>>(Option.none())
  const [codeFocusRequest, setCodeFocusRequest] = useState<Option.Option<CodeCommentFocusRequest>>(
    Option.none(),
  )
  const focusSequence = useRef(0)
  const activeCodeDraft = Option.filter(
    codeDraft,
    (draft) => projectId !== null && draft.projectId === projectId,
  )
  const codeDraftRef = useRef(activeCodeDraft)
  codeDraftRef.current = activeCodeDraft

  useEffect(() => {
    setCodeDraft((current) =>
      Option.filter(current, (draft) => projectId !== null && draft.projectId === projectId),
    )
    setCodeFocusRequest(Option.none())
  }, [projectId])
  const invalidateNoteLoad = () => {
    noteLoadSequence.current += 1
    setNotesLoading(false)
  }
  const enqueueNoteMutation = <Value,>(operation: () => Promise<Value>): Promise<Value> => {
    const result = noteMutationTail.current.then(operation, operation)
    noteMutationTail.current = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  const loadNotes = useEffectEvent(
    async (activeProjectId: ReviewProjectId, context: CommentNoteContext, identity: string) => {
      const loadSequence = ++noteLoadSequence.current
      setNotesLoading(true)
      setNotesError(null)
      try {
        const loaded = await runRendererPromise(
          commentNotes.list(ListCommentNotesRequest.make({ projectId: activeProjectId, context })),
        )
        if (collectionIdentityRef.current === identity) setNotes(loaded)
      } catch (cause) {
        if (noteLoadSequence.current === loadSequence) {
          setNotesError(formatError(cause, "Could not load notes"))
        }
      } finally {
        if (noteLoadSequence.current === loadSequence) setNotesLoading(false)
      }
    },
  )
  useEffect(() => {
    noteLoadSequence.current += 1
    setNotes([])
    setNotesLoading(false)
    setNotesError(null)
    if (projectId !== null && activeCollectionIdentity !== null) {
      void loadNotes(projectId, activeNoteContext, activeCollectionIdentity)
    }
  }, [activeCollectionIdentity, activeNoteContext, projectId])

  const toggleCodeDraft = useCallback((draft: Omit<CodeCommentDraft, "body">) => {
    setCodeDraft((current) =>
      Option.exists(current, (candidate) => sameCodeCommentTarget(candidate, draft))
        ? Option.none()
        : Option.some({ ...draft, body: "" }),
    )
    setCodeFocusRequest(Option.none())
  }, [])
  const updateCodeDraftBody = useCallback((body: string) => {
    setCodeDraft((current) => Option.map(current, (draft) => ({ ...draft, body })))
  }, [])
  const discardCodeDraft = useCallback((expected?: Omit<CodeCommentDraft, "body">) => {
    setCodeDraft((current) =>
      expected === undefined ||
      Option.exists(current, (draft) => sameCodeCommentTarget(draft, expected))
        ? Option.none()
        : current,
    )
    setCodeFocusRequest(Option.none())
  }, [])
  const requestCodeDraftFocus = useCallback(() => {
    Option.map(codeDraftRef.current, (draft) => {
      focusSequence.current += 1
      setCodeFocusRequest(
        Option.some({
          id: focusSequence.current,
          projectId: draft.projectId,
          workspaceRevision: draft.workspaceRevision,
          path: draft.path,
          lineNumber: draft.lineNumber,
        }),
      )
    })
  }, [])
  const completeCodeDraftFocus = useCallback((requestId: number) => {
    setCodeFocusRequest((current) => Option.filter(current, (request) => request.id !== requestId))
  }, [])
  const createNote = (subject: CommentNoteSubject, body: string): Promise<CommentNote> => {
    if (projectId === null) throw new Error("A project is required to create a note")
    invalidateNoteLoad()
    return enqueueNoteMutation(async () => {
      try {
        const created = await runRendererPromise(
          commentNotes.create(
            CreateCommentNoteRequest.make({
              projectId,
              context: activeNoteContext,
              subject,
              body: MarkdownBody.make(body.trim()),
            }),
          ),
        )
        if (collectionIdentityRef.current === activeCollectionIdentity) {
          setNotes((current) => [...current, created])
        }
        setNotesError(null)
        return created
      } catch (cause) {
        setNotesError(formatError(cause, "Could not create note"))
        throw cause
      }
    })
  }
  const deleteNote = (noteId: CommentNoteId): Promise<void> => {
    if (projectId === null) return Promise.resolve()
    invalidateNoteLoad()
    return enqueueNoteMutation(async () => {
      try {
        await runRendererPromise(
          commentNotes.delete(
            DeleteCommentNoteRequest.make({
              projectId,
              context: activeNoteContext,
              noteId,
            }),
          ),
        )
        if (collectionIdentityRef.current === activeCollectionIdentity) {
          setNotes((current) => current.filter((note) => note.id !== noteId))
        }
        setNotesError(null)
      } catch (cause) {
        setNotesError(formatError(cause, "Could not remove note"))
      }
    })
  }
  const clearNotes = (): Promise<void> => {
    if (projectId === null) return Promise.resolve()
    invalidateNoteLoad()
    return enqueueNoteMutation(async () => {
      try {
        await runRendererPromise(
          commentNotes.clear(
            ClearCommentNotesRequest.make({ projectId, context: activeNoteContext }),
          ),
        )
        if (collectionIdentityRef.current === activeCollectionIdentity) setNotes([])
        setNotesError(null)
      } catch (cause) {
        setNotesError(formatError(cause, "Could not clear notes"))
      }
    })
  }
  const sendNotes = (): Promise<void> => {
    if (projectId === null || Option.isNone(connection) || notes.length === 0) {
      return Promise.resolve()
    }
    const selectedConnection = connection.value
    invalidateNoteLoad()
    return enqueueNoteMutation(async () => {
      try {
        await runRendererPromise(
          commentNotes.send(
            SendCommentNotesRequest.make({
              projectId,
              context: activeNoteContext,
              connection: selectedConnection,
            }),
          ),
        )
        const remaining = await runRendererPromise(
          commentNotes.list(
            ListCommentNotesRequest.make({ projectId, context: activeNoteContext }),
          ),
        )
        if (collectionIdentityRef.current === activeCollectionIdentity) {
          setNotes(remaining)
        }
        setNotesError(null)
      } catch (cause) {
        setNotesError(formatError(cause, "Could not send notes"))
        throw cause
      }
    })
  }
  const copyNotes = async () => {
    try {
      await navigator.clipboard.writeText(formatCommentNotes(notes))
      setNotesError(null)
    } catch (cause) {
      setNotesError(formatError(cause, "Could not copy notes"))
      throw cause
    }
  }
  const changeMode = (nextMode: CommentMode) => {
    void onModeChange(nextMode).catch((cause) =>
      setNotesError(formatError(cause, "Could not change comment mode")),
    )
  }

  const value: ReviewCommentsState = {
    connection,
    mode,
    notes,
    notesLoading,
    notesError,
    codeDraft: activeCodeDraft,
    codeFocusRequest,
    toggleCodeDraft,
    updateCodeDraftBody,
    discardCodeDraft,
    requestCodeDraftFocus,
    completeCodeDraftFocus,
    createNote,
    deleteNote,
    clearNotes,
    sendNotes,
    copyNotes,
    changeMode,
  }
  return <ReviewCommentsStateContext value={value}>{children}</ReviewCommentsStateContext>
}

/** Returns the project-scoped state owned by the Review Comments extension. */
export const useReviewCommentsState = (): ReviewCommentsState => {
  const state = use(ReviewCommentsStateContext)
  if (state === null) throw new Error("ReviewCommentsStateProvider is unavailable")
  return state
}

const sameCodeCommentTarget = (
  left: Omit<CodeCommentDraft, "body">,
  right: Omit<CodeCommentDraft, "body">,
): boolean =>
  left.projectId === right.projectId &&
  left.workspaceRevision === right.workspaceRevision &&
  left.path === right.path &&
  left.lineNumber === right.lineNumber

/** Review Comments titlebar contribution for selecting the active comment destination. */
export const ReviewCommentsConnectionAction = ({ projectId }: TrustedTitlebarActionProps) => {
  const connection = use(ReviewCommentsConnectionContext)
  const directory = use(ReviewCommentsDirectoryContext)
  const onConnectionChange = use(ReviewCommentsConnectionChangeContext)
  const reviewComments = useReviewCommentsState()
  const [running, setRunning] = useState(false)
  const runningRef = useRef(false)
  if (onConnectionChange === null) throw new Error("ReviewCommentsProvider is unavailable")

  const runPrimary = async () => {
    if (runningRef.current || reviewComments.notes.length === 0) return
    runningRef.current = true
    setRunning(true)
    try {
      if (Option.isSome(connection)) await reviewComments.sendNotes()
      else await reviewComments.copyNotes()
    } catch {
      // The provider exposes the actionable failure in the Notes pane.
    } finally {
      runningRef.current = false
      setRunning(false)
    }
  }
  useKeyboardShortcut("comments.sendNotes", () => void runPrimary(), {
    enabled:
      reviewComments.mode === "notes" &&
      reviewComments.notes.length > 0 &&
      Option.isSome(connection),
    when: (event) => !isEditableTarget(event.target),
  })

  return (
    <div className="flex items-center gap-1">
      {reviewComments.mode === "notes" ? (
        <div className="flex items-center">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="rounded-r-none"
            disabled={reviewComments.notes.length === 0 || running}
            onClick={() => void runPrimary()}
          >
            {running ? (
              <Loader2 className="animate-spin" />
            ) : Option.isSome(connection) ? (
              <Send />
            ) : (
              <Copy />
            )}
            {Option.isSome(connection) ? "Send to OpenCode" : "Copy notes"}
            {reviewComments.notes.length > 0 ? ` (${String(reviewComments.notes.length)})` : ""}
          </Button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="rounded-l-none"
                aria-label="Note actions"
              >
                <ChevronDown />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={6}
                className="bg-popover text-popover-foreground z-50 min-w-44 rounded-xl border p-1 shadow-xl"
              >
                <DropdownMenu.Item
                  disabled={reviewComments.notes.length === 0}
                  className="data-[highlighted]:bg-accent rounded-lg px-2.5 py-2 text-xs outline-none"
                  onSelect={() => {
                    if (window.confirm("Clear all collected notes?"))
                      void reviewComments.clearNotes()
                  }}
                >
                  Clear notes
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      ) : null}
      <AIConnectionMenu
        directory={directory}
        mode={reviewComments.mode}
        projectId={projectId}
        selected={connection}
        onModeChange={reviewComments.changeMode}
        onChange={onConnectionChange}
      />
    </div>
  )
}
