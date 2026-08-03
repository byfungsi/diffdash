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
      <Badge
        variant="ghost"
        className={`${className} border-pr-draft/30 bg-pr-draft/15 text-muted-foreground border`}
      >
        <GitPullRequestDraft />
        Draft
      </Badge>
    )
  }
  const normalizedState = state.toUpperCase()
  if (normalizedState === "OPEN") {
    return (
      <Badge
        variant="ghost"
        className={`${className} border-pr-open/30 bg-pr-open/15 text-pr-open border`}
      >
        <GitPullRequest />
        Open
      </Badge>
    )
  }
  if (normalizedState === "MERGED") {
    return (
      <Badge
        variant="ghost"
        className={`${className} border-pr-merged/30 bg-pr-merged/15 text-pr-merged border`}
      >
        <GitMerge />
        Merged
      </Badge>
    )
  }
  if (normalizedState === "CLOSED") {
    return (
      <Badge
        variant="ghost"
        className={`${className} border-pr-closed/30 bg-pr-closed/15 text-pr-closed border`}
      >
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
