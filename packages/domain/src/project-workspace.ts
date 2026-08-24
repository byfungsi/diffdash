import { Schema } from "effect"

import { HostedRepositoryLocator } from "./git-provider"
import { Repo, RepositoryCheckoutPath } from "./repository"
import { ReviewProjectId } from "./review-identity"
import { ReviewThreadTarget } from "./review-thread"

/** Durable review selection restored when a project is reopened. */
export const ProjectWorkspaceReviewTarget = ReviewThreadTarget

/** Durable review selection restored when a project is reopened. */
export type ProjectWorkspaceReviewTarget = typeof ProjectWorkspaceReviewTarget.Type

/** Renderer-safe identity for one recognized named Git remote. */
export class ProjectRemoteCandidate extends Schema.Class<ProjectRemoteCandidate>(
  "ProjectRemoteCandidate",
)({
  remoteName: Schema.String,
  repository: HostedRepositoryLocator,
}) {}

/** Successful project opening with its canonical persisted repository. */
export class ProjectOpened extends Schema.TaggedClass<ProjectOpened>()("opened", {
  repo: Repo,
}) {}

/** Project opening that requires the user to choose between recognized remotes. */
export class ProjectRemoteSelectionRequired extends Schema.TaggedClass<ProjectRemoteSelectionRequired>()(
  "remoteSelectionRequired",
  {
    rootPath: RepositoryCheckoutPath,
    candidates: Schema.Array(ProjectRemoteCandidate).pipe(Schema.check(Schema.isMinLength(2))),
  },
) {}

/** Canonical result of opening a local project in the main process. */
export const ProjectOpenResult = Schema.Union([ProjectOpened, ProjectRemoteSelectionRequired]).pipe(
  Schema.toTaggedUnion("_tag"),
)

/** Canonical result of opening a local project in the main process. */
export type ProjectOpenResult = typeof ProjectOpenResult.Type

const projectWorkspaceActivityIdPattern = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){2,}$/u

/** Main source surface kept visible while project activities change. */
export const ProjectWorkspaceSurface = Schema.Literals(["review", "code"])

/** Main source surface kept visible while project activities change. */
export type ProjectWorkspaceSurface = typeof ProjectWorkspaceSurface.Type

/** Lowercase activity ID with 3+ dot segments and at most 128 ASCII identifier characters. */
export const ProjectWorkspaceActivityId = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(128)),
  Schema.check(
    Schema.makeFilter((value) => projectWorkspaceActivityIdPattern.test(value), {
      message: "Expected a namespaced project workspace activity ID",
    }),
  ),
  Schema.brand("ProjectWorkspaceActivityId"),
)

/** Lowercase activity ID with 3+ dot segments and at most 128 ASCII identifier characters. */
export type ProjectWorkspaceActivityId = typeof ProjectWorkspaceActivityId.Type

/** Stable activity identity for the built-in Reviews activity. */
export const PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID =
  ProjectWorkspaceActivityId.make("diffdash.core.reviews")

/** Stable activity identity for the built-in Files activity. */
export const PROJECT_WORKSPACE_FILES_ACTIVITY_ID =
  ProjectWorkspaceActivityId.make("diffdash.core.files")

/** Stable activity identity for the built-in Code activity. */
export const PROJECT_WORKSPACE_CODE_ACTIVITY_ID =
  ProjectWorkspaceActivityId.make("diffdash.core.code")

/** Stable activity identity for the built-in Walkthrough activity. */
export const PROJECT_WORKSPACE_WALKTHROUGH_ACTIVITY_ID = ProjectWorkspaceActivityId.make(
  "diffdash.core.walkthrough",
)

/** Stable activity identity persisted for the trusted Review Comments extension. */
export const REVIEW_COMMENTS_ACTIVITY_ID = ProjectWorkspaceActivityId.make(
  "diffdash.builtin.review-comments.comments",
)

/** Source-surface effect applied when a project workspace activity is selected. */
export const ProjectWorkspaceActivitySurfacePolicy = Schema.Literals(["review", "code", "preserve"])

/** Source-surface effect applied when a project workspace activity is selected. */
export type ProjectWorkspaceActivitySurfacePolicy =
  typeof ProjectWorkspaceActivitySurfacePolicy.Type

/** Active project source surface and activity selected independently. */
export interface ProjectWorkspaceActivitySelection {
  readonly activeSurface: ProjectWorkspaceSurface
  readonly activeActivity: ProjectWorkspaceActivityId
}

/** Result of resolving a persisted activity against currently registered contributions. */
export type ProjectWorkspaceActivityResolution =
  | {
      readonly _tag: "available"
      readonly selection: ProjectWorkspaceActivitySelection
    }
  | {
      readonly _tag: "repaired"
      readonly selection: ProjectWorkspaceActivitySelection
      readonly unavailableActivity: ProjectWorkspaceActivityId
    }
  | {
      readonly _tag: "unresolved"
      readonly selection: ProjectWorkspaceActivitySelection
      readonly unavailableActivity: ProjectWorkspaceActivityId
    }

/** Selects a project activity while applying its explicit source-surface policy. */
export const selectProjectWorkspaceActivity = (
  selection: ProjectWorkspaceActivitySelection,
  activeActivity: ProjectWorkspaceActivityId,
  surfacePolicy: ProjectWorkspaceActivitySurfacePolicy,
): ProjectWorkspaceActivitySelection => ({
  activeSurface: surfacePolicy === "preserve" ? selection.activeSurface : surfacePolicy,
  activeActivity,
})

/** Repairs an unavailable activity without changing the persisted source surface. */
export const resolveProjectWorkspaceActivity = (
  selection: ProjectWorkspaceActivitySelection,
  availableActivityIds: readonly ProjectWorkspaceActivityId[],
): ProjectWorkspaceActivityResolution => {
  if (availableActivityIds.includes(selection.activeActivity)) {
    return { _tag: "available", selection }
  }

  const fallbackActivity =
    selection.activeSurface === "code"
      ? availableActivityIds.find((activityId) => activityId === PROJECT_WORKSPACE_CODE_ACTIVITY_ID)
      : availableActivityIds.find(
          (activityId) =>
            activityId === PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID ||
            activityId === PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
        )

  if (fallbackActivity === undefined) {
    return {
      _tag: "unresolved",
      selection,
      unavailableActivity: selection.activeActivity,
    }
  }

  return {
    _tag: "repaired",
    selection: {
      activeSurface: selection.activeSurface,
      activeActivity: fallbackActivity,
    },
    unavailableActivity: selection.activeActivity,
  }
}

/** Durable user-controlled workspace state for one review project. */
export class ProjectWorkspaceStateInput extends Schema.Class<ProjectWorkspaceStateInput>(
  "ProjectWorkspaceStateInput",
)({
  projectId: ReviewProjectId,
  activeSurface: ProjectWorkspaceSurface,
  activeActivity: ProjectWorkspaceActivityId,
  selectedReviewTarget: Schema.NullOr(ProjectWorkspaceReviewTarget),
}) {}

/** Persisted workspace state returned with its last-write timestamp. */
export class ProjectWorkspaceState extends Schema.Class<ProjectWorkspaceState>(
  "ProjectWorkspaceState",
)({
  projectId: ReviewProjectId,
  activeSurface: ProjectWorkspaceSurface,
  activeActivity: ProjectWorkspaceActivityId,
  selectedReviewTarget: Schema.NullOr(ProjectWorkspaceReviewTarget),
  updatedAt: Schema.String,
}) {}
