import { REVIEW_COMMENTS_ACTIVITY_ID } from "@diffdash/domain/project-workspace"

import {
  type ProjectActivityContribution,
  type TrustedBuiltInExtension,
  TrustedExtensionContributionId,
  TrustedExtensionId,
} from "../extension-registry"
import { ReviewCommentsConnectionAction } from "./review-comments-provider"

/** Stable owner identity for the trusted Review Comments renderer extension. */
export const REVIEW_COMMENTS_EXTENSION_ID = TrustedExtensionId.make(
  "diffdash.builtin.review-comments",
)

/** Comments activity metadata shared by Code and Review workspace hosts. */
export const REVIEW_COMMENTS_ACTIVITY: ProjectActivityContribution = {
  id: REVIEW_COMMENTS_ACTIVITY_ID,
  label: "Comments",
  icon: "comments",
  order: 500,
  supportedSurfaces: ["code", "review"],
  surfacePolicy: "preserve",
}

/** Stable identity for the Review Comments destination selector. */
export const REVIEW_COMMENTS_CONNECTION_ACTION_ID = TrustedExtensionContributionId.make(
  "diffdash.builtin.review-comments.connection-action",
)

/** Trusted extension definition contributing Comments across Code and Review surfaces. */
export const reviewCommentsExtension: TrustedBuiltInExtension = {
  id: REVIEW_COMMENTS_EXTENSION_ID,
  projectActivities: [REVIEW_COMMENTS_ACTIVITY],
  titlebarActions: [
    {
      id: REVIEW_COMMENTS_CONNECTION_ACTION_ID,
      order: 100,
      component: ReviewCommentsConnectionAction,
    },
  ],
}
