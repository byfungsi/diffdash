import { Schema } from "effect"

/** A user reference returned by review metadata commands. */
export class ReviewActor extends Schema.Class<ReviewActor>("ReviewActor")({
  login: Schema.String,
}) {}

/** A provider review summary suitable for repository review lists. */
export class PullRequestSummary extends Schema.Class<PullRequestSummary>("PullRequestSummary")({
  repoOwner: Schema.String,
  repoName: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  author: ReviewActor,
  state: Schema.String,
  url: Schema.String,
  isDraft: Schema.Boolean,
  baseRefName: Schema.String,
  baseRefOid: Schema.NullOr(Schema.String),
  headRefName: Schema.String,
  headRefOid: Schema.NullOr(Schema.String),
  createdAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
}) {}

/** File-level metadata returned by review detail commands. */
export class PullRequestFile extends Schema.Class<PullRequestFile>("PullRequestFile")({
  path: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  changeType: Schema.String,
}) {}

/** Commit metadata returned by review detail commands. */
export class PullRequestCommit extends Schema.Class<PullRequestCommit>("PullRequestCommit")({
  oid: Schema.String,
  messageHeadline: Schema.String,
  authoredDate: Schema.NullOr(Schema.String),
}) {}

/** Detailed provider review metadata used by the review workspace. */
export class PullRequestDetail extends Schema.Class<PullRequestDetail>("PullRequestDetail")({
  repoOwner: Schema.String,
  repoName: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  author: ReviewActor,
  state: Schema.String,
  url: Schema.String,
  isDraft: Schema.Boolean,
  baseRefName: Schema.String,
  baseRefOid: Schema.NullOr(Schema.String),
  headRefName: Schema.String,
  headRefOid: Schema.NullOr(Schema.String),
  createdAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
  files: Schema.Array(PullRequestFile),
  commits: Schema.Array(PullRequestCommit),
}) {}

/** Raw unified diff output and cache metadata for a provider review. */
export class PullRequestDiff extends Schema.Class<PullRequestDiff>("PullRequestDiff")({
  repoOwner: Schema.String,
  repoName: Schema.String,
  number: Schema.Number,
  headRefOid: Schema.NullOr(Schema.String),
  diff: Schema.String,
  fetchedAt: Schema.String,
}) {}
