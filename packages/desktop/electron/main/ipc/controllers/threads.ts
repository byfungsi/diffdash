import { ReviewAgentProgress } from "@diffdash/domain/review-agent"
import {
  isReviewAnchorInParsedDiff,
  type ReviewThread,
  type ReviewThreadDetails,
  ReviewThreadTarget,
} from "@diffdash/domain/review-thread"
import { WALKTHROUGH_PROMPT_VERSION } from "@diffdash/domain/walkthrough"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import { ReviewThreadStore } from "@diffdash/persistence/review-thread-store"
import { WalkthroughStore } from "@diffdash/persistence/walkthrough-store"
import { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import {
  AddReviewThreadUserMessageRequest,
  CreateReviewThreadRequest,
  ReviewThreadIdRequest,
  RunReviewThreadAgentRequest,
} from "@diffdash/protocol/review-threads"
import { Effect, Schema } from "effect"
import { GitProvider } from "../../../../src/main/services/git-provider"
import { ReviewAgentService } from "../../../../src/main/services/review-agent"
import { ReviewContextService } from "../../../../src/main/services/review-context"
import { ReviewThreadAnchorMapper } from "../../../../src/main/services/review-thread-anchor-mapper"
import type { ApplicationRuntime } from "../../application-runtime"
import { IpcControllerRegistry } from "./controller-registry"
import { hostedReview, localRepositoryInput } from "./helpers"

/** Defines threads IPC handler implementations. */
export const defineThreadHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  const run = runtime.runPromise
  const resolveThreadReview = async (target: ReviewThreadTarget) => {
    const contexts = await run(ReviewContextService)
    const repositories = await run(RepositoryStore)
    if (target.kind === "pullRequest") {
      const gitProvider = await run(GitProvider)
      const review = hostedReview(target.providerId, target.owner, target.name, target.number)
      const snapshot = await run(contexts.getPullRequestSnapshot(review))
      const repo = await run(
        repositories.upsertRepository({
          provider: target.providerId,
          owner: target.owner,
          name: target.name,
          remoteUrl: await run(gitProvider.repositoryUrl(review.repository)),
          localPath: null,
        }),
      )
      return { repo, snapshot, prNumber: target.number } as const
    }

    const snapshot = await run(contexts.getLocalReviewSnapshot(target))
    const repo = await run(
      repositories.upsertRepository(localRepositoryInput(snapshot.detail.rootPath)),
    )
    return { repo, snapshot, prNumber: null } as const
  }

  handlers.define(
    InvokeChannel.listReviewThreads,
    async (_event, input: unknown): Promise<readonly ReviewThread[]> => {
      const target = await run(Schema.decodeUnknown(ReviewThreadTarget)(input))
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
    async (_event, input: unknown): Promise<ReviewThreadDetails> => {
      const request = await run(Schema.decodeUnknown(AddReviewThreadUserMessageRequest)(input))
      const threads = await run(ReviewThreadStore)
      return run(threads.addUserMessage(request))
    },
  )

  handlers.define(
    InvokeChannel.createReviewThread,
    async (_event, input: unknown): Promise<ReviewThreadDetails> => {
      const request = await run(Schema.decodeUnknown(CreateReviewThreadRequest)(input))
      const { repo, snapshot, prNumber } = await resolveThreadReview(request.target)
      if (
        snapshot.baseRevision !== request.expectedBaseRevision ||
        snapshot.headRevision !== request.expectedHeadRevision
      ) {
        throw new Error("Review changed before the local thread was created")
      }
      if (!isReviewAnchorInParsedDiff(request.anchor, snapshot.parsedDiff)) {
        throw new Error("Review thread anchor does not exist in the expected review revision")
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
    async (_event, input: unknown): Promise<ReviewThreadDetails> => {
      const request = await run(Schema.decodeUnknown(ReviewThreadIdRequest)(input))
      const threads = await run(ReviewThreadStore)
      return run(threads.get(request.threadId))
    },
  )

  handlers.define(
    InvokeChannel.runReviewThreadAgent,
    async (event, input: unknown): Promise<ReviewThreadDetails> => {
      const request = await run(Schema.decodeUnknown(RunReviewThreadAgentRequest)(input))
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
          snapshot,
          cwd: repo.localPath,
          walkthrough,
          onProgress: (stage) =>
            Effect.sync(() => {
              if (event.sender.isDestroyed()) return
              event.sender.send(
                EventChannel.reviewThreadAgentProgress,
                ReviewAgentProgress.make({ threadId: request.threadId, stage }),
              )
            }),
        }),
      )
    },
  )
}

/** Registers review-thread handlers with Electron. */
export const installThreadsController = (registry: IpcControllerRegistry) =>
  registry.install([
    InvokeChannel.listReviewThreads,
    InvokeChannel.addReviewThreadUserMessage,
    InvokeChannel.createReviewThread,
    InvokeChannel.getReviewThread,
    InvokeChannel.runReviewThreadAgent,
  ])
