import { Option, Schema } from "effect"

import { HostedRepositoryLocator } from "./git-provider"
import { Repo, RepositoryCheckoutPath } from "./repository"
import { ReviewProjectId } from "./review-identity"
import { utf8ByteLength } from "./utf8"

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
const MAX_PROJECT_WORKSPACE_NAVIGATION_LOCATION_BYTES = 1_048_576

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

/** Stable lowercase identity of the owner that encodes one durable project navigation location. */
export const ProjectWorkspaceNavigationContributionId = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(128)),
  Schema.check(
    Schema.makeFilter((value) => projectWorkspaceActivityIdPattern.test(value), {
      message: "Expected a namespaced project workspace navigation contribution ID",
    }),
  ),
  Schema.brand("ProjectWorkspaceNavigationContributionId"),
)

/** Stable lowercase identity of the owner that encodes one durable project navigation location. */
export type ProjectWorkspaceNavigationContributionId =
  typeof ProjectWorkspaceNavigationContributionId.Type

/** JSON-safe owner payload bounded to one MiB when serialized. */
export const ProjectWorkspaceNavigationLocation = Schema.Json.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) =>
        utf8ByteLength(JSON.stringify(value)) <= MAX_PROJECT_WORKSPACE_NAVIGATION_LOCATION_BYTES,
      { message: "Expected a project workspace navigation location no larger than one MiB" },
    ),
  ),
)

/** JSON-safe owner payload bounded to one MiB when serialized. */
export type ProjectWorkspaceNavigationLocation = typeof ProjectWorkspaceNavigationLocation.Type

/** Durable owner-opaque navigation envelope used to restore one exact project location. */
export class ProjectWorkspaceNavigationEnvelope extends Schema.Class<ProjectWorkspaceNavigationEnvelope>(
  "ProjectWorkspaceNavigationEnvelope",
)({
  contributionId: ProjectWorkspaceNavigationContributionId,
  location: ProjectWorkspaceNavigationLocation,
}) {}

/** Source-surface effect applied when a project workspace activity is selected. */
export const ProjectWorkspaceActivitySurfacePolicy = Schema.Literals(["review", "code", "preserve"])

/** Source-surface effect applied when a project workspace activity is selected. */
export type ProjectWorkspaceActivitySurfacePolicy =
  typeof ProjectWorkspaceActivitySurfacePolicy.Type

/** Active project source surface and activity selected independently. */
export class ProjectWorkspaceActivitySelection extends Schema.Class<ProjectWorkspaceActivitySelection>(
  "ProjectWorkspaceActivitySelection",
)({
  activeSurface: ProjectWorkspaceSurface,
  activeActivity: ProjectWorkspaceActivityId,
}) {}

/** Registered activity metadata required to validate and repair workspace selection. */
export class ProjectWorkspaceActivityAvailability extends Schema.Class<ProjectWorkspaceActivityAvailability>(
  "ProjectWorkspaceActivityAvailability",
)({
  id: ProjectWorkspaceActivityId,
  supportedSurfaces: Schema.Array(ProjectWorkspaceSurface),
  defaultForSurfaces: Schema.Array(ProjectWorkspaceSurface),
}) {}

/** Persisted project activity remains available on its saved source surface. */
export class AvailableProjectWorkspaceActivity extends Schema.TaggedClass<AvailableProjectWorkspaceActivity>()(
  "available",
  { selection: ProjectWorkspaceActivitySelection },
) {}

/** Persisted project activity was replaced by a registered fallback. */
export class RepairedProjectWorkspaceActivity extends Schema.TaggedClass<RepairedProjectWorkspaceActivity>()(
  "repaired",
  {
    selection: ProjectWorkspaceActivitySelection,
    unavailableActivity: ProjectWorkspaceActivityId,
  },
) {}

