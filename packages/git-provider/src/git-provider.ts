import { Context, Effect, Layer, Option, Schema } from "effect"

import {
  GitProviderDescriptor,
  GitProviderDiagnostic,
  GitFileRevision,
  GitProviderId,
  HostedRepository,
  HostedRepositoryLocator,
  ResolvedHostedRepository,
  HostedReviewDetail,
  HostedReviewDiff,
  HostedReviewLocator,
  HostedReviewSummary,
  ReviewDecision,
  ReviewRevision,
  sameHostedRepository,
  sameHostedReview,
} from "@diffdash/domain/git-provider"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { WebUrl } from "@diffdash/domain/web-url"
import { DiagnosticOperation } from "@diffdash/domain/diagnostic-operation"
import { makeReviewKey } from "@diffdash/domain/review-identity"
import {
  HostedReviewDiffSourceTarget,
  ReviewDiffSourceOffer,
  validateReviewDiffSourceOffer,
  type ReviewDiffSource,
} from "./review-diff-source"

export {
  BranchRevision,
  GitProviderCapabilities,
  GitProviderDescriptor,
  GitProviderDiagnostic,
  GitProviderId,
  GitFileRevision,
  GitProviderKind,
  HostedRepository,
  HostedRepositoryLocator,
  HostedRepositoryName,
  ProviderRepositoryId,
  ResolvedHostedRepository,
  HostedReviewDetail,
  HostedReviewDiff,
  HostedReviewLocator,
  HostedReviewNumber,
  HostedReviewSummary,
  ProviderActor,
  ProviderActorId,
  RepositoryNamespace,
  RepositoryRelativePath,
  ChangedFile,
  ReviewCommit,
  ReviewDecision,
  ReviewRevision,
  GitProviderTerminology,
  makeHostedRepositoryKey,
  makeHostedRepositoryLocator,
  makeHostedReviewKey,
  makeHostedReviewLocator,
  sameHostedRepository,
  sameHostedReview,
} from "@diffdash/domain/git-provider"
export { DiffFileStatus } from "@diffdash/domain/diff"
export { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
export { WebUrl } from "@diffdash/domain/web-url"
export { DiagnosticOperation } from "@diffdash/domain/diagnostic-operation"
export { makeReviewKey, ReviewKey } from "@diffdash/domain/review-identity"
export * from "./review-diff-source"

/** Provider-owned checkout instructions consumed by local workspace management. */
export class HostedReviewCheckoutSpec extends Schema.Class<HostedReviewCheckoutSpec>(
  "HostedReviewCheckoutSpec",
)({
  repository: HostedRepositoryLocator,
  review: HostedReviewLocator,
  remoteUrl: Schema.String,
  fetchRef: RepositoryComparisonRef,
  revision: ReviewRevision,
}) {}

/** Provider-neutral repository search input. */
export class GitRepositorySearchInput extends Schema.Class<GitRepositorySearchInput>(
  "GitRepositorySearchInput",
)({
  query: Schema.String,
  namespaces: Schema.Array(Schema.String),
}) {}

/** Provider-neutral account or organization available as a repository search scope. */
export class GitRepositorySearchScope extends Schema.Class<GitRepositorySearchScope>(
  "GitRepositorySearchScope",
)({
  login: Schema.String,
  kind: Schema.Literals(["user", "organization"]),
}) {}

/** Unknown configured provider ID. */
export class UnknownGitProviderError extends Schema.TaggedError<UnknownGitProviderError>()(
  "UnknownGitProviderError",
  { providerId: GitProviderId },
) {}

/** Duplicate configured provider ID. */
export class DuplicateGitProviderError extends Schema.TaggedError<DuplicateGitProviderError>()(
  "DuplicateGitProviderError",
  { providerId: GitProviderId },
) {}

/** More than one registered provider accepted the same remote. */
export class AmbiguousGitRemoteError extends Schema.TaggedError<AmbiguousGitRemoteError>()(
  "AmbiguousGitRemoteError",
  { remoteUrl: Schema.String, providerIds: Schema.Array(GitProviderId) },
) {}

/** Recoverable failure returned by one provider implementation. */
export class GitProviderOperationError extends Schema.TaggedError<GitProviderOperationError>()(
  "GitProviderOperationError",
  {
    providerId: GitProviderId,
    operation: DiagnosticOperation,
    message: Schema.String,
    cause: Schema.optional(Schema.ErrorInstance()),
  },
) {}

/** Errors exposed by provider and registry operations. */
export type GitProviderError =
  | UnknownGitProviderError
  | DuplicateGitProviderError
  | AmbiguousGitRemoteError
  | GitProviderOperationError

/** Complete leaf-provider contract implemented by hosted Git integrations. */
export interface GitProviderRegistration {
  readonly descriptor: GitProviderDescriptor
  /** Executables or agent tools capable of publishing provider-side review state. */
  readonly publishingTools: readonly string[]
  readonly diagnose: Effect.Effect<GitProviderDiagnostic, GitProviderOperationError>
  readonly parseRemote: (
    remoteUrl: string,
  ) => Effect.Effect<HostedRepositoryLocator | null, GitProviderOperationError>
  readonly resolveRepository?: (
    repository: HostedRepositoryLocator,
  ) => Effect.Effect<ResolvedHostedRepository, GitProviderOperationError>
  readonly searchRepositories: (
    input: GitRepositorySearchInput,
  ) => Effect.Effect<readonly HostedRepository[], GitProviderOperationError>
  readonly listSearchScopes?: () => Effect.Effect<
    readonly GitRepositorySearchScope[],
    GitProviderOperationError
  >
  readonly listAssignedReviews?: () => Effect.Effect<
    readonly HostedReviewSummary[],
    GitProviderOperationError
  >
  readonly listReviews: (
    repository: HostedRepositoryLocator,
  ) => Effect.Effect<readonly HostedReviewSummary[], GitProviderOperationError>
  readonly getReview: (
    review: HostedReviewLocator,
  ) => Effect.Effect<HostedReviewDetail, GitProviderOperationError>
  /** Opens the bounded source for one hosted review without materializing a complete diff string. */
  readonly getReviewDiffSource: (
    review: HostedReviewLocator,
  ) => Effect.Effect<ReviewDiffSource, GitProviderOperationError>
  /** @deprecated Use `getReviewDiffSource` for production review ingestion. */
  readonly getReviewDiff: (
    review: HostedReviewLocator,
  ) => Effect.Effect<HostedReviewDiff, GitProviderOperationError>
  readonly getReviewDecision: (
    review: HostedReviewLocator,
  ) => Effect.Effect<ReviewDecision, GitProviderOperationError>
  readonly submitReviewDecision: (
    review: HostedReviewLocator,
    decision: ReviewDecision,
  ) => Effect.Effect<void, GitProviderOperationError>
  readonly repositoryUrl: (
    repository: HostedRepositoryLocator,
  ) => Effect.Effect<WebUrl, GitProviderOperationError>
  readonly fileUrl: (
    repository: HostedRepositoryLocator,
    path: RepositoryRelativePath,
    revision: GitFileRevision,
  ) => Effect.Effect<WebUrl, GitProviderOperationError>
  readonly bootstrapBareRepository: (
    repository: HostedRepositoryLocator,
    destination: string,
  ) => Effect.Effect<void, GitProviderOperationError>
  readonly checkoutSpec: (
    review: HostedReviewLocator,
    revision: ReviewRevision,
  ) => Effect.Effect<HostedReviewCheckoutSpec, GitProviderOperationError>
}

/** Registry of configured hosted Git provider instances. */
export class GitProviderRegistry extends Context.Service<
  GitProviderRegistry,
  {
    readonly list: Effect.Effect<readonly GitProviderRegistration[]>
    readonly get: (
      providerId: GitProviderId,
    ) => Effect.Effect<GitProviderRegistration, UnknownGitProviderError>
    readonly resolveRemote: (
      remoteUrl: string,
    ) => Effect.Effect<
      HostedRepositoryLocator | null,
      AmbiguousGitRemoteError | GitProviderOperationError
    >
  }
>()("@diffdash/GitProviderRegistry") {
  /** Builds a registry and fails immediately when instance IDs collide. */
  static readonly layer = (registrations: readonly GitProviderRegistration[]) =>
    Layer.effect(
      GitProviderRegistry,
      Effect.gen(function* () {
        const providers = new Map<GitProviderId, GitProviderRegistration>()
        for (const registration of registrations) {
          const validated = yield* validateRegistration(registration)
          if (providers.has(validated.descriptor.id)) {
            return yield* DuplicateGitProviderError.make({
              providerId: validated.descriptor.id,
            })
          }
          providers.set(validated.descriptor.id, validated)
        }

        return GitProviderRegistry.of({
          list: Effect.succeed([...providers.values()]),
          get: (providerId) =>
            Effect.fromOption(Option.fromNullishOr(providers.get(providerId)), () =>
              UnknownGitProviderError.make({ providerId }),
            ),
          resolveRemote: Effect.fn("GitProviderRegistry.resolveRemote")(function* (remoteUrl) {
            const matches = (yield* Effect.all(
              [...providers.values()].map((provider) => provider.parseRemote(remoteUrl)),
              { concurrency: "unbounded" },
            )).filter((match): match is HostedRepositoryLocator => match !== null)
            if (matches.length > 1) {
              return yield* AmbiguousGitRemoteError.make({
                remoteUrl,
                providerIds: matches.map(({ providerId }) => providerId),
              })
            }
            return matches[0] ?? null
          }),
        })
      }),
    )
}

const InvalidRegistrationProviderId = GitProviderId.make("invalid-provider")
const PublishingTools = Schema.Array(Schema.String.pipe(Schema.check(Schema.isMinLength(1))))
const RepositoryResults = Schema.Array(HostedRepository)
const ReviewSummaryResults = Schema.Array(HostedReviewSummary)
const SearchScopeResults = Schema.Array(GitRepositorySearchScope)

const providerResultError = (providerId: GitProviderId, operation: string, message: string) =>
  GitProviderOperationError.make({
    providerId,
    operation: DiagnosticOperation.make(operation),
    message,
  })

const malformedResult = (providerId: GitProviderId, operation: string) =>
  providerResultError(providerId, operation, "Provider returned malformed data")

const wrongProviderResult = (providerId: GitProviderId, operation: string) =>
  providerResultError(providerId, operation, "Provider returned data for another provider")

const wrongTargetResult = (providerId: GitProviderId, operation: string) =>
  providerResultError(providerId, operation, "Provider returned data for another target")

const decodeResult = <A, I>(
  providerId: GitProviderId,
  operation: string,
  schema: Schema.Codec<A, I, never, never>,
  value: I,
) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => malformedResult(providerId, operation)),
  )

