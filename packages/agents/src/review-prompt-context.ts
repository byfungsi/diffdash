import { DiffFileStatus } from "@diffdash/domain/diff"
import { ReviewDescriptor } from "@diffdash/domain/review-context"
import { ReviewFileId, ReviewKey, ReviewRevision } from "@diffdash/domain/review-identity"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { Schema } from "effect"

/** Durable review identity and bounded descriptor metadata safe to expose in agent prompts. */
export const ReviewPromptIdentity = Schema.Struct({
  reviewKey: ReviewKey,
  baseRevision: ReviewRevision,
  headRevision: ReviewRevision,
  descriptor: ReviewDescriptor,
})

/** Durable review identity and bounded descriptor metadata safe to expose in agent prompts. */
export type ReviewPromptIdentity = typeof ReviewPromptIdentity.Type

/** Prompt-safe metadata for one already-selected changed file, without patch text or hunks. */
export const ReviewPromptFile = Schema.Struct({
  fileId: ReviewFileId,
  path: RepositoryRelativePath,
  oldPath: Schema.NullOr(RepositoryRelativePath),
  status: DiffFileStatus,
  additions: Schema.Number,
  deletions: Schema.Number,
  hunkCount: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
})

/** Prompt-safe metadata for one already-selected changed file, without patch text or hunks. */
export type ReviewPromptFile = typeof ReviewPromptFile.Type
