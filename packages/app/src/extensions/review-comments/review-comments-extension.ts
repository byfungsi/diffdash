import { REVIEW_COMMENTS_ACTIVITY_ID } from "@diffdash/domain/project-workspace"

import {
  type ProjectActivityContribution,
  type TrustedBuiltInExtension,
  TrustedExtensionId,
} from "../extension-registry"

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

/** Trusted extension definition contributing Comments across Code and Review surfaces. */
export const reviewCommentsExtension: TrustedBuiltInExtension = {
  id: REVIEW_COMMENTS_EXTENSION_ID,
  projectActivities: [REVIEW_COMMENTS_ACTIVITY],
}
