import { Schema } from "effect"

import { ReviewFileId, ReviewHunkFingerprint, ReviewHunkId } from "./review-identity"

/** Supported source providers for repositories tracked by DiffDash. */
export const RepoProvider = Schema.Literal("github", "local")

/** Supported source providers for repositories tracked by DiffDash. */
export type RepoProvider = typeof RepoProvider.Type

/** A local or remote-only repository saved in the DiffDash workspace. */
export class Repo extends Schema.Class<Repo>("Repo")({
  id: Schema.String,
  provider: RepoProvider,
  owner: Schema.String,
  name: Schema.String,
  remoteUrl: Schema.String,
  localPath: Schema.NullOr(Schema.String),
  isFavorite: Schema.Boolean,
  lastOpenedAt: Schema.NullOr(Schema.String),
  lastSyncedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) {}

/** A repository result returned by the configured Git provider. */
export class RepositorySearchResult extends Schema.Class<RepositorySearchResult>(
  "RepositorySearchResult",
)({
  owner: Schema.String,
  name: Schema.String,
  nameWithOwner: Schema.String,
  url: Schema.String,
  description: Schema.NullOr(Schema.String),
  isPrivate: Schema.Boolean,
  updatedAt: Schema.NullOr(Schema.String),
}) {}

/** A provider account or organization that can scope repository search. */
export class RepositorySearchScope extends Schema.Class<RepositorySearchScope>(
  "RepositorySearchScope",
)({
  login: Schema.String,
  kind: Schema.Literal("user", "organization"),
}) {}

/** Owner-scoped input for searching repositories through a Git provider. */
export class RepositorySearchRequest extends Schema.Class<RepositorySearchRequest>(
  "RepositorySearchRequest",
)({
  query: Schema.String,
  owners: Schema.Array(Schema.String),
}) {}

/** Input for creating or updating a repository record. */
export interface UpsertRepositoryInput {
  readonly provider: RepoProvider
  readonly owner: string
  readonly name: string
  readonly remoteUrl: string
  readonly localPath: string | null
  readonly isFavorite?: boolean
}

/** Repository checkout metadata detected from local Git. */
export interface DetectedRepositoryCheckout {
  readonly rootPath: string
  readonly remoteUrl: string
}

/** Provider-owned repository identity parsed from a remote URL. */
export interface ProviderRepositoryReference {
  readonly provider: RepoProvider
  readonly owner: string
  readonly name: string
}

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

/** Detailed metadata for reviewing local working tree changes. */
export class LocalReviewDetail extends Schema.Class<LocalReviewDetail>("LocalReviewDetail")({
  rootPath: Schema.String,
  repoName: Schema.String,
  branchName: Schema.NullOr(Schema.String),
  baseSha: Schema.String,
  headSha: Schema.String,
  diffHash: Schema.String,
  title: Schema.String,
  files: Schema.Array(PullRequestFile),
  fetchedAt: Schema.String,
}) {}

/** Raw unified diff output and cache metadata for local working tree changes. */
export class LocalReviewDiff extends Schema.Class<LocalReviewDiff>("LocalReviewDiff")({
  rootPath: Schema.String,
  baseSha: Schema.String,
  headSha: Schema.String,
  diffHash: Schema.String,
  diff: Schema.String,
  fetchedAt: Schema.String,
}) {}

/** File statuses derived from unified diff metadata. */
export const DiffFileStatus = Schema.Literal("added", "modified", "deleted", "renamed", "binary")

/** File statuses derived from unified diff metadata. */
export type DiffFileStatus = typeof DiffFileStatus.Type

/** A parsed unified diff hunk. */
export class ParsedDiffHunk extends Schema.Class<ParsedDiffHunk>("ParsedDiffHunk")({
  id: ReviewHunkId,
  fingerprint: ReviewHunkFingerprint,
  header: Schema.String,
  oldStart: Schema.Number,
  oldLines: Schema.Number,
  newStart: Schema.Number,
  newLines: Schema.Number,
  lines: Schema.Array(Schema.String),
}) {}

/** Parsed metadata and renderable patch text for one changed file. */
export class ParsedDiffFile extends Schema.Class<ParsedDiffFile>("ParsedDiffFile")({
  fileId: ReviewFileId,
  reviewKey: Schema.String,
  path: Schema.String,
  oldPath: Schema.NullOr(Schema.String),
  status: DiffFileStatus,
  additions: Schema.Number,
  deletions: Schema.Number,
  hunks: Schema.Array(ParsedDiffHunk),
  patch: Schema.String,
}) {}

/** Parsed file-level representation of a unified diff. */
export class ParsedDiff extends Schema.Class<ParsedDiff>("ParsedDiff")({
  files: Schema.Array(ParsedDiffFile),
}) {}
