import {
  ProjectWorkspaceActivityResolution,
  ProjectWorkspaceActivitySelection,
  type ProjectWorkspaceActivityAvailability,
  ProjectWorkspaceNavigationContributionId,
  ProjectWorkspaceNavigationLocation,
  ProjectWorkspaceState,
  ProjectWorkspaceSurface,
  resolveProjectWorkspaceActivity,
} from "@diffdash/domain/project-workspace"
import type { Repo } from "@diffdash/domain/repository"
import { Option, Result, Schema } from "effect"

import type { ProjectNavigationContribution } from "@/extensions/extension-registry"

/** Registered owner-neutral navigation codec data used to validate or repair durable state. */
export interface ProjectWorkspaceNavigationAvailability {
  readonly id: ProjectWorkspaceNavigationContributionId
  readonly surface: typeof ProjectWorkspaceSurface.Type
  readonly createDefaultState: ProjectNavigationContribution["createDefaultState"]
  readonly isValidState: ProjectNavigationContribution["isValidState"]
}

/** Renderer workspace state after validating persisted activity and opaque owner navigation. */
export class ResolvedProjectWorkspaceState extends Schema.TaggedClass<ResolvedProjectWorkspaceState>()(
  "resolved",
  {
    activeSurface: ProjectWorkspaceActivitySelection.fields.activeSurface,
    activeActivity: ProjectWorkspaceActivitySelection.fields.activeActivity,
    navigationContributionId: ProjectWorkspaceNavigationContributionId,
    navigationLocation: ProjectWorkspaceNavigationLocation,
    notice: Schema.OptionFromNullOr(Schema.String),
  },
) {}

/** Renderer workspace state that cannot open because no compatible activity and owner are registered. */
export class UnresolvedProjectWorkspaceState extends Schema.TaggedClass<UnresolvedProjectWorkspaceState>()(
  "unresolved",
  { notice: Schema.OptionFromNullOr(Schema.String) },
) {}

/** Result of validating persisted workspace state against active activities and navigation owners. */
export const ProjectWorkspaceStateResolution = Schema.Union([
  ResolvedProjectWorkspaceState,
  UnresolvedProjectWorkspaceState,
]).pipe(Schema.toTaggedUnion("_tag"))

/** Result of validating persisted workspace state against active activities and navigation owners. */
export type ProjectWorkspaceStateResolution = typeof ProjectWorkspaceStateResolution.Type

/** Restores opaque durable navigation through registered owner codecs and repairs missing owners. */
export const resolveProjectWorkspaceState = (
  repo: Repo,
  persisted: ProjectWorkspaceState | null,
  availableActivities: readonly ProjectWorkspaceActivityAvailability[],
  availableNavigation: readonly ProjectWorkspaceNavigationAvailability[],
): ProjectWorkspaceStateResolution => {
  if (persisted === null) {
    return defaultProjectWorkspaceState(
      repo,
      Option.none(),
      availableActivities,
      availableNavigation,
    )
  }

  const decoded = Schema.decodeUnknownResult(ProjectWorkspaceState)(persisted)
  if (Result.isFailure(decoded)) {
    return defaultProjectWorkspaceState(
      repo,
      Option.some(
        "Saved workspace state was invalid. A registered workspace was restored instead.",
      ),
      availableActivities,
      availableNavigation,
    )
  }

  const state = decoded.success
  if (state.projectId !== repo.id) {
    return defaultProjectWorkspaceState(
      repo,
      Option.some(
        "Saved workspace state belonged to another project. A registered workspace was restored instead.",
      ),
      availableActivities,
      availableNavigation,
    )
  }

  const activityResolution = resolveProjectWorkspaceActivity(
    {
      activeSurface: state.activeSurface,
      activeActivity: state.activeActivity,
    },
    availableActivities,
  )
  return ProjectWorkspaceActivityResolution.match(activityResolution, {
    unresolved: () =>
      UnresolvedProjectWorkspaceState.make({
        notice: Option.some("No project activity is currently available."),
      }),
    available: ({ selection }) =>
      resolveProjectWorkspaceNavigation(
        repo,
        selection,
        state.navigation.contributionId,
        state.navigation.location,
        Option.none(),
        availableActivities,
        availableNavigation,
      ),
    repaired: ({ selection }) =>
      resolveProjectWorkspaceNavigation(
        repo,
        selection,
        state.navigation.contributionId,
        state.navigation.location,
        Option.some(
          "The saved workspace activity is unavailable. A registered activity was restored instead.",
        ),
        availableActivities,
        availableNavigation,
      ),
  })
}

const resolveProjectWorkspaceNavigation = (
  repo: Repo,
  selection: ProjectWorkspaceActivitySelection,
  contributionId: ProjectWorkspaceNavigationContributionId,
  location: ProjectWorkspaceNavigationLocation,
  notice: Option.Option<string>,
  availableActivities: readonly ProjectWorkspaceActivityAvailability[],
  availableNavigation: readonly ProjectWorkspaceNavigationAvailability[],
): ProjectWorkspaceStateResolution => {
  const contribution = availableNavigation.find(
    (candidate) => candidate.id === contributionId && candidate.surface === selection.activeSurface,
  )
  if (contribution !== undefined && contribution.isValidState(location)) {
    return ResolvedProjectWorkspaceState.make({
      ...selection,
      navigationContributionId: contribution.id,
      navigationLocation: location,
      notice,
    })
  }
  return defaultProjectWorkspaceState(
    repo,
    Option.some(
      "The saved workspace navigation owner is unavailable. A registered workspace was restored instead.",
    ),
    availableActivities,
    availableNavigation,
  )
}

const defaultProjectWorkspaceState = (
  repo: Repo,
  notice: Option.Option<string>,
  availableActivities: readonly ProjectWorkspaceActivityAvailability[],
  availableNavigation: readonly ProjectWorkspaceNavigationAvailability[],
): ProjectWorkspaceStateResolution => {
  const activity =
    availableActivities.find((candidate) =>
      candidate.defaultForSurfaces.some((surface) =>
        availableNavigation.some((navigation) => navigation.surface === surface),
      ),
    ) ??
    availableActivities.find((candidate) =>
      candidate.supportedSurfaces.some((surface) =>
        availableNavigation.some((navigation) => navigation.surface === surface),
      ),
    )
  if (activity === undefined) return UnresolvedProjectWorkspaceState.make({ notice })
  const surface =
    activity.defaultForSurfaces.find((candidate) =>
      availableNavigation.some((navigation) => navigation.surface === candidate),
    ) ??
    activity.supportedSurfaces.find((candidate) =>
      availableNavigation.some((navigation) => navigation.surface === candidate),
    )
  const contribution = availableNavigation.find((candidate) => candidate.surface === surface)
  if (surface === undefined || contribution === undefined) {
    return UnresolvedProjectWorkspaceState.make({ notice })
  }
  return ResolvedProjectWorkspaceState.make({
    activeSurface: ProjectWorkspaceSurface.make(surface),
    activeActivity: activity.id,
    navigationContributionId: contribution.id,
    navigationLocation: contribution.createDefaultState(repo),
    notice,
  })
}
