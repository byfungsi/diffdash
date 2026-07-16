import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import type { PullRequestDiff } from "@diffdash/domain/pull-request"
import {
  prepareWalkthroughPromptInput,
  type StoredWalkthrough,
  WALKTHROUGH_PROMPT_VERSION,
  walkthroughLocalDiffScope,
  walkthroughPullRequestScope,
} from "@diffdash/domain/walkthrough"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import { WalkthroughStore } from "@diffdash/persistence/walkthrough-store"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { WalkthroughService } from "@diffdash/walkthrough"
import { GitProvider } from "../../../../src/main/services/git-provider"
import { ReviewContextService } from "../../../../src/main/services/review-context"
import type { ApplicationRuntime } from "../../application-runtime"
import { IpcControllerRegistry } from "./controller-registry"
import { localRepositoryInput, pullRequestReviewKey } from "./helpers"

/** Defines walkthroughs IPC handler implementations. */
export const defineWalkthroughHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  const run = runtime.runPromise

  handlers.define(
    InvokeChannel.getWalkthrough,
    async (_event, request): Promise<StoredWalkthrough | null> => {
      const hostedRepository = request.review.repository
      const store = await run(RepositoryStore)
      const gitProvider = await run(GitProvider)
      const walkthroughStore = await run(WalkthroughStore)
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
        walkthroughStore.get({
          repoId: repo.id,
          reviewKey: pullRequestReviewKey(
            hostedRepository.providerId,
            hostedRepository.namespace,
            hostedRepository.name,
            request.review.number,
          ),
          baseSha: request.baseRevision,
          headSha: request.headRevision,
          promptVersion: WALKTHROUGH_PROMPT_VERSION,
        }),
      )
    },
  )

  handlers.define(
    InvokeChannel.getLocalWalkthrough,
    async (_event, { target, baseSha, headSha }): Promise<StoredWalkthrough | null> => {
      const contexts = await run(ReviewContextService)
      const store = await run(RepositoryStore)
      const walkthroughStore = await run(WalkthroughStore)
      const snapshot = await run(contexts.getLocalReviewSnapshot(target))
      const repo = await run(store.upsertRepository(localRepositoryInput(snapshot.detail.rootPath)))
      return run(
        walkthroughStore.get({
          repoId: repo.id,
          reviewKey: snapshot.reviewKey,
          baseSha,
          headSha,
          promptVersion: WALKTHROUGH_PROMPT_VERSION,
        }),
      )
    },
  )

  handlers.define(
    InvokeChannel.generateWalkthrough,
    async (_event, request): Promise<StoredWalkthrough> => {
      const { repository } = request.review
      const repositoryStore = await run(RepositoryStore)
      const gitProvider = await run(GitProvider)
      const walkthroughStore = await run(WalkthroughStore)
      const walkthroughService = await run(WalkthroughService)

      const repo = await run(
        repositoryStore.upsertRepository({
          provider: repository.providerId,
          owner: repository.namespace,
          name: repository.name,
          remoteUrl: await run(gitProvider.repositoryUrl(repository)),
          localPath: null,
        }),
      )
      const pullRequest = await run(gitProvider.getPullRequestDetail(request.review))
      const baseSha = pullRequest.baseRefOid
      if (baseSha === null) {
        throw new Error("Cannot generate a walkthrough without a PR base SHA")
      }

      let diff: PullRequestDiff | null = null
      let headSha = pullRequest.headRefOid
      if (headSha === null) {
        diff = await run(gitProvider.getPullRequestDiff(request.review))
        headSha = diff.headRefOid
      }
      if (headSha === null) {
        throw new Error("Cannot generate a walkthrough without a PR head SHA")
      }

      const reviewKey = pullRequestReviewKey(
        repository.providerId,
        repository.namespace,
        repository.name,
        request.review.number,
      )
      const cacheKey = {
        repoId: repo.id,
        reviewKey,
        baseSha,
        headSha,
        promptVersion: WALKTHROUGH_PROMPT_VERSION,
      }

      if (!request.regenerate) {
        const cached = await run(walkthroughStore.get(cacheKey))
        if (cached !== null) return cached
      }

      diff ??= await run(gitProvider.getPullRequestDiff(request.review))
      const parsedDiff = parseUnifiedDiff(diff.diff)
      const promptInput = await run(
        prepareWalkthroughPromptInput(
          parsedDiff.files,
          walkthroughPullRequestScope(request.review.number),
        ),
      )
      const walkthrough = await run(
        walkthroughService.generate({
          review: { kind: "pullRequest", pullRequest },
          diff: promptInput.diff,
          hunkDigest: promptInput.hunkDigest,
          changedFileTree: promptInput.changedFileTree,
          generation: promptInput.generation,
          promptStats: promptInput.stats,
        }),
      )

      return run(
        walkthroughStore.save({
          ...cacheKey,
          prNumber: request.review.number,
          walkthrough,
        }),
      )
    },
  )

  handlers.define(
    InvokeChannel.generateLocalWalkthrough,
    async (_event, { target, regenerate }): Promise<StoredWalkthrough> => {
      const contexts = await run(ReviewContextService)
      const repositoryStore = await run(RepositoryStore)
      const walkthroughStore = await run(WalkthroughStore)
      const walkthroughService = await run(WalkthroughService)

      const snapshot = await run(contexts.getLocalReviewSnapshot(target))
      const localReview = snapshot.detail
      const diff = snapshot.diff
      const repo = await run(repositoryStore.upsertRepository(localRepositoryInput(diff.rootPath)))
      const cacheKey = {
        repoId: repo.id,
        reviewKey: snapshot.reviewKey,
        baseSha: diff.baseSha,
        headSha: diff.headSha,
        promptVersion: WALKTHROUGH_PROMPT_VERSION,
      }

      if (!regenerate) {
        const cached = await run(walkthroughStore.get(cacheKey))
        if (cached !== null) return cached
      }

      const parsedDiff = parseUnifiedDiff(diff.diff)
      const promptInput = await run(
        prepareWalkthroughPromptInput(parsedDiff.files, walkthroughLocalDiffScope(diff.headSha)),
      )
      const walkthrough = await run(
        walkthroughService.generate({
          review: { kind: "localDiff", localReview },
          diff: promptInput.diff,
          hunkDigest: promptInput.hunkDigest,
          changedFileTree: promptInput.changedFileTree,
          generation: promptInput.generation,
          promptStats: promptInput.stats,
        }),
      )

      return run(
        walkthroughStore.save({
          ...cacheKey,
          prNumber: null,
          walkthrough,
        }),
      )
    },
  )
}

/** Registers walkthrough handlers with Electron. */
export const installWalkthroughsController = (registry: IpcControllerRegistry) =>
  registry.install([
    InvokeChannel.getWalkthrough,
    InvokeChannel.getLocalWalkthrough,
    InvokeChannel.generateWalkthrough,
    InvokeChannel.generateLocalWalkthrough,
  ])
