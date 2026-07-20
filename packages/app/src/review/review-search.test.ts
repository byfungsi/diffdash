import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { describe, expect, it } from "@effect/vitest"
import { buildReviewSearchIndex, searchReviewIndex } from "./review-search"

const parsedDiff = parseUnifiedDiff(`diff --git a/src/agents.ts b/src/agents.ts
index 1111111..2222222 100644
--- a/src/agents.ts
+++ b/src/agents.ts
@@ -10,3 +10,3 @@
 const AgentProvider = createAgent(Agent)
-const previous = Agent[0]
+const current = agent[0]
\\ No newline at end of file`)

describe("review search", () => {
  const index = buildReviewSearchIndex(parsedDiff.files)

  it("finds case-insensitive substrings inside identifiers", () => {
    const occurrences = searchReviewIndex(index, "agent")

    expect(occurrences.map(({ side, start, text }) => ({ side, start, text }))).toEqual([
      {
        side: "context",
        start: 6,
        text: "const AgentProvider = createAgent(Agent)",
      },
      {
        side: "context",
        start: 28,
        text: "const AgentProvider = createAgent(Agent)",
      },
      {
        side: "context",
        start: 34,
        text: "const AgentProvider = createAgent(Agent)",
      },
      { side: "deletions", start: 17, text: "const previous = Agent[0]" },
      { side: "additions", start: 16, text: "const current = agent[0]" },
    ])
  })

  it("preserves old and new line coordinates for every diff side", () => {
    const occurrences = searchReviewIndex(index, "const")

    expect(
      occurrences.map(({ newLineNumber, oldLineNumber, side }) => ({
        newLineNumber,
        oldLineNumber,
        side,
      })),
    ).toEqual([
      { newLineNumber: 10, oldLineNumber: 10, side: "context" },
      { newLineNumber: null, oldLineNumber: 11, side: "deletions" },
      { newLineNumber: 11, oldLineNumber: null, side: "additions" },
    ])
  })

  it("treats regular expression characters as literal text", () => {
    expect(searchReviewIndex(index, "Agent[0]")).toHaveLength(2)
    expect(searchReviewIndex(index, "agent[0]")).toHaveLength(2)
  })

  it("returns no occurrences for an empty query or diff metadata", () => {
    expect(searchReviewIndex(index, "")).toEqual([])
    expect(searchReviewIndex(index, "No newline at end of file")).toEqual([])
  })
})
