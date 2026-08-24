import {
  CommentDestination,
  type CommentSubmission,
  type CommentSubmissionReceipt,
  CommentSubmissionUnavailableError,
} from "@diffdash/domain/comment"
import { Effect } from "effect"
import { createContext, use } from "react"

/** Active project comment destination and submission operation. */
export interface CommentSubmissionContextValue {
  readonly destination: typeof CommentDestination.Type
  readonly submit: (submission: CommentSubmission) => Promise<CommentSubmissionReceipt>
}

/** Project-scoped comment submission context shared by source surfaces. */
export const CommentSubmissionContext = createContext<CommentSubmissionContextValue>({
  destination: CommentDestination.cases.DiffDash.make({}),
  submit: () => Effect.runPromise(Effect.fail(CommentSubmissionUnavailableError.make({}))),
})

/** Returns the active destination and exclusive external forwarding operation. */
export const useCommentSubmission = (): CommentSubmissionContextValue =>
  use(CommentSubmissionContext)
