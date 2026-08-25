import { createHash, randomUUID } from "node:crypto"
import { open, type FileHandle } from "node:fs/promises"
import { basename, join, relative } from "node:path"

import { type HostedReviewDetail, type HostedReviewLocator } from "@diffdash/domain/git-provider"
import { type LocalReviewTarget } from "@diffdash/domain/local-review"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import {
  GitCommitSha,
  makeRepositoryComparisonReviewKey,
  RepositoryComparisonRef,
  repositoryComparisonBaseRevision,
  repositoryComparisonHeadRevision,
  RepositoryComparisonTarget,
} from "@diffdash/domain/repository-comparison"
import {
  HostedReviewSnapshotManifest,
  HostedReviewDescriptor,
  LocalReviewDescriptor,
  LocalReviewSnapshotManifest,
  RepositoryComparisonReviewDescriptor,
  RepositoryComparisonSnapshotManifest,
} from "@diffdash/domain/review-context"
import {
  makeReviewSnapshotId,
  ReviewDiffIdentity,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import {
  LocalReviewDiffSourceTarget,
  ReviewDiffAvailabilityFailure,
  ReviewDiffAcquisition,
  type ReviewDiffByteChunk,
  type ReviewDiffByteCompletion,
  ReviewDiffGeneration,
  reviewDiffStorageRequirement,
  ReviewDiffRevisionChanged,
  ReviewDiffSourceFailure,
  type ReviewDiffSource,
} from "@diffdash/git-provider"
import { makeLocalReviewDiffSource } from "@diffdash/local-git/local-review-diff-source"
import {
  GitService,
  type LocalReviewChangedError,
  makeLocalReviewKey,
} from "@diffdash/local-git/local-git"
import { makeRepositoryComparisonReviewDiffSource } from "@diffdash/local-git/repository-comparison-review-diff-source"
import {
  HostedReviewWorkspacePool,
  HostedReviewWorkspacePoolError,
} from "@diffdash/local-git/hosted-review-workspace-pool"
import {
  CatalogResourceId,
  ResourceCatalog,
  type ResourceCatalogError,
  ResourceRecoveryToken,
  ResourceReservationId,
  type ResourceRootId,
} from "@diffdash/persistence/resource-catalog"
import {
  FileDeltaIdentity,
  type SnapshotStorageSource,
} from "@diffdash/persistence/snapshot-block-store"
import {
  ProcessCancellationError,
  ProcessService,
  processRequest,
  type ProcessExecutionError,
} from "@diffdash/process"
import { Clock, Context, Deferred, Effect, Layer, Match, Schema, Semaphore, Stream } from "effect"

import { toCoreExpectedCause } from "./core-error-cause"
import { CoreAbsolutePath } from "./core-configuration"
import {
  CoreSnapshotIngestion,
  CoreSnapshotIngestionError,
  type CoreSnapshotFileDeltaKeySource,
  type CoreSnapshotIngestionFailure,
  type CoreSnapshotIngestionResult,
} from "./core-snapshot-ingestion"
import {
  GitProvider,
  type GitProviderCallError,
  ReviewContextError,
  type ReviewContextFailureCategory,
} from "./services/git-provider"
import {
  RepositoryComparisonSource,
  RepositoryComparisonOperation,
  RepositoryComparisonSourceError,
} from "./services/repository-comparison-source"
import { RepositoryLinker, type RepositoryLinkError } from "./services/repository-linker"
import { ResourceCollection } from "./resource-collection"

const DIFF_OPTIONS = "--no-ext-diff --no-color"
const FILE_DELTA_IDENTITY_VERSION = 1
const MANAGED_SPOOL_QUOTA_CAUSE_TAG = "managed-spool-quota"
const GIT_METADATA_MAX_BYTES = 64 * 1024 * 1024
const ACQUISITION_DIAGNOSTIC_MAX_BYTES = 256 * 1024
const ACQUISITION_DIAGNOSTIC_FILE = "acquisition-diagnostics.jsonl"

/** Filesystem and quota policy for durable managed review spools. */
export interface CoreSnapshotAcquisitionOptions {
  readonly rootId: ResourceRootId
  readonly rootPath: string
  readonly managedQuotaBytes: number
  readonly reservationLifetimeMs: number
}

/** Existing public failures preserved by hosted snapshot acquisition. */
export type HostedSnapshotAcquisitionFailure = ReviewContextError | RepositoryLinkError

/** Existing public failures preserved by local snapshot acquisition. */
export type LocalSnapshotAcquisitionFailure = ReviewContextError | RepositoryLinkError

/** Core authority for source selection, durable ownership, and progressive snapshot ingestion. */
export class CoreSnapshotAcquisition extends Context.Service<
  CoreSnapshotAcquisition,
  {
    readonly acquireHosted: (
      review: HostedReviewLocator,
    ) => Effect.Effect<HostedReviewSnapshotManifest, HostedSnapshotAcquisitionFailure>
    readonly acquireLocal: (
      target: LocalReviewTarget,
    ) => Effect.Effect<LocalReviewSnapshotManifest, LocalSnapshotAcquisitionFailure>
    readonly acquireComparison: (
      target: RepositoryComparisonTarget,
    ) => Effect.Effect<RepositoryComparisonSnapshotManifest, RepositoryComparisonSourceError>
  }
>()("@diffdash/core/CoreSnapshotAcquisition") {}

/** Builds production snapshot acquisition from provider, local Git, ingestion, and SQL authorities. */
export const coreSnapshotAcquisitionLayer = (
  options: CoreSnapshotAcquisitionOptions,
): Layer.Layer<
  CoreSnapshotAcquisition,
  never,
  | CoreSnapshotIngestion
  | GitProvider
  | GitService
  | ProcessService
  | RepositoryComparisonSource
  | RepositoryLinker
  | ResourceCatalog
  | ResourceCollection
  | HostedReviewWorkspacePool
> =>
  Layer.effect(
    CoreSnapshotAcquisition,
    Effect.gen(function* () {
      const comparisons = yield* RepositoryComparisonSource
      const git = yield* GitService
      const hostedWorkspaces = yield* HostedReviewWorkspacePool
      const ingestion = yield* CoreSnapshotIngestion
      const processes = yield* ProcessService
      const providers = yield* GitProvider
      const repositories = yield* RepositoryLinker
      const resources = yield* ResourceCatalog
      const resourceCollection = yield* ResourceCollection
      const diagnosticLock = yield* Semaphore.make(1)
      const recordFailure = (
        stage: ReviewContextError["operation"],
        cause: CoreSnapshotAcquisitionInternalFailure,
      ) =>
        diagnosticLock.withPermits(1)(persistAcquisitionDiagnostic(options.rootPath, stage, cause))
      const hostedCompleted = new Map<string, HostedReviewSnapshotManifest>()
      const hostedInFlight = new Map<
        string,
        Deferred.Deferred<HostedReviewSnapshotManifest, HostedSnapshotAcquisitionFailure>
      >()
      const localInFlight = new Map<
        string,
        Deferred.Deferred<LocalReviewSnapshotManifest, LocalSnapshotAcquisitionFailure>
      >()

      const ingest = Effect.fn("CoreSnapshotAcquisition.ingest")(function* (input: {
        readonly source: ReviewDiffSource
        readonly projectId: import("@diffdash/domain/review-identity").ReviewProjectId
        readonly baseRevision: ReviewRevision
        readonly descriptor: import("@diffdash/domain/review-context").ReviewDescriptor
        readonly repositoryPath: RepositoryCheckoutPath | null
      }) {
        const source = input.source
        const reviewKey = source.offer.target.reviewKey
        let handedToIngestion = false
        const workflow = Effect.gen(function* () {
          const sourceMaterial = yield* sourceMaterialization(
            source,
            input.repositoryPath,
            processes,
          )
          const prepared =
            reviewDiffStorageRequirement(source.offer.facts) === "managedCompleteSpool"
              ? yield* makeManagedSpoolSource(source, resources, resourceCollection, options)
              : sourceMaterial.storageSource === null
                ? yield* spoolFailure("Exact Git source did not provide materialized objects")
                : { source, storageSource: sourceMaterial.storageSource, discard: Effect.void }
          const acquisition = freshAcquisition(prepared.source)
          const snapshotId = makeReviewSnapshotId({
            reviewKey,
            baseRevision: input.baseRevision,
            headRevision: source.offer.expectedRevision,
            diffIdentity: source.offer.semanticIdentity,
          })
          handedToIngestion = true
          return yield* ingestion
            .ingest({
              source: prepared.source,
              acquisition,
              manifest: {
                projectId: input.projectId,
                snapshotId,
                reviewKey,
                baseRevision: input.baseRevision,
                headRevision: source.offer.expectedRevision,
                semanticIdentity: source.offer.semanticIdentity,
                descriptor: input.descriptor,
                storageSource: prepared.storageSource,
              },
              fileDeltaKeys: sourceMaterial.fileDeltaKeys,
            })
            .pipe(Effect.onError(() => prepared.discard.pipe(Effect.ignore)))
        })
        return yield* workflow.pipe(
          Effect.onExit(() => (handedToIngestion ? Effect.void : source.close.pipe(Effect.ignore))),
        )
      })

      const acquireHostedOnce = Effect.fn("CoreSnapshotAcquisition.acquireHostedOnce")(function* (
        review: HostedReviewLocator,
      ) {
        const project = yield* repositories.ensureHosted(review.repository, "preserve")
        const key = JSON.stringify(review)
        const detail = yield* providers.getHostedReviewDetail(review).pipe(
          Effect.tapError((cause) => recordFailure("hosted.detailAfter", cause)),
          Effect.mapError(reviewFailure("hosted.detailAfter")),
        )
        const cached = hostedCompleted.get(key)
        if (
          cached !== undefined &&
          detail.summary.base.revision !== null &&
          detail.summary.head.revision !== null &&
          cached.baseRevision === detail.summary.base.revision &&
          cached.headRevision === detail.summary.head.revision
        ) {
          return HostedReviewSnapshotManifest.make({
            ...cached,
            detail: { summary: detail.summary },
          })
        }
        const source = yield* providers.getReviewDiffSource(review).pipe(
          Effect.tapError((cause) => recordFailure("hosted.diff", cause)),
          Effect.mapError(reviewFailure("hosted.diff")),
        )
        const revisions = yield* hostedRevisions(detail, source).pipe(
          Effect.onError(() => source.close.pipe(Effect.ignore)),
        )
        const descriptor = HostedReviewDescriptor.make({
          review: detail.summary.locator,
          title: detail.summary.title,
          authorUsername: detail.summary.author.username,
          state: detail.summary.state,
          draft: detail.summary.draft,
          baseRef: detail.summary.base.name,
          headRef: detail.summary.head.name,
          url: detail.summary.url,
        })
        const direct = ingest({
          source,
          projectId: project.id,
          baseRevision: revisions.base,
          descriptor,
          repositoryPath: project.localPath,
        })
        const result = yield* direct.pipe(
          Effect.catch((error) =>
            Schema.is(ReviewDiffAvailabilityFailure)(error) &&
            error.category === "providerGenerationLimit"
              ? Effect.gen(function* () {
                  const checkoutSpec = yield* providers.hostedReviewCheckoutSpec(
                    review,
                    source.offer.expectedRevision,
                  )
                  const baseSha = yield* Schema.decodeUnknownEffect(GitCommitSha)(
                    revisions.base,
                  ).pipe(
                    Effect.mapError(() =>
                      spoolFailure("Hosted review base revision was not a complete Git commit SHA"),
                    ),
                  )
                  const headSha = yield* Schema.decodeUnknownEffect(GitCommitSha)(
                    source.offer.expectedRevision,
                  ).pipe(
                    Effect.mapError(() =>
                      spoolFailure("Hosted review head revision was not a complete Git commit SHA"),
                    ),
                  )
                  const bootstrapBareRepository = (destination: RepositoryCheckoutPath) =>
                    providers.bootstrapBareRepository(
                      review.repository,
                      CoreAbsolutePath.make(destination),
                    )
                  return yield* hostedWorkspaces.useRevision(
                    {
                      repository: review.repository,
                      sourcePath: project.localPath,
                      remoteUrl: checkoutSpec.remoteUrl,
                      revision: headSha,
                      fetchRef: checkoutSpec.fetchRef,
                      bootstrapBareRepository,
                    },
                    () =>
                      hostedWorkspaces
                        .pinComparison({
                          repository: review.repository,
                          sourcePath: project.localPath,
                          remoteUrl: checkoutSpec.remoteUrl,
                          baseRef: RepositoryComparisonRef.make(baseSha),
                          headRef: RepositoryComparisonRef.make(headSha),
                          bootstrapBareRepository,
                        })
                        .pipe(
                          Effect.flatMap((pinned) => {
                            const target = RepositoryComparisonTarget.make({
                              kind: "repositoryComparison",
                              repository: review.repository,
                              baseRef: detail.summary.base.name,
                              headRef: detail.summary.head.name,
                              ...pinned,
                            })
                            return hostedWorkspaces.useComparison(
                              {
                                repository: review.repository,
                                sourcePath: project.localPath,
                                remoteUrl: checkoutSpec.remoteUrl,
                                ...pinned,
                                bootstrapBareRepository,
                              },
                              (repositoryPath) =>
                                makeRepositoryComparisonReviewDiffSource({
                                  reviewKey: source.offer.target.reviewKey,
                                  target,
                                  repositoryPath,
                                }).pipe(
                                  Effect.provideService(ProcessService, processes),
                                  Effect.flatMap((exactSource) =>
                                    ingest({
                                      source: exactSource,
                                      projectId: project.id,
                                      baseRevision: revisions.base,
                                      descriptor,
                                      repositoryPath,
                                    }),
                                  ),
                                ),
                            )
                          }),
                        ),
                  )
                })
              : Effect.fail(error),
          ),
          Effect.tapError((cause) => recordFailure("hosted.snapshot", cause)),
          Effect.mapError(reviewFailure("hosted.snapshot")),
        )
        const manifest = HostedReviewSnapshotManifest.make({
          ...manifestIdentity(result, revisions.base, source.offer.expectedRevision),
          detail: { summary: detail.summary },
        })
        hostedCompleted.set(key, manifest)
        return manifest
      })

      const acquireHosted = Effect.fn("CoreSnapshotAcquisition.acquireHosted")(function* (
        review: HostedReviewLocator,
      ) {
        const key = JSON.stringify(review)
        const candidate = yield* Deferred.make<
          HostedReviewSnapshotManifest,
          HostedSnapshotAcquisitionFailure
        >()
        const pending = yield* Effect.sync(() => {
          const current = hostedInFlight.get(key)
          if (current !== undefined) return current
          hostedInFlight.set(key, candidate)
          return candidate
        })
        if (pending !== candidate) return yield* Deferred.await(pending)

        const exit = yield* Effect.exit(acquireHostedOnce(review))
        yield* Deferred.done(candidate, exit)
        yield* Effect.sync(() => {
          if (hostedInFlight.get(key) === candidate) hostedInFlight.delete(key)
        })
        return yield* Deferred.await(candidate)
      })

      const acquireLocalOnce = Effect.fn("CoreSnapshotAcquisition.acquireLocalOnce")(function* (
        requestedTarget: LocalReviewTarget,
      ) {
        const target = yield* git.validateLocalReviewTarget(requestedTarget).pipe(
          Effect.tapError((cause) => recordFailure("local.snapshot", cause)),
          Effect.mapError(reviewFailure("local.snapshot")),
        )
        const project = yield* repositories.ensureLocal(target.rootPath)
        const reviewKey = makeLocalReviewKey(target.rootPath, target.comparison)
        const source = yield* makeLocalReviewDiffSource({
          reviewKey,
          target,
          stagingDirectory: join(options.rootPath, "review-staging"),
          stagingObserver: {
            publish: (capture) => {
              const relativePath = relative(options.rootPath, capture.directory)
              const resourceId = CatalogResourceId.make(
                `review-staging:${createHash("sha256").update(relativePath).digest("hex")}`,
              )
              return resources
                .register({
                  id: resourceId,
                  parentId: null,
                  kind: "reviewStaging",
                  policyClass: "temporary",
                  state: "ready",
                  generation: 1,
                  location: { kind: "filesystem", rootId: options.rootId, relativePath },
                  bytes: capture.bytes,
                  nowMs: Date.now(),
                  checksum: capture.digest,
                  validation: "verified-local-review-staging-v1",
                })
                .pipe(Effect.asVoid, Effect.mapError(localStagingFailure))
            },
            remove: (capture) => {
              const relativePath = relative(options.rootPath, capture.directory)
              const resourceId = CatalogResourceId.make(
                `review-staging:${createHash("sha256").update(relativePath).digest("hex")}`,
              )
              const nowMs = Date.now()
              return resourceCollection
                .collect({
                  resourceId,
                  recoveryToken: ResourceRecoveryToken.make(`review-staging:${randomUUID()}`),
                  nowMs,
                  retryAtMs: nowMs + 60_000,
                })
                .pipe(Effect.mapError(localStagingFailure))
            },
          },
        }).pipe(
          Effect.provideService(ProcessService, processes),
          Effect.tapError((cause) => recordFailure("local.snapshot", cause)),
          Effect.mapError(reviewFailure("local.snapshot")),
        )
        const baseRevision = yield* localBaseRevision(target, processes).pipe(
          Effect.tapError((cause) => recordFailure("local.snapshot", cause)),
          Effect.mapError(reviewFailure("local.snapshot")),
          Effect.onError(() => source.close.pipe(Effect.ignore)),
        )
        const branchName = yield* git
          .currentBranch(target.rootPath)
          .pipe(Effect.catch(() => Effect.succeed(null)))
        const now = yield* Clock.currentTimeMillis
        const title = Match.value(target.comparison).pipe(
          Match.tag("workingTree", () => "Local changes"),
          Match.tag("branch", (comparison) => `Changes vs ${comparison.branchName}`),
          Match.tag("revision", (comparison) => `Changes vs ${comparison.revision}`),
          Match.tag(
            "revisionRange",
            (comparison) => `${comparison.baseRef}...${comparison.headRef}`,
          ),
          Match.tag("lastCommit", () => "Last commit"),
          Match.exhaustive,
        )
        const result = yield* ingest({
          source,
          projectId: project.id,
          baseRevision,
          descriptor: LocalReviewDescriptor.make({
            target,
            repoName: basename(target.rootPath) || target.rootPath,
            branchName,
            title,
            fetchedAt: new Date(now).toISOString(),
          }),
          repositoryPath: target.rootPath,
        }).pipe(
          Effect.tapError((cause) => recordFailure("local.snapshot", cause)),
          Effect.mapError(reviewFailure("local.snapshot")),
        )
        const detail = {
          rootPath: target.rootPath,
          repoName: basename(target.rootPath) || target.rootPath,
          branchName,
          comparison: target.comparison,
          baseSha: baseRevision,
          headSha: source.offer.expectedRevision,
          diffHash: ReviewDiffIdentity.make(source.offer.semanticIdentity),
          title,
          fetchedAt: new Date(now).toISOString(),
        }
        return LocalReviewSnapshotManifest.make({
          ...manifestIdentity(result, baseRevision, source.offer.expectedRevision),
          detail,
        })
      })

      const acquireLocal = Effect.fn("CoreSnapshotAcquisition.acquireLocal")(function* (
        target: LocalReviewTarget,
      ) {
        const key = JSON.stringify(target)
        const candidate = yield* Deferred.make<
          LocalReviewSnapshotManifest,
          LocalSnapshotAcquisitionFailure
        >()
        const pending = yield* Effect.sync(() => {
          const current = localInFlight.get(key)
          if (current !== undefined) return current
          localInFlight.set(key, candidate)
          return candidate
        })
        if (pending !== candidate) return yield* Deferred.await(pending)

        const exit = yield* Effect.exit(acquireLocalOnce(target))
        yield* Deferred.done(candidate, exit)
        yield* Effect.sync(() => {
          if (localInFlight.get(key) === candidate) localInFlight.delete(key)
        })
        return yield* Deferred.await(candidate)
      })

      const acquireComparison = Effect.fn("CoreSnapshotAcquisition.acquireComparison")(function* (
        target: RepositoryComparisonTarget,
      ) {
        const project = yield* comparisons.repository(target)
        return yield* comparisons.useWorkspace(target, (repositoryPath) =>
          Effect.gen(function* () {
            const source = yield* makeRepositoryComparisonReviewDiffSource({
              reviewKey: makeRepositoryComparisonReviewKey(target),
              target,
              repositoryPath,
            }).pipe(
              Effect.provideService(ProcessService, processes),
              Effect.mapError(comparisonFailure("acquire.source")),
            )
            const baseRevision = repositoryComparisonBaseRevision(target)
            const now = yield* Clock.currentTimeMillis
            const title = `${target.baseRef}...${target.headRef}`
            const result = yield* ingest({
              source,
              projectId: project.id,
              baseRevision,
              descriptor: RepositoryComparisonReviewDescriptor.make({
                target,
                title,
                fetchedAt: new Date(now).toISOString(),
              }),
              repositoryPath,
            }).pipe(Effect.mapError(comparisonFailure("acquire.ingestion")))
            const detail = {
              target,
              title,
              fetchedAt: new Date(now).toISOString(),
            }
            return RepositoryComparisonSnapshotManifest.make({
              ...manifestIdentity(result, baseRevision, repositoryComparisonHeadRevision(target)),
              detail,
            })
          }),
        )
      })

      return CoreSnapshotAcquisition.of({ acquireHosted, acquireLocal, acquireComparison })
    }),
  )

const freshAcquisition = (source: ReviewDiffSource): ReviewDiffAcquisition =>
  ReviewDiffAcquisition.make({
    generation: ReviewDiffGeneration.make(`core:${randomUUID()}`),
    expectedRevision: source.offer.expectedRevision,
  })

const sourceMaterialization = Effect.fn("CoreSnapshotAcquisition.sourceMaterialization")(function* (
  source: ReviewDiffSource,
  repositoryPath: RepositoryCheckoutPath | null,
  processes: ProcessService["Service"],
) {
  if (
    reviewDiffStorageRequirement(source.offer.facts) === "exactGitEligible" &&
    repositoryPath !== null
  ) {
    const exact = Match.value(source.offer.target).pipe(
      Match.tag("local", ({ target }) =>
        Match.value(target.comparison).pipe(
          Match.tag("lastCommit", (comparison) => ({
            baseObject: comparison.baseSha,
            headObject: comparison.headSha,
            diffPolicyIdentity: "local-git-unified-v1",
          })),
          Match.tag("revisionRange", (comparison) => ({
            baseObject: comparison.mergeBaseSha,
            headObject: comparison.headSha,
            diffPolicyIdentity: "local-git-unified-v1",
          })),
          Match.orElse(() => null),
        ),
      ),
      Match.tag("repositoryComparison", ({ target }) => ({
        baseObject: target.mergeBaseSha,
        headObject: target.headSha,
        diffPolicyIdentity: "repository-comparison-git-unified-v1",
      })),
      Match.orElse(() => null),
    )
    if (exact === null) return yield* spoolFailure("Exact Git source target was not reproducible")
    const repositoryIdentity = yield* readRepositoryIdentity(repositoryPath, processes)
    const identities = yield* readExactGitIdentities(
      repositoryPath,
      exact.baseObject,
      exact.headObject,
      exact.diffPolicyIdentity,
      source.offer.semanticIdentity,
      processes,
    )
    return {
      storageSource: {
        kind: "exactGit",
        repositoryIdentity,
        baseObject: exact.baseObject,
        headObject: exact.headObject,
        diffPolicyIdentity: exact.diffPolicyIdentity,
      } satisfies SnapshotStorageSource,
      fileDeltaKeys: identityResolver(identities, source),
    }
  }
  if (repositoryPath !== null && Schema.is(LocalReviewDiffSourceTarget)(source.offer.target)) {
    const comparison = source.offer.target.target.comparison
    const baseObject = Match.value(comparison).pipe(
      Match.tag("workingTree", () => "HEAD"),
      Match.tagsExhaustive({
        branch: ({ baseSha }) => baseSha,
        revision: ({ baseSha }) => baseSha,
        revisionRange: ({ mergeBaseSha }) => mergeBaseSha,
        lastCommit: ({ baseSha }) => baseSha,
      }),
    )
    const identities = yield* readExactGitIdentities(
      repositoryPath,
      baseObject,
      null,
      "local-git-unified-v1",
      source.offer.semanticIdentity,
      processes,
    )
    return {
      storageSource: null,
      fileDeltaKeys: identityResolver(identities, source),
    }
  }
  return {
    storageSource: null,
    fileDeltaKeys: identityResolver(new Map(), source),
  }
})

const readRepositoryIdentity = Effect.fn("CoreSnapshotAcquisition.readRepositoryIdentity")(
  function* (repositoryPath: RepositoryCheckoutPath, processes: ProcessService["Service"]) {
    const result = yield* processes.run(
      processRequest("git", [
        "-C",
        repositoryPath,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
    )
    return createHash("sha256").update(result.stdout.trim()).digest("hex")
  },
)

interface ExactGitFileIdentity {
  readonly oldPath: string
  readonly newPath: string
  readonly identity: typeof FileDeltaIdentity.Type
}

const readExactGitIdentities = Effect.fn("CoreSnapshotAcquisition.readExactGitIdentities")(
  function* (
    repositoryPath: RepositoryCheckoutPath,
    baseObject: string,
    headObject: string | null,
    diffPolicyIdentity: string,
    semanticIdentity: string,
    processes: ProcessService["Service"],
  ) {
    const request = (format: "--raw" | "--numstat") =>
      processRequest(
        "git",
        [
          "-C",
          repositoryPath,
          "diff",
          format,
          "-z",
          ...(format === "--raw" ? ["--full-index", "--no-abbrev"] : []),
          "--no-ext-diff",
          "--no-color",
          baseObject,
          ...(headObject === null ? [] : [headObject]),
          "--",
        ],
        {
          timeoutMs: 60_000,
          stdout: { maxBytes: GIT_METADATA_MAX_BYTES, overflow: "error" },
          stderr: { maxBytes: 64 * 1024, overflow: "truncate" },
        },
      )
    const [raw, numstat] = yield* Effect.all(
      [processes.run(request("--raw")), processes.run(request("--numstat"))],
      { concurrency: 1 },
    )
    return parseExactGitIdentities(raw.stdout, numstat.stdout, diffPolicyIdentity, semanticIdentity)
  },
)

/** Parses NUL-delimited exact Git metadata without restricting legal repository paths. */
export const parseExactGitIdentities = (
  output: string,
  numstatOutput: string,
  diffPolicyIdentity: string,
  semanticIdentity: string,
): ReadonlyMap<string, ExactGitFileIdentity> => {
  const binaryPaths = parseBinaryPaths(numstatOutput)
  const identities = new Map<string, ExactGitFileIdentity>()
  const fields = output.split("\0")
  for (let index = 0; index < fields.length; ) {
    const metadata = fields[index]
    index += 1
    const match = /^:([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([A-Z])\d*$/.exec(metadata ?? "")
    const firstPath = fields[index]
    index += 1
    if (match === null || firstPath === undefined) continue
    const renamed = match[5] === "R" || match[5] === "C"
    const oldPath = firstPath
    const newPath = renamed ? (fields[index] ?? firstPath) : firstPath
    if (renamed) index += 1
    const status = binaryPaths.has(newPath) ? "binary" : rawStatus(match[5] ?? "M")
    const oldObject = match[3] ?? ""
    const newObject = match[4] ?? ""
    const identity = FileDeltaIdentity.make({
      oldContentId: exactObjectIdentity(oldObject, semanticIdentity, "old", oldPath),
      newContentId: exactObjectIdentity(newObject, semanticIdentity, "new", newPath),
      oldMode: match[1] ?? "",
      newMode: match[2] ?? "",
      status,
      diffOptions: DIFF_OPTIONS,
      diffPolicyIdentity,
      identityVersion: FILE_DELTA_IDENTITY_VERSION,
    })
    identities.set(`${oldPath}\u0000${newPath}`, { oldPath, newPath, identity })
    identities.set(newPath, { oldPath, newPath, identity })
  }
  return identities
}

const parseBinaryPaths = (output: string): ReadonlySet<string> => {
  const binaryPaths = new Set<string>()
  const fields = output.split("\0")
  for (let index = 0; index < fields.length; ) {
    const record = fields[index]
    index += 1
    if (record === undefined || record.length === 0) continue
    const firstTab = record.indexOf("\t")
    const secondTab = firstTab === -1 ? -1 : record.indexOf("\t", firstTab + 1)
    if (firstTab === -1 || secondTab === -1) continue
    const additions = record.slice(0, firstTab)
    const deletions = record.slice(firstTab + 1, secondTab)
    let path = record.slice(secondTab + 1)
    if (path.length === 0) {
      index += 1
      path = fields[index] ?? ""
      index += 1
    }
    if (additions === "-" && deletions === "-" && path.length > 0) binaryPaths.add(path)
  }
  return binaryPaths
}

const identityResolver = (
  identities: ReadonlyMap<string, ExactGitFileIdentity>,
  source: ReviewDiffSource,
): CoreSnapshotFileDeltaKeySource => ({
  resolve: ({ ordinal, gitOldPath, gitNewPath, status }) => {
    const exact = identities.get(`${gitOldPath}\u0000${gitNewPath}`) ?? identities.get(gitNewPath)
    if (exact !== undefined) return Effect.succeed(exact.identity)
    return Effect.succeed(
      FileDeltaIdentity.make({
        oldContentId: `source:${source.offer.semanticIdentity}:old:${ordinal}:${gitOldPath}`,
        newContentId: `source:${source.offer.semanticIdentity}:new:${ordinal}:${gitNewPath}`,
        oldMode: "",
        newMode: "",
        status,
        diffOptions: DIFF_OPTIONS,
        diffPolicyIdentity: `managed-spool:${source.offer.semanticIdentity}`,
        identityVersion: FILE_DELTA_IDENTITY_VERSION,
      }),
    )
  },
})

const makeManagedSpoolSource = Effect.fn("CoreSnapshotAcquisition.makeManagedSpoolSource")(
  function* (
    source: ReviewDiffSource,
    resources: ResourceCatalog["Service"],
    resourceCollection: ResourceCollection["Service"],
    options: CoreSnapshotAcquisitionOptions,
  ) {
    const digest = createHash("sha256")
      .update(source.offer.target.reviewKey)
      .update("\0")
      .update(source.offer.semanticIdentity)
      .update("\0")
      .update(randomUUID())
      .digest("hex")
    const resourceId = CatalogResourceId.make(`snapshot-spool:${digest}`)
    const relativePath = `spools/${digest}.patch`
    const path = join(options.rootPath, relativePath)
    const nowMs = yield* Clock.currentTimeMillis
    yield* resources.register({
      id: resourceId,
      parentId: null,
      kind: "snapshot-spool",
      policyClass: "cache",
      state: "writing",
      generation: 1,
      location: { kind: "filesystem", rootId: options.rootId, relativePath },
      bytes: 0,
      nowMs,
      checksum: null,
      validation: null,
    })
    const handle = yield* Effect.tryPromise({
      try: () => open(path, "wx", 0o600),
      catch: () => spoolFailure("Could not create the managed review spool"),
    })
    let closed = false
    let completed = false
    let bytes = 0
    let chunkOrdinal = 0
    const hash = createHash("sha256")
    const closeHandle = Effect.fn("CoreSnapshotAcquisition.closeSpool")(function* () {
      if (closed) return
      closed = true
      yield* Effect.promise(() => handle.close()).pipe(Effect.ignore)
    })
    const copy = Effect.fn("CoreSnapshotAcquisition.copySpoolChunk")(function* (chunk: Uint8Array) {
      const reservationId = ResourceReservationId.make(`spool:${digest}:${chunkOrdinal}`)
      chunkOrdinal += 1
      const reservedAt = yield* Clock.currentTimeMillis
      const reserved = yield* resources.reserve({
        id: reservationId,
        resourceId,
        bytes: chunk.byteLength,
        nowMs: reservedAt,
        expiresAtMs: reservedAt + options.reservationLifetimeMs,
        quotaBytes: options.managedQuotaBytes,
      })
      if (reserved.kind === "quotaExceeded")
        return yield* spoolFailure(
          "The managed review spool quota is exhausted",
          MANAGED_SPOOL_QUOTA_CAUSE_TAG,
        )
      yield* writeAll(handle, chunk)
      bytes += chunk.byteLength
      hash.update(chunk)
      const committedAt = yield* Clock.currentTimeMillis
      yield* resources.commitReservation({
        id: reservationId,
        actualBytes: chunk.byteLength,
        nowMs: committedAt,
      })
      return undefined
    })
    const finish = Effect.fn("CoreSnapshotAcquisition.finishSpool")(function* () {
      if (completed) return
      completed = true
      yield* closeHandle()
      const finalizedAt = yield* Clock.currentTimeMillis
      yield* resources.finalizeWrite({
        resourceId,
        expectedBytes: bytes,
        checksum: `sha256:${hash.digest("hex")}`,
        validation: "complete-unified-diff:v1",
        nowMs: finalizedAt,
      })
    })
    const discard = Effect.gen(function* () {
      if (completed) return
      completed = true
      yield* closeHandle()
      const nowMs = yield* Clock.currentTimeMillis
      yield* resources.finalizeWrite({
        resourceId,
        expectedBytes: bytes,
        checksum: `sha256:${hash.digest("hex")}`,
        validation: "incomplete-unified-diff:v1",
        nowMs,
      })
      yield* resourceCollection.collect({
        resourceId,
        recoveryToken: ResourceRecoveryToken.make(`discard-spool:${randomUUID()}`),
        nowMs,
        retryAtMs: nowMs,
      })
    }).pipe(Effect.mapError(toSpoolSourceFailure))
    const managed: ReviewDiffSource = {
      offer: source.offer,
      unifiedBytes: (acquisition) =>
        source.unifiedBytes(acquisition).pipe(
          Stream.mapEffect(
            (
              event,
            ): Effect.Effect<
              ReviewDiffByteChunk | ReviewDiffByteCompletion,
              ReviewDiffSourceFailure
            > =>
              Effect.gen(function* () {
                if ("bytes" in event) yield* copy(event.bytes)
                else yield* finish()
                return event
              }).pipe(Effect.mapError(toSpoolSourceFailure)),
          ),
        ),
      close: Effect.all([closeHandle(), source.close], { concurrency: 1 }).pipe(Effect.asVoid),
    }
    return {
      source: managed,
      storageSource: { kind: "managedSpool", resourceId } satisfies SnapshotStorageSource,
      discard,
    }
  },
)

const writeAll = (
  handle: FileHandle,
  bytes: Uint8Array,
): Effect.Effect<void, ReviewDiffSourceFailure> =>
  Effect.tryPromise({
    try: () => handle.writeFile(bytes),
    catch: () => spoolFailure("Could not write the managed review spool"),
  }).pipe(Effect.asVoid)

const spoolFailure = (message: string, causeTag?: string): ReviewDiffSourceFailure =>
  ReviewDiffSourceFailure.make({
    generation: ReviewDiffGeneration.make("core-managed-spool"),
    method: "unifiedBytes",
    message,
    causeTag,
  })

const localStagingFailure = (): ReviewDiffSourceFailure =>
  ReviewDiffSourceFailure.make({
    generation: ReviewDiffGeneration.make("local-review-staging"),
    method: "unifiedBytes",
    message: "Could not catalog local review staging",
  })

const toSpoolSourceFailure = (
  error: ResourceCatalogError | ReviewDiffSourceFailure,
): ReviewDiffSourceFailure =>
  Schema.is(ReviewDiffSourceFailure)(error)
    ? error
    : spoolFailure("Could not catalog the managed review spool")

const localBaseRevision = (
  target: LocalReviewTarget,
  processes: ProcessService["Service"],
): Effect.Effect<ReviewRevision, ProcessExecutionError> =>
  Match.value(target.comparison).pipe(
    Match.tag("branch", (comparison) => Effect.succeed(comparison.baseSha)),
    Match.tag("revision", (comparison) => Effect.succeed(comparison.baseSha)),
    Match.tag("revisionRange", (comparison) => Effect.succeed(comparison.mergeBaseSha)),
    Match.tag("lastCommit", (comparison) => Effect.succeed(comparison.baseSha)),
    Match.tag("workingTree", () =>
      processes
        .run(processRequest("git", ["-C", target.rootPath, "rev-parse", "--verify", "HEAD"]))
        .pipe(Effect.map((result) => ReviewRevision.make(result.stdout.trim()))),
    ),
    Match.exhaustive,
  )

const hostedRevisions = (
  detail: HostedReviewDetail,
  source: ReviewDiffSource,
): Effect.Effect<{ readonly base: ReviewRevision }, ReviewContextError> => {
  const base = detail.summary.base.revision
  const head = detail.summary.head.revision
  return base !== null && head === source.offer.expectedRevision
    ? Effect.succeed({ base: ReviewRevision.make(base) })
    : ReviewContextError.make({
        operation: "hosted.snapshot",
        category: "reviewChanged",
        reason: "Hosted review metadata did not match its committed diff source",
        cause: new Error("Hosted review revisions changed before ingestion"),
      })
}

const manifestIdentity = (
  result: CoreSnapshotIngestionResult,
  baseRevision: ReviewRevision,
  headRevision: ReviewRevision,
) => ({
  projectId: result.projectId,
  snapshotId: result.snapshotId,
  reviewKey: result.reviewKey,
  baseRevision,
  headRevision,
  fileCount: result.fileCount,
})

const exactObjectIdentity = (
  object: string,
  semanticIdentity: string,
  side: "old" | "new",
  path: string,
): string => (/^0+$/.test(object) ? `source:${semanticIdentity}:${side}:${path}` : `git:${object}`)

const rawStatus = (status: string): FileDeltaIdentity["status"] => {
  switch (status) {
    case "A":
      return "added"
    case "D":
      return "deleted"
    case "R":
    case "C":
      return "renamed"
    default:
      return "modified"
  }
}

type CoreSnapshotAcquisitionInternalFailure =
  | CoreSnapshotIngestionFailure
  | GitProviderCallError
  | HostedReviewWorkspacePoolError
  | LocalReviewChangedError
  | ProcessExecutionError
  | ResourceCatalogError
  | ReviewDiffSourceFailure

const persistAcquisitionDiagnostic = (
  rootPath: string,
  stage: ReviewContextError["operation"],
  cause: CoreSnapshotAcquisitionInternalFailure,
): Effect.Effect<void> => {
  const details = reviewFailureDetails(cause)
  const typedReason = Schema.is(CoreSnapshotIngestionError)(cause) ? cause.reason : details.category
  const line = `${JSON.stringify({
    timestamp: new Date().toISOString(),
    stage,
    category: details.category,
    typedReason,
  })}\n`
  return Effect.tryPromise(async () => {
    const file = await open(join(rootPath, ACQUISITION_DIAGNOSTIC_FILE), "a+", 0o600)
    try {
      const stat = await file.stat()
      if (stat.size + Buffer.byteLength(line) > ACQUISITION_DIAGNOSTIC_MAX_BYTES) {
        await file.truncate(0)
      }
      await file.writeFile(line)
    } finally {
      await file.close()
    }
  }).pipe(Effect.catch(() => Effect.void))
}

const reviewFailure =
  (operation: ReviewContextError["operation"]) =>
  (cause: CoreSnapshotAcquisitionInternalFailure): ReviewContextError => {
    const details = reviewFailureDetails(cause)
    return ReviewContextError.make({
      operation,
      ...details,
      cause: toCoreExpectedCause(cause),
    })
  }

const reviewFailureDetails = (
  cause: CoreSnapshotAcquisitionInternalFailure,
): { readonly category: ReviewContextFailureCategory; readonly reason: string } => {
  if (Schema.is(ReviewDiffAvailabilityFailure)(cause)) {
    switch (cause.category) {
      case "authenticationRequired":
        return {
          category: "authenticationRequired",
          reason: "The Git provider needs authentication before this review can be loaded",
        }
      case "authorizationRequired":
        return {
          category: "authorizationRequired",
          reason: "The Git provider account cannot access this review diff",
        }
      case "transientProviderFailure":
        return {
          category: "providerUnavailable",
          reason: "The Git provider is temporarily unable to generate this review diff",
        }
      case "providerGenerationLimit":
        return {
          category: "fallbackFailed",
          reason: "The provider diff was too large and the exact Git fallback could not load it",
        }
    }
  }
  if (Schema.is(ReviewDiffRevisionChanged)(cause)) {
    return {
      category: "reviewChanged",
      reason: "The review changed while its diff was loading; retry to open the latest revision",
    }
  }
  if (Schema.is(HostedReviewWorkspacePoolError)(cause)) {
    if (cause.code === "revision-changed") {
      return {
        category: "reviewChanged",
        reason: "The review changed while its exact Git fallback was loading",
      }
    }
    return {
      category: "fallbackFailed",
      reason:
        "The provider diff was unavailable and the exact Git fallback could not prepare the review",
    }
  }
  if (
    Schema.is(ReviewDiffSourceFailure)(cause) &&
    cause.causeTag === MANAGED_SPOOL_QUOTA_CAUSE_TAG
  ) {
    return {
      category: "cacheFull",
      reason: "The managed review cache is full; clear cached data and retry",
    }
  }
  if (Schema.is(CoreSnapshotIngestionError)(cause) && cause.reason === "hunkTooLarge") {
    return {
      category: "contentTooLarge",
      reason:
        "The review contains an individual diff line or hunk that exceeds the supported limit",
    }
  }
  if (Schema.is(CoreSnapshotIngestionError)(cause) && cause.reason === "quotaExceeded") {
    return {
      category: "cacheFull",
      reason: "The managed review cache is full; clear cached data and retry",
    }
  }
  if (
    Schema.is(CoreSnapshotIngestionError)(cause) &&
    (cause.reason === "identityMismatch" || cause.reason === "invalidEventOrder")
  ) {
    return {
      category: "snapshotInvalid",
      reason: "The streamed review data did not form a coherent snapshot",
    }
  }
  if (Schema.is(CoreSnapshotIngestionError)(cause) && cause.reason === "verificationFailed") {
    return {
      category: "cacheCorrupt",
      reason: "The managed review cache could not verify the acquired snapshot",
    }
  }
  if (Schema.is(ProcessCancellationError)(cause)) {
    return {
      category: "cancelled",
      reason: "The review acquisition was cancelled before it completed",
    }
  }
  return { category: "acquisitionFailed", reason: "Unable to load review context" }
}

const comparisonFailure =
  (operation: string) =>
  (cause: CoreSnapshotAcquisitionInternalFailure): RepositoryComparisonSourceError =>
    RepositoryComparisonSourceError.make({
      code: "acquisition-failed",
      operation: RepositoryComparisonOperation.make(operation),
      reason: "DiffDash could not acquire the repository comparison snapshot.",
      cause: toCoreExpectedCause(cause),
    })
