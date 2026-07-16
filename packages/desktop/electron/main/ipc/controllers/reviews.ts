import type { LocalReviewDetail, LocalReviewDiff } from "@diffdash/domain/local-review"
import { LocalReviewTarget } from "@diffdash/domain/local-review"
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
import {
  HostedProviderRequest,
  HostedRepositoryRequest,
  HostedReviewRequest,
  HostedViewedFilesRequest,
  SetHostedViewedFileRequest,
  SubmitHostedReviewDecisionRequest,
} from "@diffdash/protocol/hosted-git"
import { Schema } from "effect"
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
    async (_event, input: unknown): Promise<readonly PullRequestSummary[]> => {
      const request = await run(Schema.decodeUnknown(HostedRepositoryRequest)(input))
      const gitProvider = await run(GitProvider)
      return run(gitProvider.listPullRequests(request.repository))
    },
  )

  handlers.define(
    InvokeChannel.listAssignedHostedReviews,
    async (_event, input: unknown): Promise<readonly PullRequestSummary[]> => {
      const request = await run(Schema.decodeUnknown(HostedProviderRequest)(input))
      const gitProvider = await run(GitProvider)
      return run(gitProvider.listReviewRequests(request.providerId))
    },
  )

  handlers.define(
    InvokeChannel.getHostedReview,
    async (_event, input: unknown): Promise<PullRequestDetail> => {
      const request = await run(Schema.decodeUnknown(HostedReviewRequest)(input))
      const gitProvider = await run(GitProvider)
      return run(gitProvider.getPullRequestDetail(request.review))
    },
  )

  handlers.define(
    InvokeChannel.refreshHostedReview,
    async (_event, input: unknown): Promise<PullRequestDetail> => {
      const request = await run(Schema.decodeUnknown(HostedReviewRequest)(input))
      const gitProvider = await run(GitProvider)
      return run(gitProvider.refreshPullRequestDetail(request.review))
    },
  )

  handlers.define(
    InvokeChannel.getHostedReviewDiff,
    async (_event, input: unknown): Promise<PullRequestDiff> => {
      const request = await run(Schema.decodeUnknown(HostedReviewRequest)(input))
      const gitProvider = await run(GitProvider)
      return run(gitProvider.getPullRequestDiff(request.review))
    },
  )

  handlers.define(
    InvokeChannel.getHostedReviewDecision,
    async (
      _event,
      input: unknown,
    ): Promise<import("@diffdash/domain/git-provider").ReviewDecision> => {
      const request = await run(Schema.decodeUnknown(HostedReviewRequest)(input))
      const gitProvider = await run(GitProvider)
      return (await run(gitProvider.hasApprovedPullRequest(request.review))) ? "approved" : "none"
    },
  )

  handlers.define(
    InvokeChannel.submitHostedReviewDecision,
    async (_event, input: unknown): Promise<void> => {
      const request = await run(Schema.decodeUnknown(SubmitHostedReviewDecisionRequest)(input))
      if (request.decision !== "approved") throw new Error("Only approval is currently supported")
      const gitProvider = await run(GitProvider)
      return run(gitProvider.approvePullRequest(request.review))
    },
  )

  handlers.define(
    InvokeChannel.resolveLocalBranch,
    async (_event, localPath: string, branchName: string | null): Promise<LocalReviewTarget> => {
      const git = await run(GitService)
      return run(git.resolveBranchComparison(localPath, branchName))
    },
  )

  handlers.define(
    InvokeChannel.localReviewDetail,
    async (_event, input: unknown): Promise<LocalReviewDetail> => {
      const target = await run(Schema.decodeUnknown(LocalReviewTarget)(input))
      const git = await run(GitService)
      const store = await run(RepositoryStore)
      const detail = await run(git.getLocalReviewDetail(target))
      await run(store.upsertRepository(localRepositoryInput(detail.rootPath)))
      return detail
    },
  )

  handlers.define(
    InvokeChannel.localReviewDiff,
    async (_event, input: unknown): Promise<LocalReviewDiff> => {
      const target = await run(Schema.decodeUnknown(LocalReviewTarget)(input))
      const git = await run(GitService)
      const store = await run(RepositoryStore)
      const diff = await run(git.getLocalReviewDiff(target))
      await run(store.upsertRepository(localRepositoryInput(diff.rootPath)))
      return diff
    },
  )

  handlers.define(
    InvokeChannel.localReviewSnapshot,
    async (_event, input: unknown): Promise<LocalReviewSnapshot> => {
      const target = await run(Schema.decodeUnknown(LocalReviewTarget)(input))
      const git = await run(GitService)
      const store = await run(RepositoryStore)
      const snapshot = await run(git.getLocalReviewSnapshot(target))
      await run(store.upsertRepository(localRepositoryInput(snapshot.detail.rootPath)))
      return snapshot
    },
  )

  handlers.define(
    InvokeChannel.listViewedFiles,
    async (_event, input: unknown): Promise<readonly string[]> => {
      const request = await run(Schema.decodeUnknown(HostedViewedFilesRequest)(input))
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

  handlers.define(InvokeChannel.setViewedFile, async (_event, input: unknown): Promise<void> => {
    const request = await run(Schema.decodeUnknown(SetHostedViewedFileRequest)(input))
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
    async (_event, rootPath: string, headSha: string): Promise<readonly string[]> => {
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
    async (
      _event,
      rootPath: string,
      headSha: string,
      reviewKey: string,
      filePath: string,
      viewed: boolean,
    ): Promise<void> => {
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
