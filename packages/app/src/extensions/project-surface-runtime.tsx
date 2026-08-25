import type {
  ProjectWorkspaceActivityId,
  ProjectWorkspaceSurface,
} from "@diffdash/domain/project-workspace"
import type { Repo } from "@diffdash/domain/repository"
import type { Option } from "effect"
import { createContext, type ReactNode, use } from "react"

import type {
  EncodedExtensionLocation,
  OwnedExtensionContribution,
  ProjectActivityContribution,
  ProjectNavigationContribution,
} from "./extension-registry"

/** Host mechanics and semantic project inputs available to registered surface owners. */
export interface ProjectSurfaceRuntime {
  readonly repo: Repo
  readonly activeActivity: ProjectWorkspaceActivityId
  readonly activeSurface: ProjectWorkspaceSurface
  readonly activities: readonly OwnedExtensionContribution<ProjectActivityContribution>[]
  readonly colorScheme: "light" | "dark"
  readonly sidebarExpanded: boolean
  readonly workspaceNotice: Option.Option<string>
  readonly quickNavigationRequest: number
  readonly persistLocation: (
    contribution: OwnedExtensionContribution<ProjectNavigationContribution>,
    activity: OwnedExtensionContribution<ProjectActivityContribution>,
    state: EncodedExtensionLocation,
  ) => Promise<void>
  readonly navigate: (
    contribution: OwnedExtensionContribution<ProjectNavigationContribution>,
    activityId: ProjectWorkspaceActivityId,
    state: EncodedExtensionLocation,
    mode?: "push" | "replace",
  ) => boolean
  readonly selectActivity: (activityId: ProjectWorkspaceActivityId) => void
  readonly setSidebarExpanded: (expanded: boolean) => void
}

const ProjectSurfaceRuntimeContext = createContext<ProjectSurfaceRuntime | null>(null)

/** Supplies project host mechanics without exposing any surface-owner payload fields. */
export const ProjectSurfaceRuntimeProvider = ({
  children,
  value,
}: {
  readonly children: ReactNode
  readonly value: ProjectSurfaceRuntime
}) => <ProjectSurfaceRuntimeContext value={value}>{children}</ProjectSurfaceRuntimeContext>

/** Returns the generic project host capability used by one registered surface owner. */
export const useProjectSurfaceRuntime = (): ProjectSurfaceRuntime => {
  const runtime = use(ProjectSurfaceRuntimeContext)
  if (runtime === null) throw new Error("ProjectSurfaceRuntimeProvider is unavailable")
  return runtime
}
