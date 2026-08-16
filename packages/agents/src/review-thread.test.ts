import {
  AgentCapabilityReady,
  AgentExecutionPolicy,
  AgentModelId,
  AgentProviderId,
  type AgentProviderOperationError,
  AgentSessionId,
  InvalidAgentProviderResponseError,
  type ReviewThreadRequest,
  ReviewThreadResult,
} from "@diffdash/agent-provider"
import { workingTreeReviewTarget } from "@diffdash/domain/local-review"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { ReviewThreadAgentResponse } from "@diffdash/domain/review-agent"
import {
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewKey,
  ReviewRevision,
  ReviewProjectId,
} from "@diffdash/domain/review-identity"
import {
  CurrentReviewAnchor,
  LineReviewAnchor,
  MarkdownBody,
  ReviewThread,
  ReviewThreadId,
  UserReviewThreadMessage,
  ReviewThreadMessageId,
} from "@diffdash/domain/review-thread"
import { LocalReviewDescriptor } from "@diffdash/domain/review-context"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import {
  ReviewPromptFile,
  ReviewPromptIdentity,
  ReviewThreadAgentEngine,
  type ReviewThreadAgentContext,
} from "./review-thread"

const providerId = AgentProviderId.make("fixture")
const model = AgentModelId.make("fixture-model")
const revision = ReviewRevision.make("head-revision")

const review = ReviewPromptIdentity.make({
  reviewKey: ReviewKey.make("local:/workspace/repo"),
  baseRevision: revision,
  headRevision: revision,
  descriptor: LocalReviewDescriptor.make({
    target: workingTreeReviewTarget(RepositoryCheckoutPath.make("/workspace/repo")),
    repoName: "repo",
    branchName: RepositoryComparisonRef.make("feature/review"),
    title: "Review",
    fetchedAt: "2026-08-09T00:00:00.000Z",
  }),
})
const file = ReviewPromptFile.make({
  fileId: ReviewFileId.make("file-a"),
  path: RepositoryRelativePath.make("src/a.ts"),
  oldPath: null,
  status: "modified",
  additions: 1,
  deletions: 1,
  hunkCount: 1,
})
const anchor = LineReviewAnchor.make({
  fileId: file.fileId,
  filePath: file.path,
  oldPath: file.oldPath,
  hunkId: ReviewHunkId.make("hunk-a"),
  hunkFingerprint: ReviewHunkFingerprint.make("fingerprint-a"),
  hunkHeader: "@@ -1 +1 @@",
  side: "new",
  lineNumber: 1,
  lineContent: "const value = 2",
})
const latestUserMessage = UserReviewThreadMessage.make({
  id: ReviewThreadMessageId.make("message-2"),
  threadId: ReviewThreadId.make("thread-1"),
  sequence: 2,
  bodyMarkdown: MarkdownBody.make("Is this safe?"),
  createdAt: "2026-08-09T00:00:02.000Z",
  updatedAt: "2026-08-09T00:00:02.000Z",
})
let receivedRequest: ReviewThreadRequest | undefined
const context: ReviewThreadAgentContext = {
  review,
  fileInventory: { totalFiles: 1, files: [file] },
  anchorHunk: {
    fileId: file.fileId,
    hunkId: anchor.hunkId,
    header: anchor.hunkHeader,
    lines: ["-const value = 1", "+const value = 2"],
    anchorLineIndex: 1,
    omittedBefore: 0,
    omittedAfter: 0,
  },
  thread: ReviewThread.make({
    id: ReviewThreadId.make("thread-1"),
    repoId: ReviewProjectId.make("repo-1"),
    reviewKey: review.reviewKey,
    prNumber: null,
    baseRevision: revision,
    headRevision: revision,
    currentBaseRevision: revision,
    currentHeadRevision: revision,
    originalAnchor: anchor,
    currentAnchor: CurrentReviewAnchor.cases.Active.make({ anchor }),
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  }),
  messages: [latestUserMessage],
  latestUserMessage,
  threadSummary: null,
  priorArtifacts: [],
  providerId,
  capability: {
    probe: Effect.succeed(
      AgentCapabilityReady.make({ capability: "review-thread", runtimeVersion: null }),
    ),
    execute: (request) =>
      Effect.sync(() => {
        receivedRequest = request
        return ReviewThreadResult.make({
          response: ReviewThreadAgentResponse.make({
            bodyMarkdown: "Review complete.",
            referencedAnchors: [],
          }),
          artifacts: [],
          usage: null,
          sessionId: AgentSessionId.make("session-1"),
        })
      }),
  },
  model,
  workingDirectory: "/workspace/repo",
  revision,
  sessionId: null,
  mcp: {
    scopeId: "thread-1",
    endpoint: "http://127.0.0.1/mcp",
    bearerToken: Redacted.make("token"),
    allowedTools: [],
    call: () => Effect.die("unused"),
  },
  policy: AgentExecutionPolicy.make({
    network: "allow",
    sensitiveFiles: "deny",
    repository: "reviewed-revision",
    shell: "read-only",
    fileMutation: "deny",
    gitMutation: "deny",
    providerPublishing: "deny",
    providerPublishingTools: [],
    allowedMcpTools: [],
  }),
}

describe("ReviewThreadAgentEngine", () => {
  it.effect("builds the prompt before executing a resolved capability", () =>
    Effect.gen(function* () {
      const engine = yield* ReviewThreadAgentEngine
      const outcome = yield* engine.run(context)

      expect(outcome.response.bodyMarkdown).toBe("Review complete.")
      expect(outcome.sessionId).toBe("session-1")
      expect(receivedRequest?.stablePrompt).toContain("# DiffDash review thread context v2")
      expect(receivedRequest?.dynamicPrompt).toContain("Is this safe?")
    }).pipe(Effect.provide(ReviewThreadAgentEngine.layer)),
  )

  it.effect("projects malformed provider output into a typed provider error", () =>
    Effect.gen(function* () {
      const engine = yield* ReviewThreadAgentEngine
      const error = yield* engine
        .run({
          ...context,
          capability: {
            ...context.capability,
            execute: () =>
              // SAFETY: This intentionally malformed fake crosses the provider boundary to test decoding.
              Effect.succeed({ malformed: true } as never) as Effect.Effect<
                ReviewThreadResult,
                AgentProviderOperationError
              >,
          },
        })
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(InvalidAgentProviderResponseError)
    }).pipe(Effect.provide(ReviewThreadAgentEngine.layer)),
  )
})
