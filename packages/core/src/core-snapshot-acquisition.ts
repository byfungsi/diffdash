import { createHash, randomUUID } from "node:crypto"
import { open, type FileHandle } from "node:fs/promises"
import { basename, join, relative } from "node:path"

import {
  ChangedFile,
  type HostedReviewDetail,
  type HostedReviewLocator,
} from "@diffdash/domain/git-provider"
import { LocalReviewDetail, type LocalReviewTarget } from "@diffdash/domain/local-review"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import {
  makeRepositoryComparisonReviewKey,
  RepositoryComparisonDetail,
  repositoryComparisonBaseRevision,
  repositoryComparisonHeadRevision,
  type RepositoryComparisonTarget,
} from "@diffdash/domain/repository-comparison"
import {
  HostedReviewSnapshotManifest,
  HostedReviewDescriptor,
  LocalReviewDescriptor,
  LocalReviewSnapshotManifest,
  RepositoryComparisonReviewDescriptor,
  RepositoryComparisonSnapshotManifest,
  ReviewSnapshotFileInventory,
} from "@diffdash/domain/review-context"
import {
  makeReviewSnapshotId,
  ReviewDiffIdentity,
  ReviewFileId,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  LocalReviewDiffSourceTarget,
  ReviewDiffAcquisition,
  type ReviewDiffByteChunk,
  type ReviewDiffByteCompletion,
  ReviewDiffGeneration,
  reviewDiffStorageRequirement,
  ReviewDiffSourceFailure,
  type ReviewDiffSource,
} from "@diffdash/git-provider"
import { makeLocalReviewDiffSource } from "@diffdash/local-git/local-review-diff-source"
import { GitService, makeLocalReviewKey } from "@diffdash/local-git/local-git"
import { makeRepositoryComparisonReviewDiffSource } from "@diffdash/local-git/repository-comparison-review-diff-source"
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
import { ProcessService, processRequest, type ProcessExecutionError } from "@diffdash/process"
import { Clock, Context, Effect, Layer, Match, Schema, Stream } from "effect"

import { toCoreExpectedCause } from "./core-error-cause"
import {
  CoreSnapshotIngestion,
  type CoreSnapshotFileDeltaKeySource,
  type CoreSnapshotIngestionFailure,
  type CoreSnapshotIngestionResult,
} from "./core-snapshot-ingestion"
import { GitProvider, type GitProviderCallError, ReviewContextError } from "./services/git-provider"
import {
  RepositoryComparisonSource,
  RepositoryComparisonOperation,
  RepositoryComparisonSourceError,
} from "./services/repository-comparison-source"
import { RepositoryLinker, type RepositoryLinkError } from "./services/repository-linker"
import { ResourceCollection } from "./resource-collection"

