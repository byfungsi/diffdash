import { ProjectWorkspaceActivityId } from "@diffdash/domain/project-workspace"

/** Stable persisted identity for the Reviews activity owned by this extension. */
export const PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID =
  ProjectWorkspaceActivityId.make("diffdash.core.reviews")

/** Stable persisted identity for the Files activity owned by this extension. */
export const PROJECT_WORKSPACE_FILES_ACTIVITY_ID =
  ProjectWorkspaceActivityId.make("diffdash.core.files")
