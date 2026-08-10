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
import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { LocalReviewDetail, LocalReviewDiff } from "@diffdash/domain/local-review"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { ReviewThreadAgentResponse } from "@diffdash/domain/review-agent"
import { projectDiffHunkLines } from "@diffdash/domain/diff-hunk-lines"
import {
  ReviewKey,
  ReviewDiffIdentity,
  ReviewRevision,
  ReviewProjectId,
  ReviewSnapshotId,
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
import { LocalReviewSnapshot } from "@diffdash/domain/review-context"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { ReviewThreadAgentEngine, type ReviewThreadAgentContext } from "./review-thread"

const providerId = AgentProviderId.make("fixture")
const model = AgentModelId.make("fixture-model")
const revision = ReviewRevision.make("head-revision")

const diff = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-const value = 1
+const value = 2`
const snapshot = LocalReviewSnapshot.make({
  snapshotId: ReviewSnapshotId.make("snapshot:v1:00000000000000000000000000000001"),
  reviewKey: ReviewKey.make("local:/workspace/repo"),
  baseRevision: revision,
  headRevision: revision,
  detail: LocalReviewDetail.make({
    rootPath: RepositoryCheckoutPath.make("/workspace/repo"),
    repoName: "repo",
    branchName: RepositoryComparisonRef.make("feature/review"),
    baseSha: revision,
    headSha: revision,
    diffHash: ReviewDiffIdentity.make("diff-hash"),
    title: "Review",
    files: [],
    fetchedAt: "2026-08-09T00:00:00.000Z",
  }),
  diff: LocalReviewDiff.make({
    rootPath: RepositoryCheckoutPath.make("/workspace/repo"),
    baseSha: revision,
    headSha: revision,
    diffHash: ReviewDiffIdentity.make("diff-hash"),
    diff,
    fetchedAt: "2026-08-09T00:00:00.000Z",
  }),
  parsedDiff: parseUnifiedDiff(diff),
})
const file = snapshot.parsedDiff.files[0]
const hunk = file?.hunks[0]
const line =
  hunk === undefined
    ? undefined
    : projectDiffHunkLines(hunk).find((item) => item.kind === "addition")
if (
  file === undefined ||
  hunk === undefined ||
  line?.newLineNumber === null ||
  line?.newLineNumber === undefined
) {
  throw new Error("Expected review-thread fixture")
}
const anchor = LineReviewAnchor.make({
  fileId: file.fileId,
  filePath: file.path,
  oldPath: file.oldPath,
  hunkId: hunk.id,
  hunkFingerprint: hunk.fingerprint,
  hunkHeader: hunk.header,
  side: "new",
  lineNumber: line.newLineNumber,
  lineContent: line.content,
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
  snapshot,
  thread: ReviewThread.make({
    id: ReviewThreadId.make("thread-1"),
    repoId: ReviewProjectId.make("repo-1"),
    reviewKey: snapshot.reviewKey,
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
