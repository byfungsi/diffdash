import {
  type ProjectActivityContribution,
  type TrustedBuiltInExtension,
  TrustedExtensionContributionId,
  TrustedExtensionId,
} from "../extension-registry"
import { MessageSquare } from "lucide-react"
import { ReviewCommentsConnectionAction, ReviewCommentsProvider } from "./review-comments-provider"
import {
  ReviewCommentsActivityPane,
  ReviewCommentsCodeSourceContribution,
} from "./code-comments-contribution"
import {
  ReviewCommentsActivityDetailPane,
  ReviewCommentsReviewDiffContribution,
} from "./review-comments-review-contribution"
import { REVIEW_COMMENTS_ACTIVITY_ID } from "./review-comments-identities"

export { REVIEW_COMMENTS_ACTIVITY_ID } from "./review-comments-identities"

/** Stable owner identity for the trusted Review Comments renderer extension. */
export const REVIEW_COMMENTS_EXTENSION_ID = TrustedExtensionId.make(
  "diffdash.builtin.review-comments",
)

/** Stable identity for Review Comments behavior mounted into Code sources. */
export const REVIEW_COMMENTS_CODE_SOURCE_ID = TrustedExtensionContributionId.make(
  "diffdash.builtin.review-comments.code-source",
)

/** Stable identity for Review Comments behavior mounted into Review diffs. */
export const REVIEW_COMMENTS_REVIEW_DIFF_ID = TrustedExtensionContributionId.make(
  "diffdash.builtin.review-comments.review-diff",
)

/** Stable identity for project-scoped Review Comments state. */
export const REVIEW_COMMENTS_PROJECT_PROVIDER_ID = TrustedExtensionContributionId.make(
  "diffdash.builtin.review-comments.project-provider",
)

/** Stable identity for the Review Comments activity context pane. */
export const REVIEW_COMMENTS_CONTEXT_PANE_ID = TrustedExtensionContributionId.make(
  "diffdash.builtin.review-comments.context-pane",
)

/** Stable identity for the Review Comments selected-thread detail pane. */
export const REVIEW_COMMENTS_DETAIL_PANE_ID = TrustedExtensionContributionId.make(
  "diffdash.builtin.review-comments.detail-pane",
)

/** Comments activity metadata shared by Code and Review workspace hosts. */
export const REVIEW_COMMENTS_ACTIVITY: ProjectActivityContribution = {
  id: REVIEW_COMMENTS_ACTIVITY_ID,
  label: "Comments",
  icon: MessageSquare,
  order: 500,
  supportedSurfaces: ["code", "review"],
  surfacePolicy: "preserve",
  slots: {
    contextPane: {
      id: REVIEW_COMMENTS_CONTEXT_PANE_ID,
      order: 500,
      component: ReviewCommentsActivityPane,
    },
    detailPane: {
      id: REVIEW_COMMENTS_DETAIL_PANE_ID,
      order: 500,
      component: ReviewCommentsActivityDetailPane,
    },
  },
}

/** Stable identity for the Review Comments destination selector. */
export const REVIEW_COMMENTS_CONNECTION_ACTION_ID = TrustedExtensionContributionId.make(
  "diffdash.builtin.review-comments.connection-action",
)

/** Trusted extension definition contributing Comments across Code and Review surfaces. */
export const reviewCommentsExtension: TrustedBuiltInExtension = {
  id: REVIEW_COMMENTS_EXTENSION_ID,
  projectActivities: [REVIEW_COMMENTS_ACTIVITY],
  codeSourceContributions: [
    {
      id: REVIEW_COMMENTS_CODE_SOURCE_ID,
      order: 500,
      component: ReviewCommentsCodeSourceContribution,
    },
  ],
  reviewDiffContributions: [
    {
      id: REVIEW_COMMENTS_REVIEW_DIFF_ID,
      order: 500,
      component: ReviewCommentsReviewDiffContribution,
    },
  ],
  projectProviders: [
    {
      id: REVIEW_COMMENTS_PROJECT_PROVIDER_ID,
      order: 500,
      component: ReviewCommentsProvider,
    },
  ],
  titlebarActions: [
    {
      id: REVIEW_COMMENTS_CONNECTION_ACTION_ID,
      order: 100,
      component: ReviewCommentsConnectionAction,
    },
  ],
}
