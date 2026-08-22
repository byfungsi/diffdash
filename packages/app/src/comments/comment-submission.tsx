import {
  CommentDestination,
  type CommentSubmission,
  type CommentSubmissionReceipt,
  CommentSubmissionUnavailableError,
  type OpenCodeConnectionSelection,
} from "@diffdash/domain/comment"
import { SubmitCommentRequest } from "@diffdash/protocol/ai-connection"
import { Effect, Option } from "effect"
import { createContext, type ReactNode, use, useMemo } from "react"

import { runRendererPromise, useDesktopRuntime } from "@/platform/renderer-runtime"
interface CommentSubmissionContextValue {
  readonly destination: typeof CommentDestination.Type
  readonly submit: (submission: CommentSubmission) => Promise<CommentSubmissionReceipt>
}

const CommentSubmissionContext = createContext<CommentSubmissionContextValue>({
  destination: CommentDestination.cases.DiffDash.make({}),
  submit: () => Effect.runPromise(Effect.fail(CommentSubmissionUnavailableError.make({}))),
})

/** Project-scoped comment destination shared by diff and code surfaces. */
export const CommentSubmissionProvider = ({
  connection,
  children,
}: {
  readonly connection: Option.Option<OpenCodeConnectionSelection>
  readonly children: ReactNode
}) => {
  const desktop = useDesktopRuntime()
  const value = useMemo<CommentSubmissionContextValue>(() => {
    const destination: typeof CommentDestination.Type = Option.match(connection, {
      onNone: () => CommentDestination.cases.DiffDash.make({}),
      onSome: (selected) => CommentDestination.cases.OpenCode.make({ connection: selected }),
    })
    const submit = (submission: CommentSubmission) => {
      return runRendererPromise(
        desktop.ai.submitComment(SubmitCommentRequest.make({ destination, submission })),
      )
    }
    return { destination, submit }
  }, [connection, desktop])

  return <CommentSubmissionContext value={value}>{children}</CommentSubmissionContext>
}

/** Returns the active destination and exclusive external forwarding operation. */
export const useCommentSubmission = (): CommentSubmissionContextValue =>
  use(CommentSubmissionContext)
