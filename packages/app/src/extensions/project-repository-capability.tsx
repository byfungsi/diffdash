import type { HostedRepositoryLocator } from "@diffdash/domain/git-provider"
import { createContext, type ReactNode, use } from "react"

/** Project-scoped repository operations available to registered surface owners. */
export interface ProjectRepositoryCapability {
  readonly link: (repository?: HostedRepositoryLocator) => Promise<boolean>
}

const ProjectRepositoryCapabilityContext = createContext<ProjectRepositoryCapability | null>(null)

/** Supplies project repository operations independently of generic surface mechanics. */
export const ProjectRepositoryCapabilityProvider = ({
  children,
  value,
}: {
  readonly children: ReactNode
  readonly value: ProjectRepositoryCapability
}) => (
  <ProjectRepositoryCapabilityContext value={value}>{children}</ProjectRepositoryCapabilityContext>
)

/** Reads project repository operations for a registered surface owner. */
export const useProjectRepositoryCapability = (): ProjectRepositoryCapability => {
  const capability = use(ProjectRepositoryCapabilityContext)
  if (capability === null) throw new Error("ProjectRepositoryCapabilityProvider is unavailable")
  return capability
}
