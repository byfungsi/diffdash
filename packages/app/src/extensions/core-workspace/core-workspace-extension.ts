import {
  PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
  PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
  PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
  PROJECT_WORKSPACE_WALKTHROUGH_ACTIVITY_ID,
} from "@diffdash/domain/project-workspace"

import {
  type ProjectActivityContribution,
  type TrustedBuiltInExtension,
  TrustedExtensionId,
} from "../extension-registry"

/** Stable owner identity for DiffDash's core project workspace activities. */
export const CORE_WORKSPACE_EXTENSION_ID = TrustedExtensionId.make("diffdash.core.workspace")

/** Core project activities rendered alongside trusted extension contributions. */
export const CORE_PROJECT_ACTIVITIES: readonly ProjectActivityContribution[] = [
  {
    id: PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
    label: "Reviews",
    icon: "reviews",
    order: 100,
    supportedSurfaces: ["review"],
    surfacePolicy: "review",
  },
  {
    id: PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
    label: "Files",
    icon: "files",
    order: 200,
    supportedSurfaces: ["review"],
    surfacePolicy: "review",
  },
  {
    id: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
    label: "Code",
    icon: "code",
    order: 300,
    supportedSurfaces: ["code"],
    surfacePolicy: "code",
  },
  {
    id: PROJECT_WORKSPACE_WALKTHROUGH_ACTIVITY_ID,
    label: "Walkthrough",
    icon: "walkthrough",
    order: 400,
    supportedSurfaces: ["review"],
    surfacePolicy: "review",
  },
]

/** Trusted definition owning the built-in project workspace activities. */
export const coreWorkspaceExtension: TrustedBuiltInExtension = {
  id: CORE_WORKSPACE_EXTENSION_ID,
  projectActivities: CORE_PROJECT_ACTIVITIES,
}
