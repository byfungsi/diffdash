import type { Repo } from "@diffdash/domain/repository"
import { Option } from "effect"
import type { ApplicationLocation } from "@/platform/application-navigation"
import type { SelectedReviewTarget } from "@/review/review-subject"
import {
  PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
  PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
} from "./review-identities"
import {
  decodeReviewNavigationState,
  encodeReviewNavigationState,
  REVIEW_NAVIGATION_ID,
} from "./review-navigation"

/** Creates a host destination through the Review extension's existing state codec. */
export const createReviewApplicationLocation = (
  repo: Repo,
  selection: SelectedReviewTarget | null,
): ApplicationLocation => ({
  kind: "project",
  repo,
  surface: "review",
  contributionId: REVIEW_NAVIGATION_ID,
  activityId:
    selection === null
      ? PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID
      : PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
  state: encodeReviewNavigationState({ selectedReview: Option.fromNullishOr(selection) }),
})

/** Reads Review-owned selections without teaching the application shell about review state. */
export const readReviewApplicationLocation = (
  location: ApplicationLocation,
): SelectedReviewTarget | null =>
  location.kind === "project" && location.contributionId === REVIEW_NAVIGATION_ID
    ? Option.getOrNull(decodeReviewNavigationState(location.state).selectedReview)
    : null
