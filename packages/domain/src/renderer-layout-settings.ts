import { Schema } from "effect"

/** Default contextual review pane width in CSS pixels. */
export const REVIEW_CONTEXT_PANE_DEFAULT_WIDTH = 304

/** Smallest persisted contextual review pane width in CSS pixels. */
export const REVIEW_CONTEXT_PANE_MIN_WIDTH = 256

/** Largest persisted contextual review pane width in CSS pixels. */
export const REVIEW_CONTEXT_PANE_MAX_WIDTH = 448

/** Default attached thread-detail pane width in CSS pixels. */
export const REVIEW_THREAD_DETAIL_PANE_DEFAULT_WIDTH = 432

/** Smallest persisted attached thread-detail pane width in CSS pixels. */
export const REVIEW_THREAD_DETAIL_PANE_MIN_WIDTH = 320

/** Largest persisted attached thread-detail pane width in CSS pixels. */
export const REVIEW_THREAD_DETAIL_PANE_MAX_WIDTH = 640

/** Valid persisted width for the contextual review pane. */
export const ReviewContextPaneWidth = Schema.Int.pipe(
  Schema.between(REVIEW_CONTEXT_PANE_MIN_WIDTH, REVIEW_CONTEXT_PANE_MAX_WIDTH),
  Schema.brand("ReviewContextPaneWidth"),
)

/** Valid persisted width for the contextual review pane. */
export type ReviewContextPaneWidth = typeof ReviewContextPaneWidth.Type

/** Valid persisted width for the attached thread-detail pane. */
export const ReviewThreadDetailPaneWidth = Schema.Int.pipe(
  Schema.between(REVIEW_THREAD_DETAIL_PANE_MIN_WIDTH, REVIEW_THREAD_DETAIL_PANE_MAX_WIDTH),
  Schema.brand("ReviewThreadDetailPaneWidth"),
)

/** Valid persisted width for the attached thread-detail pane. */
export type ReviewThreadDetailPaneWidth = typeof ReviewThreadDetailPaneWidth.Type

/** Persisted review-workbench pane preferences. */
export class ReviewPaneSettings extends Schema.Class<ReviewPaneSettings>("ReviewPaneSettings")({
  contextWidth: ReviewContextPaneWidth,
  threadDetailWidth: ReviewThreadDetailPaneWidth,
}) {}

/** Renderer layout preferences stored with application settings. */
export class RendererLayoutSettings extends Schema.Class<RendererLayoutSettings>(
  "RendererLayoutSettings",
)({
  review: ReviewPaneSettings,
}) {}

/** Default renderer layout for a fresh install or invalid persisted values. */
export const DEFAULT_RENDERER_LAYOUT_SETTINGS = RendererLayoutSettings.make({
  review: ReviewPaneSettings.make({
    contextWidth: ReviewContextPaneWidth.make(REVIEW_CONTEXT_PANE_DEFAULT_WIDTH),
    threadDetailWidth: ReviewThreadDetailPaneWidth.make(REVIEW_THREAD_DETAIL_PANE_DEFAULT_WIDTH),
  }),
})
