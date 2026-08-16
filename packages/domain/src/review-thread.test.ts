import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"

import { parseUnifiedDiff } from "./diff-parser"
import {
  CurrentReviewAnchor,
  FailedAgentReviewThreadMessage,
  InternalReviewThreadMessageFailure,
  LineReviewAnchor,
  MarkdownBody,
  PendingAgentReviewThreadMessage,
  ReviewThreadId,
  ReviewThreadMessage,
  ReviewThreadMessageId,
  UserReviewThreadMessage,
} from "./review-thread"
import { AgentRunId } from "./agent-run-id"

const parsedDiff = parseUnifiedDiff(`diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,2 @@
 const stable = true
-const value = "old"
+const value = "new"`)

const file = parsedDiff.files[0]
const hunk = file?.hunks[0]
if (file === undefined || hunk === undefined) throw new Error("Expected parsed review fixture")

describe("review thread anchors", () => {
  it("encodes only valid tagged current-anchor states", () => {
    const anchor = LineReviewAnchor.make({
      fileId: file.fileId,
      filePath: file.path,
      oldPath: file.oldPath,
      hunkId: hunk.id,
      hunkFingerprint: hunk.fingerprint,
      hunkHeader: hunk.header,
      side: "new",
      lineNumber: 2,
      lineContent: 'const value = "new"',
    })
    const active = CurrentReviewAnchor.cases.Active.make({ anchor })
    const encoded = Schema.encodeSync(CurrentReviewAnchor)(active)

    expect(encoded).toEqual({ _tag: "Active", anchor })
    expect(Schema.decodeUnknownSync(CurrentReviewAnchor)(encoded)).toEqual(active)
    expect(
      Result.isFailure(Schema.decodeUnknownResult(CurrentReviewAnchor)({ _tag: "Active" })),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(CurrentReviewAnchor)({
          currentAnchor: null,
          anchorStatus: "active",
        }),
      ),
    ).toBe(true)
  })

})

describe("review thread message lifecycle", () => {
  const identity = {
    id: ReviewThreadMessageId.make("message-1"),
    threadId: ReviewThreadId.make("thread-1"),
    sequence: 1,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  }

  it("encodes authorship and lifecycle as closed variants", () => {
    const user = UserReviewThreadMessage.make({
      ...identity,
      bodyMarkdown: MarkdownBody.make("Inspect this line."),
    })
    const pending = PendingAgentReviewThreadMessage.make({
      ...identity,
      id: ReviewThreadMessageId.make("message-2"),
      agentRunId: AgentRunId.make("run-1"),
    })
    const failed = FailedAgentReviewThreadMessage.make({
      ...identity,
      id: ReviewThreadMessageId.make("message-3"),
      agentRunId: AgentRunId.make("run-2"),
      failure: InternalReviewThreadMessageFailure.make({}),
    })

    expect(Schema.encodeSync(ReviewThreadMessage)(user)).toEqual({
      _tag: "User",
      ...identity,
      bodyMarkdown: "Inspect this line.",
    })
    expect(Schema.encodeSync(ReviewThreadMessage)(pending)).toMatchObject({ _tag: "Pending" })
    expect(Schema.encodeSync(ReviewThreadMessage)(failed)).toMatchObject({
      _tag: "Failed",
      failure: { _tag: "Internal" },
    })
  })

  it("rejects invalid message sequences and timestamps", () => {
    const message = {
      _tag: "User",
      ...identity,
      bodyMarkdown: "Inspect this line.",
    }

    expect(() =>
      Schema.decodeUnknownSync(ReviewThreadMessage)({ ...message, sequence: -1 }),
    ).toThrow("sequence")
    expect(() =>
      Schema.decodeUnknownSync(ReviewThreadMessage)({ ...message, sequence: 1.5 }),
    ).toThrow("sequence")
    expect(() =>
      Schema.decodeUnknownSync(ReviewThreadMessage)({
        ...message,
        createdAt: "2026-08-10T00:00:00+00:00",
      }),
    ).toThrow("createdAt")
  })
})
