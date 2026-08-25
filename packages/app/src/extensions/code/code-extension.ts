import { ProjectWorkspaceActivityId } from "@diffdash/domain/project-workspace"
import { Code2 } from "lucide-react"

import {
  type ProjectActivityContribution,
  type ProjectSurfaceContribution,
  type TrustedBuiltInExtension,
  TrustedExtensionContributionId,
  TrustedExtensionId,
} from "../extension-registry"
import { CodeActivityContextPane, CodeActivityMainPane } from "./code-activity-panes"
import { CodeExtensionSurface } from "./code-surface-host"
import { codeNavigationContribution } from "./code-navigation"
import { CodeProjectOpeningProvider } from "./code-project-opening-provider"

/** Stable owner identity for the trusted Code workspace extension. */
export const CODE_EXTENSION_ID = TrustedExtensionId.make("diffdash.builtin.code")

/** Stable persisted identity for the Code activity owned by this extension. */
export const PROJECT_WORKSPACE_CODE_ACTIVITY_ID =
  ProjectWorkspaceActivityId.make("diffdash.core.code")

/** Stable identity for the Code repository-tree context pane. */
export const CODE_CONTEXT_PANE_ID = TrustedExtensionContributionId.make(
  "diffdash.builtin.code.context-pane",
)

/** Stable identity for the Code source-viewer main pane. */
export const CODE_MAIN_PANE_ID = TrustedExtensionContributionId.make(
  "diffdash.builtin.code.main-pane",
)

/** Stable identity for the removable Code source surface. */
export const CODE_SURFACE_ID = TrustedExtensionContributionId.make("diffdash.builtin.code.surface")

/** Stable identity for Code-owned project opening and workspace persistence. */
export const CODE_PROJECT_OPENING_PROVIDER_ID = TrustedExtensionContributionId.make(
  "diffdash.builtin.code.project-opening-provider",
)

/** Code activity owned by the trusted Code workspace extension. */
export const CODE_PROJECT_ACTIVITY: ProjectActivityContribution = {
  id: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
  label: "Code",
  icon: Code2,
  order: 300,
  supportedSurfaces: ["code"],
  defaultForSurfaces: ["code"],
  surfacePolicy: "code",
  slots: {
    contextPane: {
      id: CODE_CONTEXT_PANE_ID,
      order: 100,
      component: CodeActivityContextPane,
    },
  },
}

/** Complete Code surface contract with its default activity and source viewer. */
export const CODE_PROJECT_SURFACE: ProjectSurfaceContribution = {
  id: CODE_SURFACE_ID,
  order: 100,
  surface: "code",
  defaultActivityId: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
  defaultMainPane: {
    id: CODE_MAIN_PANE_ID,
    order: 100,
    component: CodeActivityMainPane,
  },
  keepMountedAfterVisit: true,
  component: CodeExtensionSurface,
}

/** Trusted extension definition owning Code workspace navigation and panes. */
export const codeExtension: TrustedBuiltInExtension = {
  id: CODE_EXTENSION_ID,
  projectActivities: [CODE_PROJECT_ACTIVITY],
  projectSurfaces: [CODE_PROJECT_SURFACE],
  projectNavigation: [codeNavigationContribution],
  projectOpeningProviders: [
    {
      id: CODE_PROJECT_OPENING_PROVIDER_ID,
      order: 200,
      component: CodeProjectOpeningProvider,
    },
  ],
}
