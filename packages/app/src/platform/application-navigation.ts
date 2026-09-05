import type { Repo } from "@diffdash/domain/repository"
import type {
  ProjectWorkspaceActivityId,
  ProjectWorkspaceSurface,
} from "@diffdash/domain/project-workspace"
import {
  makeRequiredGlobalNavigationFallback,
  type GlobalNavigationEntry,
  type EncodedExtensionLocation,
  type TrustedExtensionContributionId,
} from "@/extensions/extension-registry"

/** Host navigation destination; extension owners retain their opaque state codecs. */
export type ApplicationLocation =
  | Omit<GlobalNavigationEntry, "registrationToken">
  | {
      readonly kind: "project"
      readonly repo: Repo
      readonly surface: ProjectWorkspaceSurface
      readonly contributionId: TrustedExtensionContributionId
      readonly activityId: ProjectWorkspaceActivityId
      readonly state: EncodedExtensionLocation
    }

/** In-process host navigation adapter. Desktop omits it; browser hosts own URL history. */
export interface ApplicationNavigation {
  readonly subscribe: (navigate: (location: ApplicationLocation) => boolean) => () => void
  readonly publish: (location: ApplicationLocation) => void
}

/** Returns the registered global fallback for hosts without embedding feature policy in the shell. */
export const createDefaultApplicationLocation = (): ApplicationLocation =>
  makeRequiredGlobalNavigationFallback()
