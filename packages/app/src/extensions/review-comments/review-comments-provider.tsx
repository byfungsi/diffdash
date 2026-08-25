import type { OpenCodeConnectionSelection } from "@diffdash/domain/comment"
import type { GitCommitSha } from "@diffdash/domain/repository-comparison"
import type { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import type { ReviewProjectId } from "@diffdash/domain/review-identity"
import type { ReviewRevision } from "@diffdash/domain/review-identity"
import type { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { Option } from "effect"
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import type {
  TrustedExtensionRegistrationToken,
  TrustedTitlebarActionProps,
} from "../extension-registry"
import { AIConnectionMenu } from "./ai-connection-menu"
import { CommentSubmissionProvider } from "./comment-submission"
import { ReviewCommentsReviewStateProvider } from "./review-comments-review-state"

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
  readonly connection: Option.Option<OpenCodeConnectionSelection>
  readonly codeDraft: Option.Option<CodeCommentDraft>
  readonly codeFocusRequest: Option.Option<CodeCommentFocusRequest>
  readonly toggleCodeDraft: (draft: Omit<CodeCommentDraft, "body">) => void
  readonly updateCodeDraftBody: (body: string) => void
  readonly discardCodeDraft: (expected?: Omit<CodeCommentDraft, "body">) => void
  readonly requestCodeDraftFocus: () => void
  readonly completeCodeDraftFocus: (requestId: number) => void
}

const ReviewCommentsStateContext = createContext<ReviewCommentsState | null>(null)

/** Owns project-scoped Review Comments destination state and submission routing. */
export const ReviewCommentsProvider = ({
  active,
  children,
  directory,
  projectId,
  registrationToken: _registrationToken,
}: {
  readonly active: boolean
  readonly children: ReactNode
  readonly directory: RepositoryCheckoutPath | null
  readonly projectId: ReviewProjectId | null
  readonly registrationToken: TrustedExtensionRegistrationToken
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
    <ReviewCommentsStateProvider
      connection={activeConnection}
      projectId={active ? projectId : null}
    >
      <ReviewCommentsReviewStateProvider>
        <ReviewCommentsConnectionContext value={activeConnection}>
          <ReviewCommentsDirectoryContext value={directory}>
            <ReviewCommentsConnectionChangeContext value={setConnection}>
              <CommentSubmissionProvider connection={activeConnection}>
                {children}
              </CommentSubmissionProvider>
            </ReviewCommentsConnectionChangeContext>
          </ReviewCommentsDirectoryContext>
        </ReviewCommentsConnectionContext>
      </ReviewCommentsReviewStateProvider>
    </ReviewCommentsStateProvider>
  )
}

/** Owns Review Comments UI state independently from privileged submission transport. */
export const ReviewCommentsStateProvider = ({
  children,
  connection,
  projectId,
}: {
  readonly children: ReactNode
  readonly connection: Option.Option<OpenCodeConnectionSelection>
  readonly projectId: ReviewProjectId | null
}) => {
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

  const value = useMemo<ReviewCommentsState>(
    () => ({
      connection,
      codeDraft: activeCodeDraft,
      codeFocusRequest,
      toggleCodeDraft,
      updateCodeDraftBody,
      discardCodeDraft,
      requestCodeDraftFocus,
      completeCodeDraftFocus,
    }),
    [
      activeCodeDraft,
      codeFocusRequest,
      completeCodeDraftFocus,
      connection,
      discardCodeDraft,
      requestCodeDraftFocus,
      toggleCodeDraft,
      updateCodeDraftBody,
    ],
  )
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
  if (onConnectionChange === null) throw new Error("ReviewCommentsProvider is unavailable")

  return (
    <AIConnectionMenu
      directory={directory}
      projectId={projectId}
      selected={connection}
      onChange={onConnectionChange}
    />
  )
}
