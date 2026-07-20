import { ReviewAgentProgress } from "@diffdash/domain/review-agent"
import {
  isReviewAnchorInParsedDiff,
  type ReviewThread,
  type ReviewThreadDetails,
  ReviewThreadTarget,
} from "@diffdash/domain/review-thread"
import { WALKTHROUGH_PROMPT_VERSION } from "@diffdash/domain/walkthrough"
import { ReviewThreadStore } from "@diffdash/persistence/review-thread-store"
import { ReviewTurnStore } from "@diffdash/persistence/review-turn-store"
import { WalkthroughStore } from "@diffdash/persistence/walkthrough-store"
import { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import { transportError } from "@diffdash/protocol/transport-error"
import { ReviewAgentService } from "@diffdash/review-agent"
import { ReviewThreadAnchorMapper } from "@diffdash/review-agent/anchor-mapper"
import { Effect } from "effect"
import { RepositoryLinker } from "../../../../src/main/services/repository-linker"
import { ReviewSnapshotService } from "../../../../src/main/services/review-snapshot"
import type { ApplicationRuntime } from "../../application-runtime"
import { sendProtocolEvent } from "../transport"
import { IpcControllerRegistry } from "./controller-registry"

/** Defines threads IPC handler implementations. */
export const defineThreadHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  const run = runtime.runPromise
  const resolveThreadReview = async (target: ReviewThreadTarget) => {
    const snapshots = await run(ReviewSnapshotService)
    const repositories = await run(RepositoryLinker)
    if (target.kind === "hosted") {
      const snapshot = await run(snapshots.acquireHosted(target.review))
      const repo = await run(repositories.ensureHosted(target.review.repository))
      return { repo, snapshot, prNumber: target.review.number } as const
    }

    const snapshot = await run(snapshots.acquireLocal(target))
    const repo = await run(repositories.ensureLocal(snapshot.detail.rootPath))
    return { repo, snapshot, prNumber: null } as const
  }

  handlers.define(
    InvokeChannel.listReviewThreads,
    async (_event, { target }): Promise<readonly ReviewThread[]> => {
      const { repo, snapshot } = await resolveThreadReview(target)
      const mapper = await run(ReviewThreadAnchorMapper)
      return run(
        mapper.mapReview({
          repoId: repo.id,
          reviewKey: snapshot.reviewKey,
          baseRevision: snapshot.baseRevision,
          headRevision: snapshot.headRevision,
          parsedDiff: snapshot.parsedDiff,
        }),
      )
    },
  )

  handlers.define(
    InvokeChannel.addReviewThreadUserMessage,
    async (_event, request): Promise<ReviewThreadDetails> => {
      const threads = await run(ReviewThreadStore)
      return run(threads.addUserMessage(request))
    },
  )

  handlers.define(
    InvokeChannel.createReviewThread,
    async (_event, request): Promise<ReviewThreadDetails> => {
      const { repo, snapshot, prNumber } = await resolveThreadReview(request.target)
      if (
        snapshot.baseRevision !== request.expectedBaseRevision ||
        snapshot.headRevision !== request.expectedHeadRevision
      ) {
        throw transportError(
          "REVIEW_CHANGED",
          "Review changed before the local thread was created.",
        )
      }
      if (!isReviewAnchorInParsedDiff(request.anchor, snapshot.parsedDiff)) {
        throw transportError(
          "INVALID_REVIEW_ANCHOR",
          "Review thread anchor does not exist in the expected review revision.",
        )
      }
      const threads = await run(ReviewThreadStore)
      return run(
        threads.create({
          repoId: repo.id,
          reviewKey: snapshot.reviewKey,
          prNumber,
          baseRevision: snapshot.baseRevision,
          headRevision: snapshot.headRevision,
          anchor: request.anchor,
          bodyMarkdown: request.bodyMarkdown,
        }),
      )
    },
  )

  handlers.define(
    InvokeChannel.getReviewThread,
    async (_event, request): Promise<ReviewThreadDetails> => {
      const threads = await run(ReviewThreadStore)
      return run(threads.get(request.threadId))
    },
  )

  handlers.define(
    InvokeChannel.runReviewThreadAgent,
    async (event, request): Promise<ReviewThreadDetails> => {
      const turns = await run(ReviewTurnStore)
      const mapping = await run(
        turns.validateTarget({
          threadId: request.threadId,
          target: request.target,
          repoId: request.repoId,
          reviewKey: request.reviewKey,
          baseRevision: request.expectedBaseRevision,
          headRevision: request.expectedHeadRevision,
        }),
      )
      const { repo, snapshot } = await resolveThreadReview(request.target)
      const walkthroughs = await run(WalkthroughStore)
      const walkthrough = await run(
        walkthroughs.get({
          repoId: repo.id,
          reviewKey: snapshot.reviewKey,
          baseSha: snapshot.baseRevision,
          headSha: snapshot.headRevision,
          promptVersion: WALKTHROUGH_PROMPT_VERSION,
        }),
      )
      const agents = await run(ReviewAgentService)
      return run(
        agents.runThreadTurn({
          threadId: request.threadId,
          repoId: repo.id,
          target: request.target,
          mapping,
          snapshot,
          cwd: repo.localPath,
          walkthrough,
          onProgress: (stage) =>
            Effect.sync(() => {
              if (event.sender.isDestroyed()) return
              sendProtocolEvent(
                event.sender,
                EventChannel.reviewThreadAgentProgress,
                ReviewAgentProgress.make({ threadId: request.threadId, stage }),
              )
            }),
        }),
      )
    },
  )
}
