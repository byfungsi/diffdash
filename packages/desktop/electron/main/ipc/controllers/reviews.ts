import type { HostedReviewSummary, ReviewDecision } from "@diffdash/domain/git-provider"
import type { LocalReviewTarget } from "@diffdash/domain/local-review"
import {
  type HostedReviewSnapshotManifest,
  type LocalReviewSnapshotManifest,
  makeReviewSnapshotManifest,
} from "@diffdash/domain/review-context"
import { GitService } from "@diffdash/local-git/local-git"
import { ViewedFileStore } from "@diffdash/persistence/viewed-file-store"
import { InvokeChannel } from "@diffdash/protocol/channels"
import {
  REVIEW_SNAPSHOT_PAGE_MAX_BYTES,
  REVIEW_SNAPSHOT_SEARCH_MAX_BYTES,
  ReviewSnapshotExpired,
  type ReviewSnapshotPageResponse,
  type ReviewSnapshotSearchResponse,
} from "@diffdash/protocol/review-snapshot"
import type { ViewedFileRecord } from "@diffdash/protocol/viewed-files"
import { GitProvider } from "../../../../src/main/services/git-provider"
import { RepositoryLinker } from "../../../../src/main/services/repository-linker"
import {
  ReviewSnapshotService,
  ReviewSnapshotUnavailableError,
} from "../../../../src/main/services/review-snapshot"
import {
  paginateReviewSnapshot,
  searchReviewSnapshot,
} from "../../../../src/main/services/review-snapshot-pagination"
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
    InvokeChannel.acquireHostedReviewSnapshot,
    async (_event, { review }): Promise<HostedReviewSnapshotManifest> => {
      const snapshots = await run(ReviewSnapshotService)
      return makeReviewSnapshotManifest(await run(snapshots.acquireHosted(review)))
    },
  )

  handlers.define(
    InvokeChannel.acquireLocalReviewSnapshot,
    async (_event, { target }): Promise<LocalReviewSnapshotManifest> => {
      const snapshots = await run(ReviewSnapshotService)
      const repositories = await run(RepositoryLinker)
      const snapshot = await run(snapshots.acquireLocal(target))
      await run(repositories.ensureLocal(snapshot.detail.rootPath))
      return makeReviewSnapshotManifest(snapshot)
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
