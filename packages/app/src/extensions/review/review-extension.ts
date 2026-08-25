import {
  type ProjectActivityContribution,
  type ProjectSurfaceContribution,
  type TrustedBuiltInExtension,
  TrustedExtensionContributionId,
  TrustedExtensionId,
} from "../extension-registry"
import { ReviewExtensionSurface } from "./review-surface-host"
import { reviewNavigationContribution } from "./review-navigation"
import { ProjectedActivityMainPane } from "../project-activity-pane-projection"
import { FilesActivityContextPane, ReviewsActivityContextPane } from "./review-activity-panes"
import {
  PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
  PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
} from "./review-identities"
import { Files, GitPullRequest } from "lucide-react"
import { ReviewProjectOpeningProvider } from "./review-project-opening-provider"

export {
  PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
  PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
} from "./review-identities"

/** Stable owner identity for the trusted Review workspace extension. */
export const REVIEW_EXTENSION_ID = TrustedExtensionId.make("diffdash.builtin.review")

/** Stable identity for the removable Review source surface. */
export const REVIEW_SURFACE_ID = TrustedExtensionContributionId.make(
  "diffdash.builtin.review.surface",
)

/** Stable identity for Review's removable project-opening capability. */
export const REVIEW_PROJECT_OPENING_PROVIDER_ID = TrustedExtensionContributionId.make(
  "diffdash.builtin.review.project-opening-provider",
)

/** Stable identity for the Reviews activity context pane. */
export const REVIEWS_CONTEXT_PANE_ID = TrustedExtensionContributionId.make(
  "diffdash.builtin.review.reviews-context-pane",
)

/** Stable identity for the Files activity context pane. */
export const FILES_CONTEXT_PANE_ID = TrustedExtensionContributionId.make(
  "diffdash.builtin.review.files-context-pane",
)

/** Review and Files activities owned by the trusted Review extension. */
export const REVIEW_PROJECT_ACTIVITIES: readonly ProjectActivityContribution[] = [
  {
    id: PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
    label: "Reviews",
    icon: GitPullRequest,
    order: 100,
    supportedSurfaces: ["review"],
    defaultForSurfaces: ["review"],
    surfacePolicy: "review",
    slots: {
      contextPane: {
        id: REVIEWS_CONTEXT_PANE_ID,
        order: 100,
        component: ReviewsActivityContextPane,
      },
    },
  },
  {
    id: PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
    label: "Files",
    icon: Files,
    order: 200,
    supportedSurfaces: ["review"],
    surfacePolicy: "review",
    slots: {
      contextPane: {
        id: FILES_CONTEXT_PANE_ID,
        order: 100,
        component: FilesActivityContextPane,
      },
    },
  },
]

/** Complete Review surface contract with its default activity and diff pane. */
export const REVIEW_PROJECT_SURFACE: ProjectSurfaceContribution = {
  id: REVIEW_SURFACE_ID,
  order: 100,
  surface: "review",
  defaultActivityId: PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
  defaultMainPane: {
    id: TrustedExtensionContributionId.make("diffdash.builtin.review.default-main-pane"),
    order: 100,
    component: ProjectedActivityMainPane,
  },
  component: ReviewExtensionSurface,
}

/** Trusted extension definition owning Review workspace navigation and panes. */
export const reviewExtension: TrustedBuiltInExtension = {
  id: REVIEW_EXTENSION_ID,
  projectActivities: REVIEW_PROJECT_ACTIVITIES,
  projectSurfaces: [REVIEW_PROJECT_SURFACE],
  projectNavigation: [reviewNavigationContribution],
  projectOpeningProviders: [
    {
      id: REVIEW_PROJECT_OPENING_PROVIDER_ID,
      order: 100,
      component: ReviewProjectOpeningProvider,
    },
  ],
}