/** No registered activity can replace the unavailable persisted activity. */
export class UnresolvedProjectWorkspaceActivity extends Schema.TaggedClass<UnresolvedProjectWorkspaceActivity>()(
  "unresolved",
  { unavailableActivity: ProjectWorkspaceActivityId },
) {}

/** Result of resolving a persisted activity against currently registered contributions. */
export const ProjectWorkspaceActivityResolution = Schema.Union([
  AvailableProjectWorkspaceActivity,
  RepairedProjectWorkspaceActivity,
  UnresolvedProjectWorkspaceActivity,
]).pipe(Schema.toTaggedUnion("_tag"))

/** Result of resolving a persisted activity against currently registered contributions. */
export type ProjectWorkspaceActivityResolution = typeof ProjectWorkspaceActivityResolution.Type

/** Selects a project activity while applying its explicit source-surface policy. */
export const selectProjectWorkspaceActivity = (
  selection: ProjectWorkspaceActivitySelection,
  activeActivity: ProjectWorkspaceActivityId,
  surfacePolicy: ProjectWorkspaceActivitySurfacePolicy,
): ProjectWorkspaceActivitySelection =>
  ProjectWorkspaceActivitySelection.make({
    activeSurface: surfacePolicy === "preserve" ? selection.activeSurface : surfacePolicy,
    activeActivity,
  })

/** Repairs an unavailable activity without changing the persisted source surface. */
export const resolveProjectWorkspaceActivity = (
  selection: ProjectWorkspaceActivitySelection,
  availableActivities: readonly ProjectWorkspaceActivityAvailability[],
): ProjectWorkspaceActivityResolution => {
  const activeActivity = availableActivities.find(
    (activity) =>
      activity.id === selection.activeActivity &&
      activity.supportedSurfaces.includes(selection.activeSurface),
  )
  if (activeActivity !== undefined) {
    return AvailableProjectWorkspaceActivity.make({ selection })
  }

  const sameSurfaceDefault = availableActivities.find((activity) =>
    activity.defaultForSurfaces.includes(selection.activeSurface),
  )
  const globalDefault = availableActivities.find(
    (activity) => activity.defaultForSurfaces.length > 0,
  )
  const sameSurfaceActivity = availableActivities.find((activity) =>
    activity.supportedSurfaces.includes(selection.activeSurface),
  )
  const fallbackActivity =
    sameSurfaceDefault ?? globalDefault ?? sameSurfaceActivity ?? availableActivities[0]

  if (fallbackActivity === undefined) {
    return UnresolvedProjectWorkspaceActivity.make({
      unavailableActivity: selection.activeActivity,
    })
  }

  const fallbackSurface = Option.getOrElse(
    Option.fromNullishOr(
      fallbackActivity.defaultForSurfaces[0] ?? fallbackActivity.supportedSurfaces[0],
    ),
    () => selection.activeSurface,
  )
  return RepairedProjectWorkspaceActivity.make({
    selection: ProjectWorkspaceActivitySelection.make({
      activeSurface: fallbackSurface,
      activeActivity: fallbackActivity.id,
    }),
    unavailableActivity: selection.activeActivity,
  })
}

/** Durable user-controlled workspace state for one project. */
export class ProjectWorkspaceStateInput extends Schema.Class<ProjectWorkspaceStateInput>(
  "ProjectWorkspaceStateInput",
)({
  projectId: ReviewProjectId,
  activeSurface: ProjectWorkspaceSurface,
  activeActivity: ProjectWorkspaceActivityId,
  navigation: ProjectWorkspaceNavigationEnvelope,
}) {}

/** Persisted workspace state returned with its last-write timestamp. */
export class ProjectWorkspaceState extends Schema.Class<ProjectWorkspaceState>(
  "ProjectWorkspaceState",
)({
  projectId: ReviewProjectId,
  activeSurface: ProjectWorkspaceSurface,
  activeActivity: ProjectWorkspaceActivityId,
  navigation: ProjectWorkspaceNavigationEnvelope,
  updatedAt: Schema.String,
}) {}
