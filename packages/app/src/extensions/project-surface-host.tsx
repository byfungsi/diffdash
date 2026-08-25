import type { ProjectWorkspaceSurface } from "@diffdash/domain/project-workspace"

import type { OwnedExtensionContribution, ProjectSurfaceContribution } from "./extension-registry"

/** Mounts the registered owner of one project source surface. */
export const RegisteredProjectSurface = ({
  contributions,
  surface,
}: {
  readonly contributions: readonly OwnedExtensionContribution<ProjectSurfaceContribution>[]
  readonly surface: ProjectWorkspaceSurface
}) => {
  const contribution = contributions.find((candidate) => candidate.surface === surface)
  if (contribution === undefined) return null
  const Surface = contribution.component
  return (
    <Surface
      key={`${contribution.ownerExtensionId}:${contribution.id}:${contribution.ownerRegistrationToken.reactKey}`}
    />
  )
}
