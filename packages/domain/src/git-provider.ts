import { Effect, Schema } from "effect"

import { DiffFileStatus } from "./diff"
import { NonNegativeInteger, UtcIsoTimestamp } from "./domain-scalar"
import { RepositoryRelativePath } from "./repository-path"
import { RepositoryComparisonRef } from "./repository-comparison-ref"
import { ReviewRevision } from "./review-identity"
import { WebUrl } from "./web-url"

export { RepositoryRelativePath } from "./repository-path"
export { ReviewRevision } from "./review-identity"

/** Stable identifier for one configured hosted Git provider instance. */
export const GitProviderId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^(?!local$)[A-Za-z0-9][A-Za-z0-9._-]*$/)),
  Schema.brand("GitProviderId"),
)

/** Stable identifier for one configured hosted Git provider instance. */
export type GitProviderId = typeof GitProviderId.Type

/** Implementation family shared by compatible provider instances. */
export const GitProviderKind = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)),
  Schema.brand("GitProviderKind"),
)

/** Implementation family shared by compatible provider instances. */
export type GitProviderKind = typeof GitProviderKind.Type

/** A provider-owned namespace, including nested namespace segments. */
export const RepositoryNamespace = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[^/:#%]+(?:\/[^/:#%]+)*$/)),
  Schema.brand("RepositoryNamespace"),
)

/** A provider-owned namespace, including nested namespace segments. */
export type RepositoryNamespace = typeof RepositoryNamespace.Type

/** Repository name within a hosted namespace. */
export const HostedRepositoryName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[^/:#%]+$/)),
  Schema.brand("HostedRepositoryName"),
)

/** Repository name within a hosted namespace. */
export type HostedRepositoryName = typeof HostedRepositoryName.Type

/** Stable provider-owned repository identifier that survives owner and repository renames. */
export const ProviderRepositoryId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("ProviderRepositoryId"),
)

/** Stable provider-owned repository identifier that survives owner and repository renames. */
export type ProviderRepositoryId = typeof ProviderRepositoryId.Type

/** Branch, tag, or immutable revision accepted by a provider file URL. */
export const GitFileRevision = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("GitFileRevision"),
)

/** Branch, tag, or immutable revision accepted by a provider file URL. */
export type GitFileRevision = typeof GitFileRevision.Type

/** Positive provider-owned review number. */
export const HostedReviewNumber = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThan(0)),
  Schema.brand("HostedReviewNumber"),
)

/** Positive provider-owned review number. */
export type HostedReviewNumber = typeof HostedReviewNumber.Type

/** Complete identity of a repository on one configured provider instance. */
export class HostedRepositoryLocator extends Schema.Class<HostedRepositoryLocator>(
  "HostedRepositoryLocator",
)({
  providerId: GitProviderId,
  namespace: RepositoryNamespace,
  name: HostedRepositoryName,
}) {}

/** Complete identity of a hosted review. */
export class HostedReviewLocator extends Schema.Class<HostedReviewLocator>("HostedReviewLocator")({
  repository: HostedRepositoryLocator,
  number: HostedReviewNumber,
}) {}

/** Builds a typed locator for one hosted repository. */
export const makeHostedRepositoryLocator = (providerId: string, namespace: string, name: string) =>
  HostedRepositoryLocator.make({
    providerId: GitProviderId.make(providerId),
    namespace: RepositoryNamespace.make(namespace),
    name: HostedRepositoryName.make(name),
  })

/** Builds a typed locator for one hosted review. */
export const makeHostedReviewLocator = (
  providerId: string,
  namespace: string,
  name: string,
  number: number,
) =>
  HostedReviewLocator.make({
    repository: makeHostedRepositoryLocator(providerId, namespace, name),
    number: HostedReviewNumber.make(number),
  })

/** Returns whether two hosted repository locators identify the same configured target. */
export const sameHostedRepository = (
  left: HostedRepositoryLocator,
  right: HostedRepositoryLocator,
): boolean =>
  left.providerId.toLocaleLowerCase("en-US") === right.providerId.toLocaleLowerCase("en-US") &&
  left.namespace.toLocaleLowerCase("en-US") === right.namespace.toLocaleLowerCase("en-US") &&
  left.name.toLocaleLowerCase("en-US") === right.name.toLocaleLowerCase("en-US")

/** Returns whether two hosted review locators identify the same configured target. */
export const sameHostedReview = (left: HostedReviewLocator, right: HostedReviewLocator): boolean =>
  sameHostedRepository(left.repository, right.repository) && left.number === right.number

/** Local-only repository source, separate from hosted provider identity. */
export class LocalRepositorySource extends Schema.TaggedClass<LocalRepositorySource>()(
  "local",
  {},
) {}

/** Hosted repository source carrying its complete provider identity. */
export class HostedRepositorySource extends Schema.TaggedClass<HostedRepositorySource>()("hosted", {
  locator: HostedRepositoryLocator,
}) {}

/** Repository source mode independent from checkout availability. */
export const RepositorySource = Schema.Union([LocalRepositorySource, HostedRepositorySource])

/** Repository source mode independent from checkout availability. */
export type RepositorySource = typeof RepositorySource.Type

/** Provider feature flags used to drive provider-neutral host behavior. */
export class GitProviderCapabilities extends Schema.Class<GitProviderCapabilities>(
  "GitProviderCapabilities",
)({
  repositorySearch: Schema.Boolean,
  searchScopes: Schema.Boolean,
  assignedReviews: Schema.Boolean,
  reviewDecisions: Schema.Boolean,
  fileUrls: Schema.Boolean,
  remoteWorkspaceBootstrap: Schema.Boolean,
}) {}

