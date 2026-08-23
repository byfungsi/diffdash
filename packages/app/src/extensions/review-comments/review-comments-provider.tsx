import type { OpenCodeConnectionSelection } from "@diffdash/domain/comment"
import type { ReviewProjectId } from "@diffdash/domain/review-identity"
import type { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { Option } from "effect"
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  use,
  useEffect,
  useState,
} from "react"

import type { TrustedTitlebarActionProps } from "../extension-registry"
import { AIConnectionMenu } from "./ai-connection-menu"
import { CommentSubmissionProvider } from "./comment-submission"

const ReviewCommentsConnectionContext = createContext(Option.none<OpenCodeConnectionSelection>())
const ReviewCommentsDirectoryContext = createContext<RepositoryCheckoutPath | null>(null)
const ReviewCommentsConnectionChangeContext = createContext<Dispatch<
  SetStateAction<Option.Option<OpenCodeConnectionSelection>>
> | null>(null)

/** Owns project-scoped Review Comments destination state and submission routing. */
export const ReviewCommentsProvider = ({
  children,
  directory,
  projectId,
}: {
  readonly children: ReactNode
  readonly directory: RepositoryCheckoutPath | null
  readonly projectId: ReviewProjectId | null
}) => {
  const [connection, setConnection] = useState(Option.none<OpenCodeConnectionSelection>())
  const activeConnection = Option.filter(
    connection,
    (selected) => projectId !== null && selected.projectId === projectId,
  )

  useEffect(() => {
    setConnection((current) =>
      Option.filter(current, (selected) => projectId !== null && selected.projectId === projectId),
    )
  }, [projectId])

  return (
    <ReviewCommentsConnectionContext value={activeConnection}>
      <ReviewCommentsDirectoryContext value={directory}>
        <ReviewCommentsConnectionChangeContext value={setConnection}>
          <CommentSubmissionProvider connection={activeConnection}>
            {children}
          </CommentSubmissionProvider>
        </ReviewCommentsConnectionChangeContext>
      </ReviewCommentsDirectoryContext>
    </ReviewCommentsConnectionContext>
  )
}

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
