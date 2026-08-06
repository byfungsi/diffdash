import type { HostedReviewSummary, ReviewDecision } from "@diffdash/domain/git-provider"
import type { LocalReviewTarget } from "@diffdash/domain/local-review"
import {
  makeRepositoryComparisonReviewKey,
  type RepositoryComparisonTarget,
} from "@diffdash/domain/repository-comparison"
import {
  type HostedReviewSnapshotManifest,
  type LocalReviewSnapshotManifest,
  type RepositoryComparisonSnapshotManifest,
  makeReviewSnapshotManifest,
} from "@diffdash/domain/review-context"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { GitService } from "@diffdash/local-git/local-git"
import { ViewedFileStore } from "@diffdash/persistence/viewed-file-store"
import { InvokeChannel } from "@diffdash/protocol/channels"
import {
  REVIEW_SNAPSHOT_PAGE_MAX_BYTES,
  REVIEW_SNAPSHOT_SEARCH_MAX_BYTES,
  ReviewSnapshotExpired,
  type ReviewSnapshotPageResponse,
  type ReviewSnapshotSearchResponse,
  ResolvedRepositoryComparison,
} from "@diffdash/protocol/review-snapshot"
import type { ViewedFileRecord } from "@diffdash/protocol/viewed-files"
import {
  GitProvider,
  paginateReviewSnapshot,
  RepositoryComparisonSource,
  RepositoryLinker,
  ReviewSnapshotService,
  ReviewSnapshotUnavailableError,
  searchReviewSnapshot,
} from "@diffdash/core/legacy"
import type { ApplicationRuntime } from "../../application-runtime"
import { IpcControllerRegistry } from "./controller-registry"

