import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react"
import { Badge } from "@/shared/ui/badge"

/** Provider review state badge using semantic PR status colors. */
export const PullRequestStateBadge = ({
  isDraft,
  state,
  className = "",
}: {
  readonly isDraft: boolean
  readonly state: string
  readonly className?: string
}) => {
  if (isDraft) {
    return (
      <Badge variant="ghost" className={`${className} bg-pr-draft text-pr-status-fg`}>
        <GitPullRequestDraft />
        Draft
      </Badge>
    )
  }
  const normalizedState = state.toUpperCase()
  if (normalizedState === "OPEN") {
    return (
      <Badge variant="ghost" className={`${className} bg-pr-open text-pr-status-fg`}>
        <GitPullRequest />
        Open
      </Badge>
    )
  }
  if (normalizedState === "MERGED") {
    return (
      <Badge variant="ghost" className={`${className} bg-pr-merged text-pr-status-fg`}>
        <GitMerge />
        Merged
      </Badge>
    )
  }
  if (normalizedState === "CLOSED") {
    return (
      <Badge variant="ghost" className={`${className} bg-pr-closed text-pr-status-fg`}>
        <GitPullRequestClosed />
        Closed
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className={className}>
      {state}
    </Badge>
  )
}
