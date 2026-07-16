import type { LocalReviewDetail, LocalReviewDiff } from "@diffdash/domain/local-review"
import type { LocalReviewTarget } from "@diffdash/domain/local-review"
import type {
  PullRequestDetail,
  PullRequestDiff,
  PullRequestSummary,
} from "@diffdash/domain/pull-request"
import type { LocalReviewSnapshot } from "@diffdash/domain/review-context"
import { GitService } from "@diffdash/local-git/local-git"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import { ViewedFileStore } from "@diffdash/persistence/viewed-file-store"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { GitProvider } from "../../../../src/main/services/git-provider"
import type { ApplicationRuntime } from "../../application-runtime"
import { IpcControllerRegistry } from "./controller-registry"
import { localRepositoryInput } from "./helpers"

/** Defines reviews IPC handler implementations. */
export const defineReviewHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  const run = runtime.runPromise

  handlers.define(
    InvokeChannel.listHostedReviews,
    async (_event, request): Promise<readonly PullRequestSummary[]> => {
      const gitProvider = await run(GitProvider)
      return run(gitProvider.listPullRequests(request.repository))
    },
  )

  handlers.define(
    InvokeChannel.listAssignedHostedReviews,
    async (_event, request): Promise<readonly PullRequestSummary[]> => {
      const gitProvider = await run(GitProvider)
      return run(gitProvider.listReviewRequests(request.providerId))
    },
  )

  handlers.define(
    InvokeChannel.getHostedReview,
    async (_event, request): Promise<PullRequestDetail> => {
      const gitProvider = await run(GitProvider)
      return run(gitProvider.getPullRequestDetail(request.review))
    },
  )

  handlers.define(
    InvokeChannel.refreshHostedReview,
    async (_event, request): Promise<PullRequestDetail> => {
      const gitProvider = await run(GitProvider)
      return run(gitProvider.refreshPullRequestDetail(request.review))
    },
  )

  handlers.define(
    InvokeChannel.getHostedReviewDiff,
    async (_event, request): Promise<PullRequestDiff> => {
      const gitProvider = await run(GitProvider)
      return run(gitProvider.getPullRequestDiff(request.review))
    },
  )

  handlers.define(
    InvokeChannel.getHostedReviewDecision,
    async (_event, request): Promise<import("@diffdash/domain/git-provider").ReviewDecision> => {
      const gitProvider = await run(GitProvider)
      return (await run(gitProvider.hasApprovedPullRequest(request.review))) ? "approved" : "none"
    },
  )

  handlers.define(
    InvokeChannel.submitHostedReviewDecision,
    async (_event, request): Promise<void> => {
      if (request.decision !== "approved") throw new Error("Only approval is currently supported")
      const gitProvider = await run(GitProvider)
      return run(gitProvider.approvePullRequest(request.review))
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
    InvokeChannel.localReviewDetail,
    async (_event, { target }): Promise<LocalReviewDetail> => {
      const git = await run(GitService)
      const store = await run(RepositoryStore)
      const detail = await run(git.getLocalReviewDetail(target))
      await run(store.upsertRepository(localRepositoryInput(detail.rootPath)))
      return detail
    },
  )

  handlers.define(
    InvokeChannel.localReviewDiff,
    async (_event, { target }): Promise<LocalReviewDiff> => {
      const git = await run(GitService)
      const store = await run(RepositoryStore)
      const diff = await run(git.getLocalReviewDiff(target))
      await run(store.upsertRepository(localRepositoryInput(diff.rootPath)))
      return diff
    },
  )

  handlers.define(
    InvokeChannel.localReviewSnapshot,
    async (_event, { target }): Promise<LocalReviewSnapshot> => {
      const git = await run(GitService)
      const store = await run(RepositoryStore)
      const snapshot = await run(git.getLocalReviewSnapshot(target))
      await run(store.upsertRepository(localRepositoryInput(snapshot.detail.rootPath)))
      return snapshot
    },
  )

  handlers.define(
    InvokeChannel.listViewedFiles,
    async (_event, request): Promise<readonly string[]> => {
      const hostedRepository = request.review.repository
      const store = await run(RepositoryStore)
      const gitProvider = await run(GitProvider)
      const viewedFiles = await run(ViewedFileStore)
      const repo = await run(
        store.upsertRepository({
          provider: hostedRepository.providerId,
          owner: hostedRepository.namespace,
          name: hostedRepository.name,
          remoteUrl: await run(gitProvider.repositoryUrl(hostedRepository)),
          localPath: null,
        }),
      )
      return run(
        viewedFiles.list({
          repoId: repo.id,
          prNumber: request.review.number,
          headSha: request.headRevision,
        }),
      )
    },
  )

  handlers.define(InvokeChannel.setViewedFile, async (_event, request): Promise<void> => {
    const hostedRepository = request.review.repository
    const store = await run(RepositoryStore)
    const gitProvider = await run(GitProvider)
    const viewedFiles = await run(ViewedFileStore)
    const repo = await run(
      store.upsertRepository({
        provider: hostedRepository.providerId,
        owner: hostedRepository.namespace,
        name: hostedRepository.name,
        remoteUrl: await run(gitProvider.repositoryUrl(hostedRepository)),
        localPath: null,
      }),
    )
    return run(
      viewedFiles.set({
        repoId: repo.id,
        prNumber: request.review.number,
        headSha: request.headRevision,
        reviewKey: request.reviewKey,
        filePath: request.filePath,
        viewed: request.viewed,
      }),
    )
  })

  handlers.define(
    InvokeChannel.listLocalViewedFiles,
    async (_event, { rootPath, headSha }): Promise<readonly string[]> => {
      const git = await run(GitService)
      const store = await run(RepositoryStore)
      const viewedFiles = await run(ViewedFileStore)
      const canonicalRootPath = await run(git.detectRoot(rootPath))
      const repo = await run(store.upsertRepository(localRepositoryInput(canonicalRootPath)))
      return run(viewedFiles.list({ repoId: repo.id, prNumber: null, headSha }))
    },
  )

  handlers.define(
    InvokeChannel.setLocalViewedFile,
    async (_event, { rootPath, headSha, reviewKey, filePath, viewed }): Promise<void> => {
      const git = await run(GitService)
      const store = await run(RepositoryStore)
      const viewedFiles = await run(ViewedFileStore)
      const canonicalRootPath = await run(git.detectRoot(rootPath))
      const repo = await run(store.upsertRepository(localRepositoryInput(canonicalRootPath)))
      return run(
        viewedFiles.set({
          repoId: repo.id,
          prNumber: null,
          headSha,
          reviewKey,
          filePath,
          viewed,
        }),
      )
    },
  )
}

/** Registers hosted/local review handlers with Electron. */
export const installReviewsController = (registry: IpcControllerRegistry) =>
  registry.install([
    InvokeChannel.listHostedReviews,
    InvokeChannel.listAssignedHostedReviews,
    InvokeChannel.getHostedReview,
    InvokeChannel.refreshHostedReview,
    InvokeChannel.getHostedReviewDiff,
    InvokeChannel.getHostedReviewDecision,
    InvokeChannel.submitHostedReviewDecision,
    InvokeChannel.resolveLocalBranch,
    InvokeChannel.localReviewDetail,
    InvokeChannel.localReviewDiff,
    InvokeChannel.localReviewSnapshot,
    InvokeChannel.listViewedFiles,
    InvokeChannel.setViewedFile,
    InvokeChannel.listLocalViewedFiles,
    InvokeChannel.setLocalViewedFile,
  ])
