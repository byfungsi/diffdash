import { ProjectWorkspaceActivityId } from "@diffdash/domain/project-workspace"
import { Sparkles } from "lucide-react"

import {
  type ProjectActivityContribution,
  type TrustedBuiltInExtension,
  TrustedExtensionContributionId,
  TrustedExtensionId,
} from "../extension-registry"
import { WalkthroughReviewProvider } from "./walkthrough-review-provider"
import { WalkthroughContextPane, WalkthroughMainPane } from "./walkthrough-activity-panes"

/** Stable owner identity for the trusted Walkthrough extension. */
export const WALKTHROUGH_EXTENSION_ID = TrustedExtensionId.make("diffdash.builtin.walkthrough")

/** Stable persisted identity for the Walkthrough activity owned by this extension. */
export const PROJECT_WORKSPACE_WALKTHROUGH_ACTIVITY_ID = ProjectWorkspaceActivityId.make(
  "diffdash.core.walkthrough",
)

/** Stable identity for the Walkthrough activity context pane. */
export const WALKTHROUGH_CONTEXT_PANE_ID = TrustedExtensionContributionId.make(
  "diffdash.builtin.walkthrough.context-pane",
)

/** Stable identity for the Walkthrough Review decoration. */
export const WALKTHROUGH_MAIN_PANE_ID = TrustedExtensionContributionId.make(
  "diffdash.builtin.walkthrough.main-pane",
)

/** Stable identity for the Walkthrough lifecycle mounted around the Review surface. */
export const WALKTHROUGH_REVIEW_PROVIDER_ID = TrustedExtensionContributionId.make(
  "diffdash.builtin.walkthrough.review-provider",
)

/** Walkthrough activity owned by the trusted Walkthrough extension. */
export const WALKTHROUGH_PROJECT_ACTIVITY: ProjectActivityContribution = {
  id: PROJECT_WORKSPACE_WALKTHROUGH_ACTIVITY_ID,
  label: "Walkthrough",
  icon: Sparkles,
  order: 400,
  supportedSurfaces: ["review"],
  surfacePolicy: "review",
  slots: {
    contextPane: {
      id: WALKTHROUGH_CONTEXT_PANE_ID,
      order: 100,
      component: WalkthroughContextPane,
    },
    mainPane: {
      id: WALKTHROUGH_MAIN_PANE_ID,
      order: 100,
      mode: "decorate",
      component: WalkthroughMainPane,
    },
  },
}

/** Trusted extension definition owning the guided Review walkthrough. */
export const walkthroughExtension: TrustedBuiltInExtension = {
  id: WALKTHROUGH_EXTENSION_ID,
  projectActivities: [WALKTHROUGH_PROJECT_ACTIVITY],
  projectSurfaceProviders: [
    {
      id: WALKTHROUGH_REVIEW_PROVIDER_ID,
      order: 100,
      surface: "review",
      component: WalkthroughReviewProvider,
    },
  ],
}
