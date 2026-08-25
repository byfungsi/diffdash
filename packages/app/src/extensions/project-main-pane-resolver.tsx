import type { ReactNode } from "react"

import type {
  OwnedExtensionContribution,
  ProjectActivityContribution,
  ProjectActivityPaneProps,
  ProjectSurfaceContribution,
} from "./extension-registry"

/** Resolves an activity main pane against the single default owned by its project surface. */
export const resolveProjectActivityMainPane = ({
  activities,
  activeActivityId,
  activityPaneProps,
  baseMain,
  surface,
}: {
  readonly activities: readonly OwnedExtensionContribution<ProjectActivityContribution>[]
  readonly activeActivityId: ProjectActivityContribution["id"]
  readonly activityPaneProps: ProjectActivityPaneProps
  readonly baseMain: ReactNode
  readonly surface: OwnedExtensionContribution<ProjectSurfaceContribution>
}): ReactNode => {
  const DefaultMainPane = surface.defaultMainPane.component
  const resolvedBaseMain = (
    <DefaultMainPane key={surface.ownerRegistrationToken.reactKey} baseMain={baseMain} />
  )
  const activity =
    activities.find((candidate) => candidate.id === activeActivityId) ??
    activities.find((candidate) => candidate.id === surface.defaultActivityId)
  if (activity === undefined) return resolvedBaseMain
  const contribution = activity.slots?.mainPane
  if (contribution === undefined) return resolvedBaseMain
  if (contribution.mode === "replace") {
    const ReplacingMainPane = contribution.component
    return (
      <ReplacingMainPane key={activity.ownerRegistrationToken.reactKey} {...activityPaneProps} />
    )
  }
  const DecoratingMainPane = contribution.component
  return (
    <DecoratingMainPane
      key={activity.ownerRegistrationToken.reactKey}
      {...activityPaneProps}
      baseMain={resolvedBaseMain}
    />
  )
}