const invokeProvider = <A>(
  providerId: GitProviderId,
  operation: string,
  invoke: () => Effect.Effect<A, GitProviderOperationError>,
) =>
  Effect.try({
    try: invoke,
    catch: () => malformedResult(providerId, operation),
  }).pipe(Effect.flatten)

const requireRepositoryProvider = (
  providerId: GitProviderId,
  operation: string,
  repository: HostedRepositoryLocator,
) =>
  repository.providerId === providerId ? Effect.void : wrongProviderResult(providerId, operation)

const requireReviewProvider = (
  providerId: GitProviderId,
  operation: string,
  review: HostedReviewLocator,
) => requireRepositoryProvider(providerId, operation, review.repository)

const validateRegistration = (registration: GitProviderRegistration) =>
  Effect.gen(function* () {
    const descriptor = yield* Schema.decodeUnknownEffect(GitProviderDescriptor)(
      registration.descriptor,
    ).pipe(
      Effect.mapError(() => malformedResult(InvalidRegistrationProviderId, "register.descriptor")),
    )
    const providerId = descriptor.id
    const publishingTools = yield* decodeResult(
      providerId,
      "register.publishingTools",
      PublishingTools,
      registration.publishingTools,
    )
    const listSearchScopes = registration.listSearchScopes
    const listAssignedReviews = registration.listAssignedReviews
    const resolveRepository = registration.resolveRepository
    type OptionalRegistrationMethod =
      | "resolveRepository"
      | "listSearchScopes"
      | "listAssignedReviews"
    const optionalRegistration: {
      [Key in OptionalRegistrationMethod]?: Exclude<GitProviderRegistration[Key], undefined>
    } = {}
    if (resolveRepository !== undefined) {
      optionalRegistration.resolveRepository = (repository) =>
        requireRepositoryProvider(providerId, "resolveRepository", repository).pipe(
          Effect.andThen(
            invokeProvider(providerId, "resolveRepository", () => resolveRepository(repository)),
          ),
          Effect.flatMap((result) =>
            decodeResult(providerId, "resolveRepository", ResolvedHostedRepository, result),
          ),
          Effect.flatMap((result) =>
            result.locator.providerId === providerId
              ? Effect.succeed(result)
              : wrongProviderResult(providerId, "resolveRepository"),
          ),
        )
    }
    if (listSearchScopes !== undefined) {
      optionalRegistration.listSearchScopes = () =>
        invokeProvider(providerId, "listSearchScopes", listSearchScopes).pipe(
          Effect.flatMap((results) =>
            decodeResult(providerId, "listSearchScopes", SearchScopeResults, results),
          ),
        )
    }
    if (listAssignedReviews !== undefined) {
      optionalRegistration.listAssignedReviews = () =>
        invokeProvider(providerId, "listAssignedReviews", listAssignedReviews).pipe(
          Effect.flatMap((results) =>
            decodeResult(providerId, "listAssignedReviews", ReviewSummaryResults, results),
          ),
          Effect.flatMap((results) =>
            results.every(({ locator }) => locator.repository.providerId === providerId)
              ? Effect.succeed(results)
              : wrongProviderResult(providerId, "listAssignedReviews"),
          ),
        )
    }

    return {
      descriptor,
      publishingTools,
      diagnose: registration.diagnose.pipe(
        Effect.flatMap((diagnostic) =>
          decodeResult(providerId, "diagnose", GitProviderDiagnostic, diagnostic),
        ),
        Effect.flatMap((diagnostic) =>
          diagnostic.providerId === providerId
            ? Effect.succeed(diagnostic)
            : wrongProviderResult(providerId, "diagnose"),
        ),
      ),
      parseRemote: (remoteUrl) =>
        invokeProvider(providerId, "parseRemote", () => registration.parseRemote(remoteUrl)).pipe(
          Effect.flatMap((result) =>
            decodeResult(providerId, "parseRemote", Schema.NullOr(HostedRepositoryLocator), result),
          ),
          Effect.flatMap((result) =>
            result === null || result.providerId === providerId
              ? Effect.succeed(result)
              : wrongProviderResult(providerId, "parseRemote"),
          ),
        ),
      ...optionalRegistration,
      searchRepositories: (input) =>
        invokeProvider(providerId, "searchRepositories", () =>
          registration.searchRepositories(input),
        ).pipe(
          Effect.flatMap((results) =>
            decodeResult(providerId, "searchRepositories", RepositoryResults, results),
          ),
          Effect.flatMap((results) =>
            results.every(({ locator }) => locator.providerId === providerId)
              ? Effect.succeed(results)
              : wrongProviderResult(providerId, "searchRepositories"),
          ),
        ),
      listReviews: (repository) =>
        requireRepositoryProvider(providerId, "listReviews", repository).pipe(
          Effect.andThen(
            invokeProvider(providerId, "listReviews", () => registration.listReviews(repository)),
          ),
          Effect.flatMap((results) =>
            decodeResult(providerId, "listReviews", ReviewSummaryResults, results),
          ),
          Effect.flatMap((results) =>
            results.every(({ locator }) => sameHostedRepository(locator.repository, repository))
              ? Effect.succeed(results)
              : wrongTargetResult(providerId, "listReviews"),
          ),
        ),
      getReview: (review) =>
        requireReviewProvider(providerId, "getReview", review).pipe(
          Effect.andThen(
            invokeProvider(providerId, "getReview", () => registration.getReview(review)),
          ),
          Effect.flatMap((result) =>
            decodeResult(providerId, "getReview", HostedReviewDetail, result),
          ),
          Effect.flatMap((result) =>
            sameHostedReview(result.summary.locator, review)
              ? Effect.succeed(result)
              : wrongTargetResult(providerId, "getReview"),
          ),
        ),
      getReviewDiffSource: (review) =>
        requireReviewProvider(providerId, "getReviewDiffSource", review).pipe(
          Effect.andThen(
            invokeProvider(providerId, "getReviewDiffSource", () =>
              registration.getReviewDiffSource(review),
            ),
          ),
          Effect.flatMap((source) =>
            decodeResult(
              providerId,
              "getReviewDiffSource.offer",
              ReviewDiffSourceOffer,
              source.offer,
            ).pipe(
              Effect.flatMap((offer) =>
                validateReviewDiffSourceOffer(offer).pipe(
                  Effect.mapError(() => malformedResult(providerId, "getReviewDiffSource.offer")),
                ),
              ),
              Effect.flatMap((offer) =>
                Schema.is(HostedReviewDiffSourceTarget)(offer.target) &&
                offer.target.reviewKey === makeReviewKey(review) &&
                sameHostedReview(offer.target.review, review)
                  ? Effect.succeed(source)
                  : wrongTargetResult(providerId, "getReviewDiffSource"),
              ),
              Effect.onError(() => source.close.pipe(Effect.ignore)),
            ),
          ),
        ),
      getReviewDiff: (review) =>
        requireReviewProvider(providerId, "getReviewDiff", review).pipe(
          Effect.andThen(
            invokeProvider(providerId, "getReviewDiff", () => registration.getReviewDiff(review)),
          ),
          Effect.flatMap((result) =>
            decodeResult(providerId, "getReviewDiff", HostedReviewDiff, result),
          ),
          Effect.flatMap((result) =>
            sameHostedReview(result.locator, review)
              ? Effect.succeed(result)
              : wrongTargetResult(providerId, "getReviewDiff"),
          ),
        ),
      getReviewDecision: (review) =>
        requireReviewProvider(providerId, "getReviewDecision", review).pipe(
          Effect.andThen(
            invokeProvider(providerId, "getReviewDecision", () =>
              registration.getReviewDecision(review),
            ),
          ),
          Effect.flatMap((result) =>
            decodeResult(providerId, "getReviewDecision", ReviewDecision, result),
          ),
        ),
      submitReviewDecision: (review, decision) =>
        requireReviewProvider(providerId, "submitReviewDecision", review).pipe(
          Effect.andThen(
            invokeProvider(providerId, "submitReviewDecision", () =>
              registration.submitReviewDecision(review, decision),
            ),
          ),
          Effect.flatMap((result) =>
            decodeResult(providerId, "submitReviewDecision", Schema.Void, result),
          ),
        ),
      repositoryUrl: (repository) =>
        requireRepositoryProvider(providerId, "repositoryUrl", repository).pipe(
          Effect.andThen(
            invokeProvider(providerId, "repositoryUrl", () =>
              registration.repositoryUrl(repository),
            ),
          ),
          Effect.flatMap((result) => decodeResult(providerId, "repositoryUrl", WebUrl, result)),
        ),
      fileUrl: (repository, path, revision) =>
        requireRepositoryProvider(providerId, "fileUrl", repository).pipe(
          Effect.andThen(
            invokeProvider(providerId, "fileUrl", () =>
              registration.fileUrl(repository, path, revision),
            ),
          ),
          Effect.flatMap((result) => decodeResult(providerId, "fileUrl", WebUrl, result)),
        ),
      bootstrapBareRepository: (repository, destination) =>
        requireRepositoryProvider(providerId, "bootstrapBareRepository", repository).pipe(
          Effect.andThen(
            invokeProvider(providerId, "bootstrapBareRepository", () =>
              registration.bootstrapBareRepository(repository, destination),
            ),
          ),
          Effect.flatMap((result) =>
            decodeResult(providerId, "bootstrapBareRepository", Schema.Void, result),
          ),
        ),
      checkoutSpec: (review, revision) =>
        requireReviewProvider(providerId, "checkoutSpec", review).pipe(
          Effect.andThen(
            invokeProvider(providerId, "checkoutSpec", () =>
              registration.checkoutSpec(review, revision),
            ),
          ),
          Effect.flatMap((result) =>
            decodeResult(providerId, "checkoutSpec", HostedReviewCheckoutSpec, result),
          ),
          Effect.flatMap((result) =>
            sameHostedReview(result.review, review) &&
            sameHostedRepository(result.repository, review.repository) &&
            result.revision === revision
              ? Effect.succeed(result)
              : wrongTargetResult(providerId, "checkoutSpec"),
          ),
        ),
    } satisfies GitProviderRegistration
  })
