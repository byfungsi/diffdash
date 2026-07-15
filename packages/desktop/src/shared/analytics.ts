import { Schema } from "effect"

const ReviewType = Schema.Literal("local_diff", "pull_request")

/** Privacy-reviewed product events accepted from the renderer. */
export const AnalyticsEvent = Schema.Union(
  Schema.Struct({ event: Schema.Literal("onboarding_completed") }),
  Schema.Struct({ event: Schema.Literal("repository_bookmarked") }),
  Schema.Struct({ event: Schema.Literal("repository_linked") }),
  Schema.Struct({ event: Schema.Literal("review_opened"), reviewType: ReviewType }),
  Schema.Struct({
    event: Schema.Literal("review_file_viewed"),
    reviewType: ReviewType,
    viewed: Schema.Boolean,
  }),
  Schema.Struct({
    event: Schema.Literal("walkthrough_generated"),
    reviewType: ReviewType,
    regenerated: Schema.Boolean,
    provider: Schema.Literal("auto", "codex", "claude", "opencode"),
  }),
  Schema.Struct({ event: Schema.Literal("review_thread_created"), reviewType: ReviewType }),
  Schema.Struct({ event: Schema.Literal("review_agent_completed"), reviewType: ReviewType }),
  Schema.Struct({ event: Schema.Literal("pull_request_approved") }),
  Schema.Struct({ event: Schema.Literal("update_download_started") }),
  Schema.Struct({ event: Schema.Literal("update_install_started") }),
)

/** A privacy-reviewed product event accepted from the renderer. */
export type AnalyticsEvent = typeof AnalyticsEvent.Type
