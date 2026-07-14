import { Buffer } from "node:buffer"
import { describe, expect, it } from "@effect/vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { Effect, Layer, Redacted } from "effect"
import { parseUnifiedDiff } from "../../shared/diff-parser"
import {
  LocalReviewDetail,
  LocalReviewDiff,
  PullRequestDetail,
  PullRequestDiff,
  ReviewActor,
} from "../../shared/domain"
import { AgentRunId } from "../../shared/review-agent"
import { LocalReviewSnapshot, PullRequestReviewSnapshot } from "../../shared/review-context"
import {
  makePullRequestReviewKey,
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewKey,
  ReviewRevision,
} from "../../shared/review-identity"
import {
  LineReviewAnchor,
  MarkdownBody,
  ReviewThread,
  ReviewThreadDetails,
  ReviewThreadId,
  ReviewThreadMessage,
  ReviewThreadMessageId,
} from "../../shared/review-thread"
import { AgentRunArtifactStore, AgentRunArtifactStoreError } from "./agent-run-artifact-store"
import { type CliResult, CliService } from "./cli"
import { DiffDashMcpServer } from "./diffdash-mcp-server"
import { ReviewThreadStore } from "./review-thread-store"

const rawDiff = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,3 +10,4 @@
 const shared = "Alpha"
-old Needle
+New Needle ${"new-value ".repeat(100)}
+new needle again
 tail
