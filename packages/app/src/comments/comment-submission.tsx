import {
  CommentDestination,
  type CommentSubmission,
  type OpenCodeConnectionSelection,
} from "@diffdash/domain/comment"
import { SubmitCommentRequest } from "@diffdash/protocol/ai-connection"
import { Option } from "effect"
import { type ReactNode, useMemo } from "react"

import { runRendererPromise, useDesktopRuntime } from "@/platform/renderer-runtime"
import {
  CommentSubmissionContext,
  type CommentSubmissionContextValue,
} from "./comment-submission-context"

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
