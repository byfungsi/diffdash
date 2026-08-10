import { Schema } from "effect"

/** Open identity of the provider that produced a review run or artifact. */
export const ReviewAgentProviderId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("ReviewAgentProviderId"),
)

/** Open identity of the provider that produced a review run or artifact. */
export type ReviewAgentProviderId = typeof ReviewAgentProviderId.Type
