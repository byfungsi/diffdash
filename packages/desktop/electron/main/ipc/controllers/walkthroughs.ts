import {
  prepareWalkthroughPromptInput,
  type StoredWalkthrough,
  WALKTHROUGH_PROMPT_VERSION,
  walkthroughLocalDiffScope,
  walkthroughHostedReviewScope,
} from "@diffdash/domain/walkthrough"
import { WalkthroughStore } from "@diffdash/persistence/walkthrough-store"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { WalkthroughService } from "@diffdash/walkthrough"
import { RepositoryLinker } from "../../../../src/main/services/repository-linker"
import { ReviewSnapshotService } from "../../../../src/main/services/review-snapshot"
import type { ApplicationRuntime } from "../../application-runtime"
import { IpcControllerRegistry } from "./controller-registry"

/** Defines walkthroughs IPC handler implementations. */
export const defineWalkthroughHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  const run = runtime.runPromise

  handlers.define(
    InvokeChannel.getWalkthrough,
    async (_event, request): Promise<StoredWalkthrough | null> => {
      const snapshots = await run(ReviewSnapshotService)
      const repositories = await run(RepositoryLinker)
      const walkthroughStore = await run(WalkthroughStore)
      const snapshot = await run(snapshots.acquireHosted(request.review))
      if (
        snapshot.baseRevision !== request.baseRevision ||
        snapshot.headRevision !== request.headRevision
      ) {
        return null
      }
      const repo = await run(repositories.ensureHosted(request.review.repository))
      return run(
        walkthroughStore.get({
          repoId: repo.id,
          reviewKey: snapshot.reviewKey,
          baseSha: snapshot.baseRevision,
          headSha: snapshot.headRevision,
          promptVersion: WALKTHROUGH_PROMPT_VERSION,
        }),
      )
    },
  )

  handlers.define(
    InvokeChannel.getLocalWalkthrough,
    async (_event, { target, baseSha, headSha }): Promise<StoredWalkthrough | null> => {
      const snapshots = await run(ReviewSnapshotService)
      const repositories = await run(RepositoryLinker)
      const walkthroughStore = await run(WalkthroughStore)
      const snapshot = await run(snapshots.acquireLocal(target))
      if (snapshot.baseRevision !== baseSha || snapshot.headRevision !== headSha) return null
      const repo = await run(repositories.ensureLocal(snapshot.detail.rootPath))
      return run(
        walkthroughStore.get({
          repoId: repo.id,
          reviewKey: snapshot.reviewKey,
          baseSha: snapshot.baseRevision,
          headSha: snapshot.headRevision,
          promptVersion: WALKTHROUGH_PROMPT_VERSION,
        }),
      )
    },
  )

  handlers.define(
    InvokeChannel.generateWalkthrough,
    async (_event, request): Promise<StoredWalkthrough> => {
      const { repository } = request.review
      const snapshots = await run(ReviewSnapshotService)
      const repositories = await run(RepositoryLinker)
      const walkthroughStore = await run(WalkthroughStore)
      const walkthroughService = await run(WalkthroughService)

      const repo = await run(repositories.ensureHosted(repository))
      const snapshot = await run(snapshots.acquireHosted(request.review))
      const cacheKey = {
        repoId: repo.id,
        reviewKey: snapshot.reviewKey,
        baseSha: snapshot.baseRevision,
        headSha: snapshot.headRevision,
        promptVersion: WALKTHROUGH_PROMPT_VERSION,
      }

      if (!request.regenerate) {
        const cached = await run(walkthroughStore.get(cacheKey))
        if (cached !== null) return cached
      }

      const promptInput = await run(
        prepareWalkthroughPromptInput(
          snapshot.parsedDiff.files,
          walkthroughHostedReviewScope(request.review),
        ),
      )
      const walkthrough = await run(
        walkthroughService.generate({
          review: { kind: "hosted", hostedReview: snapshot.detail },
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
      const snapshots = await run(ReviewSnapshotService)
      const repositories = await run(RepositoryLinker)
      const walkthroughStore = await run(WalkthroughStore)
      const walkthroughService = await run(WalkthroughService)

      const snapshot = await run(snapshots.acquireLocal(target))
      const localReview = snapshot.detail
      const diff = snapshot.diff
      const repo = await run(repositories.ensureLocal(diff.rootPath))
      const cacheKey = {
        repoId: repo.id,
        reviewKey: snapshot.reviewKey,
        baseSha: snapshot.baseRevision,
        headSha: snapshot.headRevision,
        promptVersion: WALKTHROUGH_PROMPT_VERSION,
      }

      if (!regenerate) {
        const cached = await run(walkthroughStore.get(cacheKey))
        if (cached !== null) return cached
      }

      const promptInput = await run(
        prepareWalkthroughPromptInput(
          snapshot.parsedDiff.files,
          walkthroughLocalDiffScope(snapshot.headRevision),
        ),
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
