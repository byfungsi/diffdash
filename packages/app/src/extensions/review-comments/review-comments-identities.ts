import { ProjectWorkspaceActivityId } from "@diffdash/domain/project-workspace"

/** Stable persisted identity for the Comments activity owned by this extension. */
export const REVIEW_COMMENTS_ACTIVITY_ID = ProjectWorkspaceActivityId.make(
  "diffdash.builtin.review-comments.comments",
)