/** Human-readable provider vocabulary used by provider-neutral UI. */
export class GitProviderTerminology extends Schema.Class<GitProviderTerminology>(
  "GitProviderTerminology",
)({
  repositorySingular: Schema.String,
  repositoryPlural: Schema.String,
  reviewSingular: Schema.String,
  reviewPlural: Schema.String,
  reviewAbbreviation: Schema.String.pipe(
    Schema.withConstructorDefault(Effect.succeed("PR")),
    Schema.withDecodingDefault(Effect.succeed("PR")),
  ),
}) {}

/** Serializable description of one configured provider instance. */
export class GitProviderDescriptor extends Schema.Class<GitProviderDescriptor>(
  "GitProviderDescriptor",
)({
  id: GitProviderId,
  kind: GitProviderKind,
  displayName: Schema.String,
  host: Schema.String,
  capabilities: GitProviderCapabilities,
  terminology: GitProviderTerminology,
}) {}

/** Provider health exposed without leaking provider-specific command output. */
export class GitProviderDiagnostic extends Schema.Class<GitProviderDiagnostic>(
  "GitProviderDiagnostic",
)({
  providerId: GitProviderId,
  available: Schema.Boolean,
  authenticated: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
}) {}

/** Provider-neutral review decision. */
export const ReviewDecision = Schema.Literals(["none", "approved", "changesRequested", "commented"])

/** Provider-neutral review decision. */
export type ReviewDecision = typeof ReviewDecision.Type

/** Stable provider-owned actor identity when one is available. */
export const ProviderActorId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("ProviderActorId"),
)

/** Stable provider-owned actor identity when one is available. */
export type ProviderActorId = typeof ProviderActorId.Type

/** Provider-neutral actor identity attached to hosted review metadata. */
export class ProviderActor extends Schema.Class<ProviderActor>("ProviderActor")({
  id: Schema.NullOr(ProviderActorId),
  username: Schema.String,
  displayName: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(WebUrl),
}) {}

/** Named branch and immutable revision at one side of a review. */
export class BranchRevision extends Schema.Class<BranchRevision>("BranchRevision")({
  name: RepositoryComparisonRef,
  revision: Schema.NullOr(ReviewRevision),
}) {}

/** Provider-neutral changed-file metadata shared by hosted and local reviews. */
export class ChangedFile extends Schema.Class<ChangedFile>("ChangedFile")({
  path: RepositoryRelativePath,
  additions: NonNegativeInteger,
  deletions: NonNegativeInteger,
  changeType: DiffFileStatus,
}) {}

/** Provider-neutral commit metadata. */
export class ReviewCommit extends Schema.Class<ReviewCommit>("ReviewCommit")({
  revision: ReviewRevision,
  title: Schema.String,
  authoredAt: Schema.NullOr(UtcIsoTimestamp),
}) {}

/** Repository metadata normalized by a hosted Git provider. */
export class HostedRepository extends Schema.Class<HostedRepository>("HostedRepository")({
  locator: HostedRepositoryLocator,
  url: WebUrl,
  description: Schema.NullOr(Schema.String),
  isPrivate: Schema.Boolean,
  updatedAt: Schema.NullOr(UtcIsoTimestamp),
}) {}

/** Authoritative hosted repository identity resolved by its provider. */
export class ResolvedHostedRepository extends Schema.Class<ResolvedHostedRepository>(
  "ResolvedHostedRepository",
)({
  locator: HostedRepositoryLocator,
  providerRepositoryId: Schema.NullOr(ProviderRepositoryId),
  url: WebUrl,
}) {}

/** Provider-neutral hosted review summary. */
export class HostedReviewSummary extends Schema.Class<HostedReviewSummary>("HostedReviewSummary")({
  locator: HostedReviewLocator,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  author: ProviderActor,
  state: Schema.String,
  decision: ReviewDecision,
  url: WebUrl,
  draft: Schema.Boolean,
  base: BranchRevision,
  head: BranchRevision,
  createdAt: Schema.NullOr(UtcIsoTimestamp),
  updatedAt: Schema.NullOr(UtcIsoTimestamp),
}) {}

/** Detailed provider-neutral hosted review metadata. */
export class HostedReviewDetail extends Schema.Class<HostedReviewDetail>("HostedReviewDetail")({
  summary: HostedReviewSummary,
  files: Schema.Array(ChangedFile),
  commits: Schema.Array(ReviewCommit),
}) {}

/** Raw unified diff output and cache metadata for a hosted review. */
export class HostedReviewDiff extends Schema.Class<HostedReviewDiff>("HostedReviewDiff")({
  locator: HostedReviewLocator,
  headRevision: Schema.NullOr(ReviewRevision),
  diff: Schema.String,
  fetchedAt: UtcIsoTimestamp,
}) {}

/** Canonical persisted key for one hosted repository. */
export const makeHostedRepositoryKey = (locator: HostedRepositoryLocator) =>
  `${locator.providerId}:${locator.namespace}/${locator.name}`

/** Canonical persisted key for one hosted review. */
export const makeHostedReviewKey = (locator: HostedReviewLocator) =>
  `${makeHostedRepositoryKey(locator.repository)}#${locator.number}`
