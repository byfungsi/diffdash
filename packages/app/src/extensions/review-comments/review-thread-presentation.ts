import type {
  ReviewThread,
  ReviewThreadAnchor,
  ReviewThreadDetails,
} from "@diffdash/domain/review-thread"
import { CurrentReviewAnchor } from "@diffdash/domain/review-thread"
import { Effect, HashMap, Option, Ref, Schema } from "effect"

const ReviewThreadHistoryScrollState = Schema.Struct({
  pinned: Schema.Boolean,
  scrollTop: Schema.Number,
})

type ReviewThreadHistoryScrollState = typeof ReviewThreadHistoryScrollState.Type

const reviewThreadHistoryScrollStates = Ref.makeUnsafe(
  HashMap.empty<string, ReviewThreadHistoryScrollState>(),
)

/** Records the latest scroll state for one rendered review-thread history. */
export const recordReviewThreadHistoryScrollState = (
  threadId: string,
  state: ReviewThreadHistoryScrollState,
): void => {
  Effect.runSync(Ref.update(reviewThreadHistoryScrollStates, HashMap.set(threadId, state)))
}

/** Restores pinned or reader-controlled scroll positions after inline annotation rendering. */
export const syncPinnedReviewThreadHistories = (root: ParentNode): void => {
  const histories = [...root.querySelectorAll<HTMLElement>("[data-review-thread-history]")]
  histories.forEach((history) => {
    const threadId = history.closest<HTMLElement>("[data-review-thread-id]")?.dataset.reviewThreadId
    if (threadId === undefined) return
    Option.match(HashMap.get(Ref.getUnsafe(reviewThreadHistoryScrollStates), threadId), {
      onNone: () => {
        history.scrollTop = history.scrollHeight
        recordReviewThreadHistoryScrollState(threadId, {
          pinned: true,
          scrollTop: history.scrollTop,
        })
      },
      onSome: (state) => {
        history.scrollTop = state.pinned ? history.scrollHeight : state.scrollTop
        if (state.pinned) {
          recordReviewThreadHistoryScrollState(threadId, {
            pinned: true,
            scrollTop: history.scrollTop,
          })
        }
      },
    })
  })
}

/** Explains why a persisted thread cannot navigate to the current diff. */
export const fallbackThreadLabel = (details: ReviewThreadDetails): string =>
  CurrentReviewAnchor.match(details.thread.currentAnchor, {
    Outdated: () => "Outdated",
    Unresolved: () => "Anchor unavailable",
    Active: () =>
      reviewThreadIsPreviousRevision(details.thread) ? "Previous revision" : "Location unavailable",
  })

/** Whether a thread originated on a revision older than its latest mapped review snapshot. */
export const reviewThreadIsPreviousRevision = (thread: ReviewThread): boolean =>
  thread.baseRevision !== thread.currentBaseRevision ||
  thread.headRevision !== thread.currentHeadRevision

/** Compact GitHub-style side and line label for an inline review disclosure. */
export const reviewLineLabel = (anchor: ReviewThreadAnchor): string =>
  `${reviewLineSideLabel[anchor.side]}${anchor.lineNumber}`

const reviewLineSideLabel = { old: "L", new: "R" } as const satisfies Readonly<
  Record<ReviewThreadAnchor["side"], string>
>
