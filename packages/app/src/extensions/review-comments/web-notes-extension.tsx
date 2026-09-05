import type { TrustedBuiltInExtension, TrustedProjectProviderProps } from "../extension-registry"
import {
  REVIEW_COMMENTS_ACTIVITY,
  REVIEW_COMMENTS_PROJECT_PROVIDER_ID,
  REVIEW_COMMENTS_REVIEW_DIFF_ID,
  reviewCommentsExtension,
} from "./review-comments-extension"
import { ReviewCommentsReviewDiffContribution } from "./review-comments-review-contribution"
import { ReviewCommentsProvider } from "./review-comments-provider"

const WebNotesProvider = (props: TrustedProjectProviderProps) => (
  <ReviewCommentsProvider {...props} fixedMode="notes" />
)

/** Web-only Notes composition reusing review-line anchors without agent destinations or write actions. */
export const webNotesExtension: TrustedBuiltInExtension = {
  id: reviewCommentsExtension.id,
  projectActivities: [
    { ...REVIEW_COMMENTS_ACTIVITY, label: "Notes", supportedSurfaces: ["review"] },
  ],
  reviewDiffContributions: [
    {
      id: REVIEW_COMMENTS_REVIEW_DIFF_ID,
      order: 500,
      component: ReviewCommentsReviewDiffContribution,
    },
  ],
  projectProviders: [
    { id: REVIEW_COMMENTS_PROJECT_PROVIDER_ID, order: 500, component: WebNotesProvider },
  ],
}
