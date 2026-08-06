import { Schema } from "effect"

import { HostedRepositoryLocator } from "./git-provider"
import { Repo } from "./repository"
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
    rootPath: Schema.String,
    candidates: Schema.Array(ProjectRemoteCandidate).pipe(Schema.minItems(2)),
  },
) {}

/** Canonical result of opening a local project in the main process. */
export const ProjectOpenResult = Schema.Union(ProjectOpened, ProjectRemoteSelectionRequired)

/** Canonical result of opening a local project in the main process. */
export type ProjectOpenResult = typeof ProjectOpenResult.Type

/** Top-level project workspace section selected by the user. */
export const ProjectWorkspaceRibbon = Schema.Literal("reviews", "files", "walkthrough", "threads")

/** Top-level project workspace section selected by the user. */
export type ProjectWorkspaceRibbon = typeof ProjectWorkspaceRibbon.Type

/** Durable user-controlled workspace state for one review project. */
export class ProjectWorkspaceStateInput extends Schema.Class<ProjectWorkspaceStateInput>(
  "ProjectWorkspaceStateInput",
)({
  projectId: ReviewProjectId,
  activeRibbon: ProjectWorkspaceRibbon,
  selectedReviewTarget: Schema.NullOr(ProjectWorkspaceReviewTarget),
}) {}

/** Persisted workspace state returned with its last-write timestamp. */
export class ProjectWorkspaceState extends Schema.Class<ProjectWorkspaceState>(
  "ProjectWorkspaceState",
)({
  projectId: ReviewProjectId,
  activeRibbon: ProjectWorkspaceRibbon,
  selectedReviewTarget: Schema.NullOr(ProjectWorkspaceReviewTarget),
  updatedAt: Schema.String,
}) {}