/** Defines reviews IPC handler implementations. */
export const defineReviewHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  const run = runtime.runPromise

  handlers.define(
    InvokeChannel.listHostedReviews,
    async (_event, request): Promise<readonly HostedReviewSummary[]> => {
      const gitProvider = await run(GitProvider)
      return run(gitProvider.listHostedReviews(request.repository))
    },
  )

  handlers.define(
    InvokeChannel.listAssignedHostedReviews,
    async (_event, request): Promise<readonly HostedReviewSummary[]> => {
      const gitProvider = await run(GitProvider)
      return run(gitProvider.listAssignedReviews(request.providerId))
    },
  )

  handlers.define(
    InvokeChannel.getHostedReviewDecision,
    async (_event, request): Promise<ReviewDecision> => {
      const gitProvider = await run(GitProvider)
      return run(gitProvider.getReviewDecision(request.review))
    },
  )

  handlers.define(
    InvokeChannel.submitHostedReviewDecision,
    async (_event, request): Promise<void> => {
      const gitProvider = await run(GitProvider)
      return run(gitProvider.submitReviewDecision(request.review, request.decision))
    },
  )

  handlers.define(
    InvokeChannel.resolveLocalBranch,
    async (_event, { localPath, branchName }): Promise<LocalReviewTarget> => {
      const git = await run(GitService)
      return run(git.resolveBranchComparison(localPath, branchName))
    },
  )

  handlers.define(
    InvokeChannel.resolveRepositoryComparison,
    async (_event, { command }): Promise<ResolvedRepositoryComparison> => {
      const comparisons = await run(RepositoryComparisonSource)
      const target = await run(comparisons.resolve(command))
      const repo = await run(comparisons.repository(target))
      return ResolvedRepositoryComparison.make({ repo, target })
    },
  )

  handlers.define(
    InvokeChannel.acquireHostedReviewSnapshot,
    async (_event, { review }): Promise<HostedReviewSnapshotManifest> => {
      const snapshots = await run(ReviewSnapshotService)
      const repositories = await run(RepositoryLinker)
      const project = await run(repositories.ensureHosted(review.repository))
      return makeReviewSnapshotManifest(
        await run(snapshots.acquireHosted(review)),
        ReviewProjectId.make(project.id),
      )
    },
  )

  handlers.define(
    InvokeChannel.acquireLocalReviewSnapshot,
    async (_event, { target }): Promise<LocalReviewSnapshotManifest> => {
      const snapshots = await run(ReviewSnapshotService)
      const repositories = await run(RepositoryLinker)
      const snapshot = await run(snapshots.acquireLocal(target))
      const project = await run(repositories.ensureLocal(snapshot.detail.rootPath))
      return makeReviewSnapshotManifest(snapshot, ReviewProjectId.make(project.id))
    },
  )

  handlers.define(
    InvokeChannel.acquireRepositoryComparisonSnapshot,
    async (_event, { target }): Promise<RepositoryComparisonSnapshotManifest> => {
      const snapshots = await run(ReviewSnapshotService)
      const comparisons = await run(RepositoryComparisonSource)
      const repo = await run(comparisons.repository(target))
      const snapshot = await run(snapshots.acquireComparison(target))
      return makeReviewSnapshotManifest(snapshot, ReviewProjectId.make(repo.id))
    },
  )

  handlers.define(
    InvokeChannel.getReviewSnapshotPage,
    async (_event, request): Promise<ReviewSnapshotPageResponse> => {
      const snapshots = await run(ReviewSnapshotService)
      try {
        const snapshot = await run(snapshots.get(request.snapshotId))
        return paginateReviewSnapshot(snapshot, request, REVIEW_SNAPSHOT_PAGE_MAX_BYTES)
      } catch (error) {
        if (error instanceof ReviewSnapshotUnavailableError) {
          return ReviewSnapshotExpired.make({
            snapshotId: request.snapshotId,
            reason: error.reason,
          })
        }
        throw error
      }
    },
  )

  handlers.define(
    InvokeChannel.searchReviewSnapshot,
    async (_event, request): Promise<ReviewSnapshotSearchResponse> => {
      const snapshots = await run(ReviewSnapshotService)
      try {
        const snapshot = await run(snapshots.get(request.snapshotId))
        return searchReviewSnapshot(snapshot, request, REVIEW_SNAPSHOT_SEARCH_MAX_BYTES)
      } catch (error) {
        if (error instanceof ReviewSnapshotUnavailableError) {
          return ReviewSnapshotExpired.make({
            snapshotId: request.snapshotId,
            reason: error.reason,
          })
        }
        throw error
      }
    },
  )

  handlers.define(
    InvokeChannel.listViewedFiles,
    async (_event, request): Promise<readonly ViewedFileRecord[]> => {
      const hostedRepository = request.review.repository
      const repositories = await run(RepositoryLinker)
      const viewedFiles = await run(ViewedFileStore)
      const repo = await run(repositories.ensureHosted(hostedRepository))
      return run(
        viewedFiles.listHosted({
          repoId: repo.id,
          prNumber: request.review.number,
          baseRefName: request.baseRefName,
        }),
      )
    },
  )

  handlers.define(InvokeChannel.setViewedFile, async (_event, request): Promise<void> => {
    const hostedRepository = request.review.repository
    const repositories = await run(RepositoryLinker)
    const viewedFiles = await run(ViewedFileStore)
    const repo = await run(repositories.ensureHosted(hostedRepository))
    return run(
      viewedFiles.setHosted({
        repoId: repo.id,
        prNumber: request.review.number,
        baseRefName: request.baseRefName,
        reviewKey: request.reviewKey,
        patchHash: request.patchHash,
        viewed: request.viewed,
      }),
    )
  })

  handlers.define(
    InvokeChannel.listLocalViewedFiles,
    async (_event, request): Promise<readonly ViewedFileRecord[]> => {
      const repositories = await run(RepositoryLinker)
      const viewedFiles = await run(ViewedFileStore)
      const repo = await run(repositories.ensureLocal(request.target.rootPath))
      return run(
        viewedFiles.listLocal(localViewedFileScope(repo.id, request.target, request.sourceBranch)),
      )
    },
  )

  handlers.define(InvokeChannel.setLocalViewedFile, async (_event, request): Promise<void> => {
    const repositories = await run(RepositoryLinker)
    const viewedFiles = await run(ViewedFileStore)
    const repo = await run(repositories.ensureLocal(request.target.rootPath))
    return run(
      viewedFiles.setLocal({
        ...localViewedFileScope(repo.id, request.target, request.sourceBranch),
        reviewKey: request.reviewKey,
        patchHash: request.patchHash,
        viewed: request.viewed,
      }),
    )
  })

  handlers.define(
    InvokeChannel.listRepositoryComparisonViewedFiles,
    async (_event, { target }): Promise<readonly ViewedFileRecord[]> => {
      const comparisons = await run(RepositoryComparisonSource)
      const viewedFiles = await run(ViewedFileStore)
      const repo = await run(comparisons.repository(target))
      return run(viewedFiles.listLocal(comparisonViewedFileScope(repo.id, target)))
    },
  )

  handlers.define(
    InvokeChannel.setRepositoryComparisonViewedFile,
    async (_event, request): Promise<void> => {
      const comparisons = await run(RepositoryComparisonSource)
      const viewedFiles = await run(ViewedFileStore)
      const repo = await run(comparisons.repository(request.target))
      return run(
        viewedFiles.setLocal({
          ...comparisonViewedFileScope(repo.id, request.target),
          reviewKey: request.reviewKey,
          patchHash: request.patchHash,
          viewed: request.viewed,
        }),
      )
    },
  )
}

const localViewedFileScope = (
  repoId: string,
  target: LocalReviewTarget,
  sourceBranch: string | null,
) =>
  ({
    repoId,
    sourceIdentity: sourceBranch === null ? "detached" : `branch:${sourceBranch}`,
    comparisonKind: target.comparison["_tag"],
    comparisonTarget: target.comparison["_tag"] === "branch" ? target.comparison.branchName : "",
  }) as const

const comparisonViewedFileScope = (repoId: string, target: RepositoryComparisonTarget) =>
  ({
    repoId,
    sourceIdentity: `comparison:${makeRepositoryComparisonReviewKey(target)}`,
    comparisonKind: "repositoryComparison",
    comparisonTarget: target.headSha,
  }) as const
