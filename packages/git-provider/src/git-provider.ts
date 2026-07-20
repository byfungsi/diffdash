import { Context, Effect, Layer, Schema } from "effect"

import {
  GitProviderDescriptor,
  GitProviderDiagnostic,
  GitProviderId,
  HostedRepository,
  HostedRepositoryLocator,
  HostedReviewDetail,
  HostedReviewDiff,
  HostedReviewLocator,
  HostedReviewSummary,
  ReviewDecision,
  sameHostedRepository,
  sameHostedReview,
} from "@diffdash/domain/git-provider"

export {
  BranchRevision,
  GitProviderCapabilities,
  GitProviderDescriptor,
  GitProviderDiagnostic,
  GitProviderId,
  GitProviderKind,
  HostedRepository,
  HostedRepositoryLocator,
  HostedRepositoryName,
  HostedReviewDetail,
  HostedReviewDiff,
  HostedReviewLocator,
  HostedReviewNumber,
  HostedReviewSummary,
  ProviderActor,
  RepositoryNamespace,
  ChangedFile,
  ReviewCommit,
  ReviewDecision,
  GitProviderTerminology,
  makeHostedRepositoryKey,
  makeHostedRepositoryLocator,
  makeHostedReviewKey,
  makeHostedReviewLocator,
  sameHostedRepository,
  sameHostedReview,
} from "@diffdash/domain/git-provider"

/** Provider-owned checkout instructions consumed by local workspace management. */
export class HostedReviewCheckoutSpec extends Schema.Class<HostedReviewCheckoutSpec>(
  "HostedReviewCheckoutSpec",
)({
  repository: HostedRepositoryLocator,
  review: HostedReviewLocator,
  remoteUrl: Schema.String,
  fetchRef: Schema.String,
  revision: Schema.String,
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
  kind: Schema.Literal("user", "organization"),
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
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
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
  ) => Effect.Effect<string, GitProviderOperationError>
  readonly fileUrl: (
    repository: HostedRepositoryLocator,
    path: string,
    revision: string,
  ) => Effect.Effect<string, GitProviderOperationError>
  readonly bootstrapBareRepository: (
    repository: HostedRepositoryLocator,
    destination: string,
  ) => Effect.Effect<void, GitProviderOperationError>
  readonly checkoutSpec: (
    review: HostedReviewLocator,
  ) => Effect.Effect<HostedReviewCheckoutSpec, GitProviderOperationError>
  readonly checkoutSpecAtRevision?: (
    review: HostedReviewLocator,
    revision: string,
  ) => Effect.Effect<HostedReviewCheckoutSpec, GitProviderOperationError>
}

/** Registry of configured hosted Git provider instances. */
export class GitProviderRegistry extends Context.Tag("@diffdash/GitProviderRegistry")<
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
>() {
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
            Effect.fromNullable(providers.get(providerId)).pipe(
              Effect.orElseFail(() => UnknownGitProviderError.make({ providerId })),
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
const PublishingTools = Schema.Array(Schema.String.pipe(Schema.minLength(1)))
const RepositoryResults = Schema.Array(HostedRepository)
const ReviewSummaryResults = Schema.Array(HostedReviewSummary)
const SearchScopeResults = Schema.Array(GitRepositorySearchScope)

const providerResultError = (providerId: GitProviderId, operation: string, message: string) =>
  GitProviderOperationError.make({ providerId, operation, message })

const malformedResult = (providerId: GitProviderId, operation: string) =>
  providerResultError(providerId, operation, "Provider returned malformed data")

const wrongProviderResult = (providerId: GitProviderId, operation: string) =>
  providerResultError(providerId, operation, "Provider returned data for another provider")

const wrongTargetResult = (providerId: GitProviderId, operation: string) =>
  providerResultError(providerId, operation, "Provider returned data for another target")

const decodeResult = <A, I>(
  providerId: GitProviderId,
  operation: string,
  schema: Schema.Schema<A, I>,
  value: unknown,
) =>
  Schema.decodeUnknown(schema)(value).pipe(
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
    const descriptor = yield* Schema.decodeUnknown(GitProviderDescriptor)(
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
    const checkoutSpecAtRevision = registration.checkoutSpecAtRevision

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
      ...(listSearchScopes === undefined
        ? {}
        : {
            listSearchScopes: () =>
              invokeProvider(providerId, "listSearchScopes", listSearchScopes).pipe(
                Effect.flatMap((results) =>
                  decodeResult(providerId, "listSearchScopes", SearchScopeResults, results),
                ),
              ),
          }),
      ...(listAssignedReviews === undefined
        ? {}
        : {
            listAssignedReviews: () =>
              invokeProvider(providerId, "listAssignedReviews", listAssignedReviews).pipe(
                Effect.flatMap((results) =>
                  decodeResult(providerId, "listAssignedReviews", ReviewSummaryResults, results),
                ),
                Effect.flatMap((results) =>
                  results.every(({ locator }) => locator.repository.providerId === providerId)
                    ? Effect.succeed(results)
                    : wrongProviderResult(providerId, "listAssignedReviews"),
                ),
              ),
          }),
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
          Effect.flatMap((result) =>
            decodeResult(providerId, "repositoryUrl", Schema.String, result),
          ),
        ),
      fileUrl: (repository, path, revision) =>
        requireRepositoryProvider(providerId, "fileUrl", repository).pipe(
          Effect.andThen(
            invokeProvider(providerId, "fileUrl", () =>
              registration.fileUrl(repository, path, revision),
            ),
          ),
          Effect.flatMap((result) => decodeResult(providerId, "fileUrl", Schema.String, result)),
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
      checkoutSpec: (review) =>
        requireReviewProvider(providerId, "checkoutSpec", review).pipe(
          Effect.andThen(
            invokeProvider(providerId, "checkoutSpec", () => registration.checkoutSpec(review)),
          ),
          Effect.flatMap((result) =>
            decodeResult(providerId, "checkoutSpec", HostedReviewCheckoutSpec, result),
          ),
          Effect.flatMap((result) =>
            sameHostedReview(result.review, review) &&
            sameHostedRepository(result.repository, review.repository)
              ? Effect.succeed(result)
              : wrongTargetResult(providerId, "checkoutSpec"),
          ),
        ),
      ...(checkoutSpecAtRevision === undefined
        ? {}
        : {
            checkoutSpecAtRevision: (review: HostedReviewLocator, revision: string) =>
              requireReviewProvider(providerId, "checkoutSpecAtRevision", review).pipe(
                Effect.andThen(
                  invokeProvider(providerId, "checkoutSpecAtRevision", () =>
                    checkoutSpecAtRevision(review, revision),
                  ),
                ),
                Effect.flatMap((result) =>
                  decodeResult(
                    providerId,
                    "checkoutSpecAtRevision",
                    HostedReviewCheckoutSpec,
                    result,
                  ),
                ),
                Effect.flatMap((result) =>
                  sameHostedReview(result.review, review) &&
                  sameHostedRepository(result.repository, review.repository) &&
                  result.revision === revision
                    ? Effect.succeed(result)
                    : wrongTargetResult(providerId, "checkoutSpecAtRevision"),
                ),
              ),
          }),
    } satisfies GitProviderRegistration
  })