diff --git a/src/other.ts b/src/other.ts
index 3333333..4444444 100644
--- a/src/other.ts
+++ b/src/other.ts
@@ -20 +20 @@
-disabled
+New Needle elsewhere`

const threadId = ReviewThreadId.make("thread-1")
const reviewKey = makePullRequestReviewKey("github", "fungsi", "diffdash", 71)
const baseRevision = ReviewRevision.make("base-sha")
const headRevision = ReviewRevision.make("head-sha")
const lineAnchor = LineReviewAnchor.make({
  fileId: ReviewFileId.make("file-71"),
  filePath: "src/app.ts",
  oldPath: null,
  hunkId: ReviewHunkId.make("hunk-71"),
  hunkFingerprint: ReviewHunkFingerprint.make("fingerprint-71"),
  hunkHeader: "@@ -1 +1 @@",
  side: "new",
  lineNumber: 1,
  lineContent: "new",
})
const snapshot = PullRequestReviewSnapshot.make({
  reviewKey,
  baseRevision,
  headRevision,
  detail: PullRequestDetail.make({
    repoOwner: "fungsi",
    repoName: "diffdash",
    number: 71,
    title: "MCP context",
    body: null,
    author: ReviewActor.make({ login: "reviewer" }),
    state: "OPEN",
    url: "https://github.com/fungsi/diffdash/pull/71",
    isDraft: false,
    baseRefName: "main",
    baseRefOid: baseRevision,
    headRefName: "feature",
    headRefOid: headRevision,
    createdAt: null,
    updatedAt: null,
    files: [],
    commits: [],
  }),
  diff: PullRequestDiff.make({
    repoOwner: "fungsi",
    repoName: "diffdash",
    number: 71,
    headRefOid: headRevision,
    diff: rawDiff,
    fetchedAt: "2026-07-12T00:00:00.000Z",
  }),
  parsedDiff: parseUnifiedDiff(rawDiff),
})
const localSnapshot = LocalReviewSnapshot.make({
  reviewKey: ReviewKey.make("local:/workspace/diffdash"),
  baseRevision,
  headRevision,
  detail: LocalReviewDetail.make({
    rootPath: "/workspace/diffdash",
    repoName: "diffdash",
    branchName: "feature/mcp",
    baseSha: baseRevision,
    headSha: headRevision,
    diffHash: "diff-hash",
    title: "Local changes",
    files: [],
    fetchedAt: "2026-07-12T00:00:00.000Z",
  }),
  diff: LocalReviewDiff.make({
    rootPath: "/workspace/diffdash",
    baseSha: baseRevision,
    headSha: headRevision,
    diffHash: "diff-hash",
    diff: rawDiff,
    fetchedAt: "2026-07-12T00:00:00.000Z",
  }),
  parsedDiff: parseUnifiedDiff(rawDiff),
})

const details = ReviewThreadDetails.make({
  thread: ReviewThread.make({
    id: threadId,
    repoId: "github:fungsi/diffdash",
    reviewKey,
    prNumber: 71,
    baseRevision,
    headRevision,
    currentBaseRevision: baseRevision,
    currentHeadRevision: headRevision,
    originalAnchor: lineAnchor,
    currentAnchor: lineAnchor,
    anchorStatus: "active",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  }),
  messages: [
    ReviewThreadMessage.make({
      id: ReviewThreadMessageId.make("message-1"),
      threadId,
      sequence: 1,
      author: "user",
      bodyMarkdown: MarkdownBody.make("What changed?"),
      status: "complete",
      agentRunId: null,
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    }),
  ],
})

const unavailable = <A>() => Effect.die(new Error("Unused test service method")) as Effect.Effect<A>
const cliResult = (args: readonly string[], stdout: string): CliResult => ({
  command: "git",
  args,
  cwd: null,
  stdout,
  stderr: "",
  exitCode: 0,
})
const testLayer = DiffDashMcpServer.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(
        ReviewThreadStore,
        ReviewThreadStore.of({
          create: () => unavailable(),
          get: () => Effect.succeed(details),
          listForReview: () => unavailable(),
          listForRevision: () => unavailable(),
          updateCurrentMappings: () => unavailable(),
          createPendingAgentMessage: () => unavailable(),
          addUserMessage: () => unavailable(),
          completeAgentMessage: () => unavailable(),
        }),
      ),
      Layer.succeed(
        CliService,
        CliService.of({
          run: (_command, args) => {
            if (args.includes("grep")) {
              return Effect.succeed(
                cliResult(args, "head-sha:src/app.ts:7:export const linkedNeedle = true\n"),
              )
            }
            if (args.includes("show")) {
              return Effect.succeed(cliResult(args, "export const linkedNeedle = true\n"))
            }
            return Effect.succeed(cliResult(args, ""))
          },
        }),
      ),
      Layer.succeed(
        AgentRunArtifactStore,
        AgentRunArtifactStore.of({
          save: () => unavailable(),
          get: (artifactId) =>
            AgentRunArtifactStoreError.make({
              operation: "get",
              cause: new Error(`Missing ${artifactId}`),
            }),
          listForRun: () => unavailable(),
          listForThread: () => unavailable(),
        }),
      ),
    ),
  ),
)

describe("DiffDashMcpServer", () => {
  it.scoped("FUN-71 AC: requires a scoped bearer token and revokes it", () =>
    Effect.gen(function* () {
      const server = yield* DiffDashMcpServer
      const access = yield* server.acquireRun({
        runId: AgentRunId.make("run-1"),
        threadId,
        repoId: "github:fungsi/diffdash",
        snapshot,
        localPath: null,
        walkthrough: null,
      })
      const unauthorized = yield* Effect.promise(() =>
        fetch(access.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        }),
      )
      const invalid = yield* Effect.promise(() =>
        fetch(access.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${"0".repeat(64)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        }),
      )
      const revoked = yield* Effect.scoped(
        server
          .acquireRun({
            runId: AgentRunId.make("run-revoked"),
            threadId,
            repoId: "github:fungsi/diffdash",
            snapshot,
            localPath: null,
            walkthrough: null,
          })
          .pipe(
            Effect.map((temporary) => ({
              url: temporary.url,
              token: Redacted.value(temporary.bearerToken),
            })),
          ),
      )
      const afterRevoke = yield* Effect.promise(() =>
        fetch(revoked.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${revoked.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        }),
      )

      expect(unauthorized.status).toBe(401)
      expect(invalid.status).toBe(401)
      expect(afterRevoke.status).toBe(401)
      expect(Redacted.value(access.bearerToken)).toHaveLength(64)
    }).pipe(Effect.provide(testLayer)),
  )

  it.scoped("FUN-71 AC: exposes read-only review tools with bounded results", () =>
    Effect.gen(function* () {
      const server = yield* DiffDashMcpServer
      const access = yield* server.acquireRun({
        runId: AgentRunId.make("run-2"),
        threadId,
        repoId: "github:fungsi/diffdash",
        snapshot,
        localPath: null,
        walkthrough: null,
        maxToolOutputBytes: 400,
      })
      const client = new Client({ name: "diffdash-test", version: "1" })
      const transport = new StreamableHTTPClientTransport(new URL(access.url), {
        requestInit: {
          headers: { authorization: `Bearer ${Redacted.value(access.bearerToken)}` },
        },
      })
      yield* Effect.acquireRelease(
        Effect.promise(async () => {
          // SAFETY: SDK callback optionality conflicts with exactOptionalPropertyTypes.
          await client.connect(transport as Transport)
          return client
        }),
        (connected) => Effect.promise(() => connected.close()),
      )

      const tools = yield* Effect.promise(() => client.listTools())
      const changedFiles = yield* Effect.promise(() =>
        client.callTool({ name: "getChangedFiles", arguments: {} }),
      )
      const fileId = snapshot.parsedDiff.files[0]?.fileId
      if (fileId === undefined) throw new Error("Expected diff file")
      const file = yield* Effect.promise(() =>
        client.callTool({ name: "getDiffFile", arguments: { fileId } }),
      )
      const unavailableHunk = yield* Effect.promise(() =>
        client.callTool({
          name: "getDiffHunk",
          arguments: { fileId, hunkId: "missing-hunk" },
        }),
      )

      // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks toSorted; this is a fresh array.
      expect(tools.tools.map(({ name }) => name).sort()).toEqual([
        "getChangedFiles",
        "getDiffFile",
        "getDiffHunk",
        "getOlderThreadMessages",
        "getPriorArtifact",
        "getReviewContext",
        "getThreadContext",
        "getWalkthroughContext",
        "readRepositoryFile",
        "searchRepository",
        "searchReviewDiff",
      ])
      expect(
        tools.tools.every(
          (tool) =>
            tool.annotations?.readOnlyHint === true &&
            tool.annotations.destructiveHint === false &&
            tool.annotations.openWorldHint === false,
        ),
      ).toBe(true)
      expect(toolText(changedFiles)).toContain('"status":"available"')
      expect(toolText(file)).toContain('"status":"truncated"')
      expect(Buffer.byteLength(toolText(file), "utf8")).toBeLessThanOrEqual(400)
      expect(toolText(unavailableHunk)).toContain('"status":"unavailable"')
    }).pipe(Effect.provide(testLayer)),
  )

  it.scoped("searches immutable PR diff lines with deterministic metadata and bounds", () =>
    Effect.gen(function* () {
      const server = yield* DiffDashMcpServer
      const access = yield* server.acquireRun({
        runId: AgentRunId.make("run-search"),
        threadId,
        repoId: "github:fungsi/diffdash",
        snapshot,
        localPath: null,
        walkthrough: null,
      })
      const client = new Client({ name: "diffdash-search-test", version: "1" })
      const transport = new StreamableHTTPClientTransport(new URL(access.url), {
        requestInit: {
          headers: { authorization: `Bearer ${Redacted.value(access.bearerToken)}` },
        },
      })
      yield* Effect.acquireRelease(
        Effect.promise(async () => {
          // SAFETY: SDK callback optionality conflicts with exactOptionalPropertyTypes.
          await client.connect(transport as Transport)
          return client
        }),
        (connected) => Effect.promise(() => connected.close()),
      )

      const limited = yield* Effect.promise(() =>
        client.callTool({
          name: "searchReviewDiff",
          arguments: { query: "new needle", maxResults: 1 },
        }),
      )
      const caseSensitive = yield* Effect.promise(() =>
        client.callTool({
          name: "searchReviewDiff",
          arguments: { query: "New Needle", caseSensitive: true },
        }),
      )
      const pathScoped = yield* Effect.promise(() =>
        client.callTool({
          name: "searchReviewDiff",
          arguments: { query: "needle", path: "src/other.ts" },
        }),
      )
      const fixedString = yield* Effect.promise(() =>
        client.callTool({ name: "searchReviewDiff", arguments: { query: ".*" } }),
      )
      const invalidBound = yield* Effect.promise(() =>
        client.callTool({
          name: "searchReviewDiff",
          arguments: { query: "needle", maxResults: 101 },
        }),
      )
      const invalidLowerBound = yield* Effect.promise(() =>
        client.callTool({
          name: "searchReviewDiff",
          arguments: { query: "needle", maxResults: 0 },
        }),
      )

      expect(toolText(limited)).toContain('"total":3')
      expect(toolText(limited)).toContain('"truncated":true')
      expect(toolText(limited)).toContain('"path":"src/app.ts"')
      expect(toolText(limited)).toContain('"patchLine":"+New Needle')
      expect(toolText(limited)).toContain('"oldLineNumber":null')
      expect(toolText(limited)).toContain('"newLineNumber":11')
      expect(toolText(caseSensitive)).toContain('"total":2')
      expect(toolText(pathScoped)).toContain('"total":1')
      expect(toolText(pathScoped)).toContain('"path":"src/other.ts"')
      expect(toolText(pathScoped)).toContain('"newLineNumber":20')
      expect(toolText(fixedString)).toContain('"total":0')
      expect(invalidBound.isError).toBe(true)
      expect(invalidLowerBound.isError).toBe(true)
    }).pipe(Effect.provide(testLayer)),
  )

  it.scoped("searches and reads an isolated worktree at the immutable PR head", () =>
    Effect.gen(function* () {
      const server = yield* DiffDashMcpServer
      const access = yield* server.acquireRun({
        runId: AgentRunId.make("run-linked-search"),
        threadId,
        repoId: "github:fungsi/diffdash",
        snapshot,
        localPath: "/workspace/diffdash",
        walkthrough: null,
      })
      const client = new Client({ name: "diffdash-linked-search-test", version: "1" })
      const transport = new StreamableHTTPClientTransport(new URL(access.url), {
        requestInit: {
          headers: { authorization: `Bearer ${Redacted.value(access.bearerToken)}` },
        },
      })
      yield* Effect.acquireRelease(
        Effect.promise(async () => {
          await client.connect(transport as Transport)
          return client
        }),
        (connected) => Effect.promise(() => connected.close()),
      )

      const search = yield* Effect.promise(() =>
        client.callTool({ name: "searchRepository", arguments: { query: "linkedNeedle" } }),
      )
      const file = yield* Effect.promise(() =>
        client.callTool({ name: "readRepositoryFile", arguments: { path: "src/app.ts" } }),
      )
      const escaped = yield* Effect.promise(() =>
        client.callTool({ name: "readRepositoryFile", arguments: { path: "../secret" } }),
      )

      expect(toolText(search)).toContain('"revision":"head-sha"')
      expect(toolText(search)).toContain('"lineNumber":7')
      expect(toolText(search)).toContain('"source":"isolated-worktree"')
      expect(toolText(file)).toContain("linkedNeedle")
      expect(toolText(escaped)).toContain('"status":"unavailable"')
    }).pipe(Effect.provide(testLayer)),
  )

  it.scoped("FUN-71 AC: serves provider-neutral local review context", () =>
    Effect.gen(function* () {
      const server = yield* DiffDashMcpServer
      const access = yield* server.acquireRun({
        runId: AgentRunId.make("run-local"),
        threadId,
        repoId: "local:/workspace/diffdash",
        snapshot: localSnapshot,
        localPath: null,
        walkthrough: null,
      })
      const client = new Client({ name: "diffdash-local-test", version: "1" })
      const transport = new StreamableHTTPClientTransport(new URL(access.url), {
        requestInit: {
          headers: { authorization: `Bearer ${Redacted.value(access.bearerToken)}` },
        },
      })
      yield* Effect.acquireRelease(
        Effect.promise(async () => {
          // SAFETY: SDK callback optionality conflicts with exactOptionalPropertyTypes.
          await client.connect(transport as Transport)
          return client
        }),
        (connected) => Effect.promise(() => connected.close()),
      )

      const context = yield* Effect.promise(() =>
        client.callTool({ name: "getReviewContext", arguments: {} }),
      )
      const search = yield* Effect.promise(() =>
        client.callTool({
          name: "searchReviewDiff",
          arguments: { query: "new needle", path: "src/app.ts" },
        }),
      )
      expect(toolText(context)).toContain('"kind":"local"')
      expect(toolText(context)).toContain('"title":"Local changes"')
      expect(toolText(search)).toContain('"status":"available"')
      expect(toolText(search)).toContain('"total":2')
    }).pipe(Effect.provide(testLayer)),
  )
})

const toolText = (result: Awaited<ReturnType<Client["callTool"]>>) => {
  if (typeof result !== "object" || result === null || !("content" in result)) {
    throw new Error("Expected tool content")
  }
  const content = result.content
  if (!Array.isArray(content)) throw new Error("Expected tool content array")
  const first: unknown = content[0]
  if (typeof first !== "object" || first === null || !("type" in first) || !("text" in first)) {
    throw new Error("Expected text tool result")
  }
  if (first.type !== "text" || typeof first.text !== "string") {
    throw new Error("Expected text tool result")
  }
  return first.text
}