const DIFF_OPTIONS = "--no-ext-diff --no-color"
const FILE_DELTA_IDENTITY_VERSION = 1
const GIT_METADATA_MAX_BYTES = 64 * 1024 * 1024

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
> =>
  Layer.effect(
    CoreSnapshotAcquisition,
    Effect.gen(function* () {
      const comparisons = yield* RepositoryComparisonSource
      const git = yield* GitService
      const ingestion = yield* CoreSnapshotIngestion
      const processes = yield* ProcessService
      const providers = yield* GitProvider
      const repositories = yield* RepositoryLinker
      const resources = yield* ResourceCatalog
      const resourceCollection = yield* ResourceCollection

      const ingest = Effect.fn("CoreSnapshotAcquisition.ingest")(function* (input: {
        readonly source: ReviewDiffSource
        readonly projectId: import("@diffdash/domain/review-identity").ReviewProjectId
        readonly baseRevision: ReviewRevision
        readonly descriptor: import("@diffdash/domain/review-context").ReviewDescriptor
        readonly repositoryPath: RepositoryCheckoutPath | null
        readonly statusByPath: ReadonlyMap<string, FileDeltaIdentity["status"]>
      }) {
        const source = input.source
        const reviewKey = source.offer.target.reviewKey
        let handedToIngestion = false
        const workflow = Effect.gen(function* () {
          const sourceMaterial = yield* sourceMaterialization(
            source,
            input.repositoryPath,
            input.statusByPath,
            processes,
          )
          const prepared =
            reviewDiffStorageRequirement(source.offer.facts) === "managedCompleteSpool"
              ? yield* makeManagedSpoolSource(source, resources, options)
              : sourceMaterial.storageSource === null
                ? yield* spoolFailure("Exact Git source did not provide materialized objects")
                : { source, storageSource: sourceMaterial.storageSource }
          const acquisition = freshAcquisition(prepared.source)
          const snapshotId = makeReviewSnapshotId({
            reviewKey,
            baseRevision: input.baseRevision,
            headRevision: source.offer.expectedRevision,
            diffIdentity: source.offer.semanticIdentity,
          })
          handedToIngestion = true
          return yield* ingestion.ingest({
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
        })
        return yield* workflow.pipe(
          Effect.onExit(() => (handedToIngestion ? Effect.void : source.close.pipe(Effect.ignore))),
        )
      })

      const acquireHosted = Effect.fn("CoreSnapshotAcquisition.acquireHosted")(function* (
        review: HostedReviewLocator,
      ) {
        const project = yield* repositories.ensureHosted(review.repository, "preserve")
        const source = yield* providers
          .getReviewDiffSource(review)
          .pipe(Effect.mapError(reviewFailure("hosted.diff")))
        const detail = yield* providers.getHostedReviewDetail(review).pipe(
          Effect.mapError(reviewFailure("hosted.detailAfter")),
          Effect.onError(() => source.close.pipe(Effect.ignore)),
        )
        const revisions = yield* hostedRevisions(detail, source).pipe(
          Effect.onError(() => source.close.pipe(Effect.ignore)),
        )
        const result = yield* ingest({
          source,
          projectId: project.id,
          baseRevision: revisions.base,
          descriptor: HostedReviewDescriptor.make({
            review: detail.summary.locator,
            title: detail.summary.title,
            authorUsername: detail.summary.author.username,
            state: detail.summary.state,
            draft: detail.summary.draft,
            baseRef: detail.summary.base.name,
            headRef: detail.summary.head.name,
            url: detail.summary.url,
          }),
          repositoryPath: project.localPath,
          statusByPath: changedFileStatuses(detail.files),
        }).pipe(Effect.mapError(reviewFailure("hosted.snapshot")))
        return HostedReviewSnapshotManifest.make({
          ...manifestIdentity(result, revisions.base, source.offer.expectedRevision),
          detail,
        })
      })

      const acquireLocal = Effect.fn("CoreSnapshotAcquisition.acquireLocal")(function* (
        target: LocalReviewTarget,
      ) {
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
          Effect.mapError(reviewFailure("local.snapshot")),
        )
        const baseRevision = yield* localBaseRevision(target, processes).pipe(
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
          statusByPath: new Map(),
        }).pipe(Effect.mapError(reviewFailure("local.snapshot")))
        const detail = LocalReviewDetail.make({
          rootPath: target.rootPath,
          repoName: basename(target.rootPath) || target.rootPath,
          branchName,
          comparison: target.comparison,
          baseSha: baseRevision,
          headSha: source.offer.expectedRevision,
          diffHash: ReviewDiffIdentity.make(source.offer.semanticIdentity),
          title,
          files: changedFiles(result),
          fetchedAt: new Date(now).toISOString(),
        })
        return LocalReviewSnapshotManifest.make({
          ...manifestIdentity(result, baseRevision, source.offer.expectedRevision),
          detail,
        })
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
              statusByPath: new Map(),
            }).pipe(Effect.mapError(comparisonFailure("acquire.ingestion")))
            const detail = RepositoryComparisonDetail.make({
              target,
              title,
              files: changedFiles(result),
              fetchedAt: new Date(now).toISOString(),
            })
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
  statusByPath: ReadonlyMap<string, FileDeltaIdentity["status"]>,
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
      fileDeltaKeys: identityResolver(identities, source, statusByPath),
    }
  }
  if (repositoryPath !== null && Schema.is(LocalReviewDiffSourceTarget)(source.offer.target)) {
    const comparison = source.offer.target.target.comparison
    const baseObject = Match.value(comparison).pipe(
      Match.tag("workingTree", () => "HEAD"),
      Match.tagsExhaustive({
        branch: ({ baseSha }) => baseSha,
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
      fileDeltaKeys: identityResolver(identities, source, statusByPath),
    }
  }
  return {
    storageSource: null,
    fileDeltaKeys: identityResolver(new Map(), source, statusByPath),
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
  statusByPath: ReadonlyMap<string, FileDeltaIdentity["status"]>,
): CoreSnapshotFileDeltaKeySource => ({
  resolve: ({ ordinal, gitOldPath, gitNewPath }) => {
    const exact = identities.get(`${gitOldPath}\u0000${gitNewPath}`) ?? identities.get(gitNewPath)
    if (exact !== undefined) return Effect.succeed(exact.identity)
    const status =
      statusByPath.get(gitNewPath) ??
      (Schema.is(LocalReviewDiffSourceTarget)(source.offer.target) ? "added" : "modified")
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
          `Managed review spool needs ${reserved.requiredBytes} bytes but only ${reserved.availableBytes} are available`,
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

const spoolFailure = (message: string): ReviewDiffSourceFailure =>
  ReviewDiffSourceFailure.make({
    generation: ReviewDiffGeneration.make("core-managed-spool"),
    method: "unifiedBytes",
    message,
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
  files: result.files.map((file) =>
    ReviewSnapshotFileInventory.make({
      fileId: ReviewFileId.make(file.fileId),
      patchHash: file.patchHash,
      reviewKey: file.reviewKey,
      path: RepositoryRelativePath.make(file.path),
      oldPath: file.oldPath === null ? null : RepositoryRelativePath.make(file.oldPath),
      status: file.status,
      visibility: file.visibility,
      additions: file.additions,
      deletions: file.deletions,
      hunkCount: file.hunkCount,
    }),
  ),
})

const changedFiles = (result: CoreSnapshotIngestionResult): ReadonlyArray<ChangedFile> =>
  result.files.map((file) =>
    ChangedFile.make({
      path: RepositoryRelativePath.make(file.path),
      additions: file.additions,
      deletions: file.deletions,
      changeType: file.status,
    }),
  )

const changedFileStatuses = (
  files: ReadonlyArray<ChangedFile>,
): ReadonlyMap<string, FileDeltaIdentity["status"]> =>
  new Map(files.map((file) => [file.path, file.changeType]))

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
  | ProcessExecutionError
  | ResourceCatalogError
  | ReviewDiffSourceFailure

const reviewFailure =
  (operation: ReviewContextError["operation"]) =>
  (cause: CoreSnapshotAcquisitionInternalFailure): ReviewContextError =>
    ReviewContextError.make({
      operation,
      reason: "Unable to load review context",
      cause: toCoreExpectedCause(cause),
    })

const comparisonFailure =
  (operation: string) =>
  (cause: CoreSnapshotAcquisitionInternalFailure): RepositoryComparisonSourceError =>
    RepositoryComparisonSourceError.make({
      code: "acquisition-failed",
      operation: RepositoryComparisonOperation.make(operation),
      reason: "DiffDash could not acquire the repository comparison snapshot.",
      cause: toCoreExpectedCause(cause),
    })
