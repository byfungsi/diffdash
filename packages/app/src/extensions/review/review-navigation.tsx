import { Equal, Option, Schema } from "effect"
import { createContext, type ReactNode, use, useLayoutEffect, useState } from "react"

import { SelectedReviewTarget } from "@/review/review-subject"
import { makeExtensionNavigationStateCodec } from "../navigation-state-schema"
import { useProjectNavigationRestoreHandler } from "../project-navigation-runtime"
import { useTrustedExtensionRegistryController } from "../extension-registry-context"
import type { EncodedExtensionLocation, ProjectNavigationContribution } from "../extension-registry"
import {
  TrustedExtensionContributionId,
  type TrustedExtensionRegistrationToken,
} from "../extension-registry"

const ReviewNavigationState = Schema.Struct({
  selectedReview: Schema.OptionFromNullOr(SelectedReviewTarget),
})
const ReviewNavigationStateCodec = makeExtensionNavigationStateCodec(ReviewNavigationState)

/** Decoded navigation state owned by the Review extension. */
export type ReviewNavigationState = typeof ReviewNavigationState.Type

/** Review-owned selection state and opaque history encoding used by the workbench. */
export interface ReviewNavigationController {
  readonly selectedReview: ReviewNavigationState["selectedReview"]
  readonly clearReviewSelection: () => void
  readonly selectReview: (selection: ReviewNavigationState["selectedReview"]) => void
  readonly encodeReviewSelection: (
    selection?: ReviewNavigationState["selectedReview"],
  ) => EncodedExtensionLocation
}

/** Review selection callback used by owner-level restoration tests and adapters. */
export interface ReviewNavigationRestoreHost {
  readonly selectReview: (selection: ReviewNavigationState["selectedReview"]) => void
}

/** Stable identity for Review history encoding and restoration. */
export const REVIEW_NAVIGATION_ID = TrustedExtensionContributionId.make(
  "diffdash.builtin.review.navigation",
)

/** Encodes Review-owned location state for the generic global history. */
export const encodeReviewNavigationState = (
  state: ReviewNavigationState,
): EncodedExtensionLocation => ReviewNavigationStateCodec.encode(state)

/** Decodes Review-owned location state after registry validation. */
export const decodeReviewNavigationState = (
  state: EncodedExtensionLocation,
): ReviewNavigationState => ReviewNavigationStateCodec.decode(state)

/** Restores one decoded Review selection through its owner callback. */
export const restoreReviewNavigationState = (
  state: EncodedExtensionLocation,
  host: ReviewNavigationRestoreHost,
): void => host.selectReview(decodeReviewNavigationState(state).selectedReview)

const ReviewNavigationContext = createContext<ReviewNavigationController | null>(null)

/** Returns Review-owned selection and navigation encoding state. */
export const useReviewNavigationController = (): ReviewNavigationController => {
  const controller = use(ReviewNavigationContext)
  if (controller === null) throw new Error("ReviewNavigationProvider is unavailable")
  return controller
}

/** Owns Review selection state and restores opaque Review history while registered. */
export const ReviewNavigationProvider = ({
  active,
  children,
  registrationToken,
}: {
  readonly active: boolean
  readonly children: ReactNode
  readonly registrationToken: TrustedExtensionRegistrationToken
}) => {
  const registry = useTrustedExtensionRegistryController()
  const [selectedReview, setSelectedReview] = useState<ReviewNavigationState["selectedReview"]>(
    Option.none,
  )
  useLayoutEffect(() => {
    if (!active) setSelectedReview(Option.none())
  }, [active, registrationToken])
  useProjectNavigationRestoreHandler(
    active,
    REVIEW_NAVIGATION_ID,
    registrationToken,
    (state) => {
      restoreReviewNavigationState(state, { selectReview: setSelectedReview })
    },
    () => setSelectedReview(Option.none()),
  )
  const controller: ReviewNavigationController = {
    selectedReview,
    clearReviewSelection: () => setSelectedReview(Option.none()),
    selectReview: (selection) => {
      const currentRegistration = registry
        .snapshot()
        .projectNavigation.find(({ id }) => id === REVIEW_NAVIGATION_ID)
      if (currentRegistration?.ownerRegistrationToken === registrationToken) {
        setSelectedReview(selection)
      }
    },
    encodeReviewSelection: (selection = selectedReview) =>
      encodeReviewNavigationState({ selectedReview: selection }),
  }
  return <ReviewNavigationContext value={controller}>{children}</ReviewNavigationContext>
}

/** Review navigation codec registered atomically with the Review surface. */
export const reviewNavigationContribution: ProjectNavigationContribution = {
  id: REVIEW_NAVIGATION_ID,
  order: 100,
  surface: "review",
  component: ReviewNavigationProvider,
  createDefaultState: () => encodeReviewNavigationState({ selectedReview: Option.none() }),
  isValidState: ReviewNavigationStateCodec.isValid,
  sameState: (left, right) => {
    if (
      !reviewNavigationContribution.isValidState(left) ||
      !reviewNavigationContribution.isValidState(right)
    )
      return false
    return Equal.equals(decodeReviewNavigationState(left), decodeReviewNavigationState(right))
  },
}
