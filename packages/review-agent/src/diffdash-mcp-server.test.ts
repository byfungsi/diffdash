import { Buffer } from "node:buffer"
import { readFileSync, readdirSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import {
  BranchRevision,
  HostedReviewDetail,
  HostedReviewDiff,
  HostedReviewSummary,
  ProviderActor,
  makeHostedReviewLocator,
} from "@diffdash/domain/git-provider"
import { LocalReviewDetail, LocalReviewDiff } from "@diffdash/domain/local-review"
import { AgentRunId } from "@diffdash/domain/review-agent"
import { HostedReviewSnapshot, LocalReviewSnapshot } from "@diffdash/domain/review-context"
import {
  makeReviewKey,
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewKey,
  ReviewRevision,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import {
  LineReviewAnchor,
  MarkdownBody,
  ReviewThread,
  ReviewThreadDetails,
  ReviewThreadId,
  ReviewThreadMessage,
  ReviewThreadMessageId,
} from "@diffdash/domain/review-thread"
import {
  AgentRunArtifactStore,
  AgentRunArtifactStoreError,
} from "@diffdash/persistence/agent-run-artifact-store"
import { ReviewThreadStore } from "@diffdash/persistence/review-thread-store"
import {
  ProcessExitError,
  ProcessResult,
  type ProcessRunner,
  ProcessService,
  type ProcessRequest,
} from "@diffdash/process"
import { describe, expect, it } from "@effect/vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import {
  Context,
  Deferred,
  Effect,
  Either,
  Exit,
  Fiber,
  FiberRef,
  Layer,
  Option,
  Redacted,
  Scope,
  Stream,
} from "effect"
import {
  DiffDashMcpServer,
  type DiffDashMcpRunAccess,
  type DiffDashMcpServerLayerOptions,
} from "./diffdash-mcp-server"

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
const hostedReviewLocator = makeHostedReviewLocator("github", "fungsi", "diffdash", 71)
const reviewKey = makeReviewKey(hostedReviewLocator)
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
const snapshot = HostedReviewSnapshot.make({
  snapshotId: ReviewSnapshotId.make("snapshot:v1:00000000000000000000000000000003"),
  reviewKey,
  baseRevision,
  headRevision,
  detail: HostedReviewDetail.make({
    summary: HostedReviewSummary.make({
      locator: hostedReviewLocator,
      title: "MCP context",
      body: null,
      author: ProviderActor.make({
        id: null,
        username: "reviewer",
        displayName: null,
        avatarUrl: null,
      }),
      state: "OPEN",
      decision: "none",
      url: "https://github.com/fungsi/diffdash/pull/71",
      draft: false,
      base: BranchRevision.make({ name: "main", revision: baseRevision }),
      head: BranchRevision.make({ name: "feature", revision: headRevision }),
      createdAt: null,
      updatedAt: null,
    }),
    files: [],
    commits: [],
  }),
  diff: HostedReviewDiff.make({
    locator: hostedReviewLocator,
    headRevision,
    diff: rawDiff,
    fetchedAt: "2026-07-12T00:00:00.000Z",
  }),
  parsedDiff: parseUnifiedDiff(rawDiff),
})
const localSnapshot = LocalReviewSnapshot.make({
  snapshotId: ReviewSnapshotId.make("snapshot:v1:00000000000000000000000000000004"),
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
const processResult = (request: ProcessRequest, stdout: string): ProcessResult =>
  ProcessResult.make({
    command: request.command,
    args: request.args,
    cwd: request.cwd,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    outputTruncated: false,
    exitCode: 0,
    signal: null,
  })
const makeTestLayer = (
  options: DiffDashMcpServerLayerOptions = {},
  getThread: ContextThreadGetter = () => Effect.succeed(details),
  runProcess: ContextProcessRunner = (request) => {
    if (request.args.includes("grep")) {
      return Effect.succeed(
        processResult(request, "head-sha:src/app.ts:7:export const linkedNeedle = true\n"),
      )
    }
    if (request.args.includes("show")) {
      return Effect.succeed(processResult(request, "export const linkedNeedle = true\n"))
    }
    return Effect.succeed(processResult(request, ""))
  },
) =>
  DiffDashMcpServer.layerWith(options).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          ReviewThreadStore,
          ReviewThreadStore.of({
            create: () => unavailable(),
            get: getThread,
            listForReview: () => unavailable(),
            listForRevision: () => unavailable(),
            updateCurrentMappings: () => unavailable(),
            addUserMessage: () => unavailable(),
          }),
        ),
        Layer.succeed(
          ProcessService,
          ProcessService.of({
            run: runProcess,
            streamLines: () => Stream.die(new Error("Unused test process stream")),
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

type ContextThreadGetter = Context.Tag.Service<ReviewThreadStore>["get"]
type ContextProcessRunner = ProcessRunner["run"]
const testLayer = makeTestLayer()

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
      const firstChangedFilePage = yield* Effect.promise(() =>
        client.callTool({ name: "getChangedFiles", arguments: { offset: 0, limit: 1 } }),
      )
      const secondChangedFilePage = yield* Effect.promise(() =>
        client.callTool({ name: "getChangedFiles", arguments: { offset: 1, limit: 1 } }),
      )
      const fileId = snapshot.parsedDiff.files[0]?.fileId
      if (fileId === undefined) throw new Error("Expected diff file")
      const hunkId = snapshot.parsedDiff.files[0]?.hunks[0]?.id
      if (hunkId === undefined) throw new Error("Expected diff hunk")
      const file = yield* Effect.promise(() =>
        client.callTool({ name: "getDiffFile", arguments: { fileId } }),
      )
      const firstHunkPage = yield* Effect.promise(() =>
        client.callTool({
          name: "getDiffHunk",
          arguments: { fileId, hunkId, startLine: 0, lineCount: 1 },
        }),
      )
      const lastHunkPage = yield* Effect.promise(() =>
        client.callTool({
          name: "getDiffHunk",
          arguments: { fileId, hunkId, startLine: 4, lineCount: 1 },
        }),
      )
      const unavailableHunk = yield* Effect.promise(() =>
        client.callTool({
          name: "getDiffHunk",
          arguments: { fileId, hunkId: "missing-hunk" },
        }),
      )
      const threadContext = yield* Effect.promise(() =>
        client.callTool({ name: "getThreadContext", arguments: {} }),
      )
      const olderMessages = yield* Effect.promise(() =>
        client.callTool({
          name: "getOlderThreadMessages",
          arguments: { beforeSequence: 2, limit: 1 },
        }),
      )
      const unavailableArtifact = yield* Effect.promise(() =>
        client.callTool({ name: "getPriorArtifact", arguments: { artifactId: "missing" } }),
      )
      const unavailableWalkthrough = yield* Effect.promise(() =>
        client.callTool({ name: "getWalkthroughContext", arguments: {} }),
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
      expect(toolText(changedFiles)).toContain('"status":"truncated"')
      expect(Buffer.byteLength(toolText(changedFiles), "utf8")).toBeLessThanOrEqual(400)
      expect(toolText(firstChangedFilePage)).toContain('"path":"src/app.ts"')
      expect(toolText(firstChangedFilePage)).toContain('"totalFiles":2')
      expect(toolText(firstChangedFilePage)).toContain('"hasMore":true')
      expect(toolText(firstChangedFilePage)).toContain('"nextOffset":1')
      expect(toolText(secondChangedFilePage)).toContain('"path":"src/other.ts"')
      expect(toolText(secondChangedFilePage)).toContain('"hasMore":false')
      expect(toolText(secondChangedFilePage)).toContain('"nextOffset":null')
      expect(toolText(file)).toContain('"status":"truncated"')
      expect(Buffer.byteLength(toolText(file), "utf8")).toBeLessThanOrEqual(400)
      expect(toolText(firstHunkPage)).toContain('"lines":[" const shared = \\"Alpha\\""]')
      expect(toolText(firstHunkPage)).toContain('"nextStartLine":1')
      expect(toolText(lastHunkPage)).toContain('"lines":[" tail"]')
      expect(toolText(lastHunkPage)).toContain('"nextStartLine":null')
      expect(toolText(unavailableHunk)).toContain('"status":"unavailable"')
      expect(toolText(threadContext)).toContain('"status":"truncated"')
      expect(toolText(threadContext)).toContain('\\"id\\":\\"thread-1\\"')
      expect(toolText(olderMessages)).toContain('"bodyMarkdown":"What changed?"')
      expect(toolText(olderMessages)).toContain('"nextBeforeSequence":1')
      expect(toolText(olderMessages)).toContain('"hasMore":false')
      expect(toolText(unavailableArtifact)).toContain('"status":"unavailable"')
      expect(toolText(unavailableWalkthrough)).toContain('"status":"unavailable"')
    }).pipe(Effect.provide(testLayer)),
  )

  it.scoped("hard-bounds output when the truncation envelope cannot fit", () =>
    Effect.gen(function* () {
      const server = yield* DiffDashMcpServer
      const access = yield* server.acquireRun({
        runId: AgentRunId.make("run-tiny-output"),
        threadId,
        repoId: "github:fungsi/diffdash",
        snapshot,
        localPath: null,
        walkthrough: null,
        maxToolOutputBytes: 16,
      })
      const client = new Client({ name: "diffdash-tiny-output-test", version: "1" })
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

      const context = yield* Effect.promise(() =>
        client.callTool({ name: "getReviewContext", arguments: {} }),
      )

      expect(Buffer.byteLength(toolText(context), "utf8")).toBeLessThanOrEqual(16)
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

  it.scoped("linearizes admitted requests before capability revocation", () =>
    Effect.gen(function* () {
      const admitted = yield* Deferred.make<void>()
      const releaseRequest = yield* Deferred.make<void>()
      const revoking = promiseDeferred<void>()
      const layer = makeTestLayer({
        capabilityGraceMs: 500,
        hooks: {
          onCapabilityRevoking: () => revoking.resolve(undefined),
          onHttpRequest: Deferred.succeed(admitted, undefined).pipe(
            Effect.zipRight(Deferred.await(releaseRequest)),
          ),
        },
      })

      yield* Effect.gen(function* () {
        const server = yield* DiffDashMcpServer
        const accessReady = yield* Deferred.make<AwaitedAccess>()
        const closeCapability = yield* Deferred.make<void>()
        const capabilityFiber = yield* Effect.scoped(
          Effect.gen(function* () {
            const access = yield* server.acquireRun(runContext("run-linearization"))
            yield* Deferred.succeed(accessReady, access)
            yield* Deferred.await(closeCapability)
          }),
        ).pipe(Effect.fork)
        const access = yield* Deferred.await(accessReady)
        const firstRequest = yield* Effect.promise(() => initialize(access)).pipe(Effect.fork)
        yield* Deferred.await(admitted)

        yield* Deferred.succeed(closeCapability, undefined)
        yield* Effect.promise(() => revoking.promise)
        const afterRevoke = yield* Effect.promise(() => initialize(access))
        expect(afterRevoke.status).toBe(401)

        yield* Deferred.succeed(releaseRequest, undefined)
        const admittedResponse = yield* Fiber.join(firstRequest)
        yield* Fiber.join(capabilityFiber)
        expect(admittedResponse.status).toBe(200)
      }).pipe(Effect.provide(layer))
    }),
  )

  it.scoped("treats git grep exit code 1 as a successful empty search", () =>
    Effect.gen(function* () {
      const layer = makeTestLayer(
        {},
        () => Effect.succeed(details),
        (request) =>
          request.args.includes("grep")
            ? Effect.fail(processExitError(request, 1))
            : Effect.succeed(processResult(request, "")),
      )

      yield* Effect.gen(function* () {
        const server = yield* DiffDashMcpServer
        const access = yield* server.acquireRun({
          runId: AgentRunId.make("run-linked-search-no-matches"),
          threadId,
          repoId: "github:fungsi/diffdash",
          snapshot,
          localPath: "/workspace/diffdash",
          walkthrough: null,
        })
        const connected = yield* connectClient(access)
        const search = yield* Effect.promise(() =>
          connected.client.callTool({
            name: "searchRepository",
            arguments: { query: "missing" },
          }),
        )
        yield* Effect.promise(() => connected.client.close())

        expect(toolText(search)).toContain('"status":"available"')
        expect(toolText(search)).toContain('"matches":[]')
        expect(toolText(search)).toContain('"truncated":false')
      }).pipe(Effect.scoped, Effect.provide(layer))
    }),
  )

  it.scoped("allows an admitted gated tool call to finish during the revocation grace", () =>
    Effect.gen(function* () {
      const toolStarted = yield* Deferred.make<void>()
      const releaseTool = yield* Deferred.make<void>()
      const toolFinalized = yield* Deferred.make<void>()
      const revoking = promiseDeferred<void>()
      const layer = makeTestLayer(
        {
          capabilityGraceMs: 500,
          hooks: { onCapabilityRevoking: () => revoking.resolve(undefined) },
        },
        () =>
          Deferred.succeed(toolStarted, undefined).pipe(
            Effect.zipRight(Deferred.await(releaseTool)),
            Effect.as(details),
            Effect.ensuring(Deferred.succeed(toolFinalized, undefined)),
          ),
      )

      yield* Effect.gen(function* () {
        const server = yield* DiffDashMcpServer
        const accessReady = yield* Deferred.make<AwaitedAccess>()
        const closeCapability = yield* Deferred.make<void>()
        const capabilityFiber = yield* Effect.scoped(
          Effect.gen(function* () {
            const access = yield* server.acquireRun(runContext("run-gated-tool"))
            yield* Deferred.succeed(accessReady, access)
            yield* Deferred.await(closeCapability)
          }),
        ).pipe(Effect.fork)
        const access = yield* Deferred.await(accessReady)
        const connected = yield* connectClient(access)
        const callFiber = yield* Effect.promise(() =>
          connected.client.callTool({ name: "getThreadContext", arguments: {} }),
        ).pipe(Effect.fork)
        yield* Deferred.await(toolStarted)

        yield* Deferred.succeed(closeCapability, undefined)
        yield* Effect.promise(() => revoking.promise)
        expect(Option.isNone(yield* Fiber.poll(capabilityFiber))).toBe(true)
        yield* Deferred.succeed(releaseTool, undefined)

        const result = yield* Fiber.join(callFiber)
        yield* Deferred.await(toolFinalized)
        yield* Fiber.join(capabilityFiber)
        yield* Effect.promise(() => connected.client.close())
        expect(toolText(result)).toContain('"id":"thread-1"')
      }).pipe(Effect.provide(layer))
    }),
  )

  it.scoped("interrupts an in-flight repository subprocess effect after the grace", () =>
    Effect.gen(function* () {
      const processStarted = yield* Deferred.make<void>()
      const processFinalized = yield* Deferred.make<void>()
      const layer = makeTestLayer(
        { capabilityGraceMs: 0, requestFinalizerMs: 200 },
        () => Effect.succeed(details),
        () =>
          Deferred.succeed(processStarted, undefined).pipe(
            Effect.zipRight(Effect.never),
            Effect.ensuring(Deferred.succeed(processFinalized, undefined)),
          ),
      )

      yield* Effect.gen(function* () {
        const server = yield* DiffDashMcpServer
        const accessReady = yield* Deferred.make<AwaitedAccess>()
        const closeCapability = yield* Deferred.make<void>()
        const capabilityFiber = yield* Effect.scoped(
          Effect.gen(function* () {
            const access = yield* server.acquireRun({
              ...runContext("run-cli-interruption"),
              localPath: "/workspace/diffdash",
            })
            yield* Deferred.succeed(accessReady, access)
            yield* Deferred.await(closeCapability)
          }),
        ).pipe(Effect.fork)
        const access = yield* Deferred.await(accessReady)
        const connected = yield* connectClient(access)
        const callFiber = yield* Effect.promise(() =>
          connected.client.callTool({
            name: "searchRepository",
            arguments: { query: "needle" },
          }),
        ).pipe(Effect.fork)
        yield* Deferred.await(processStarted)

        yield* Deferred.succeed(closeCapability, undefined)
        yield* Deferred.await(processFinalized)
        yield* Fiber.join(capabilityFiber)
        yield* Fiber.interrupt(callFiber)
        yield* Effect.promise(() => connected.client.close())
      }).pipe(Effect.provide(layer))
    }),
  )

  it.scoped("does not strand a request lease when the client disconnects during the body", () =>
    Effect.gen(function* () {
      const admitted = yield* Deferred.make<void>()
      const layer = makeTestLayer({
        capabilityGraceMs: 1_000,
        requestFinalizerMs: 100,
        hooks: { onHttpRequest: Deferred.succeed(admitted, undefined) },
      })

      yield* Effect.gen(function* () {
        const server = yield* DiffDashMcpServer
        const accessReady = yield* Deferred.make<AwaitedAccess>()
        const closeCapability = yield* Deferred.make<void>()
        const capabilityFiber = yield* Effect.scoped(
          Effect.gen(function* () {
            const access = yield* server.acquireRun(runContext("run-body-disconnect"))
            yield* Deferred.succeed(accessReady, access)
            yield* Deferred.await(closeCapability)
          }),
        ).pipe(Effect.fork)
        const access = yield* Deferred.await(accessReady)
        const request = openPartialRequest(access)
        request.write("{")
        yield* Deferred.await(admitted)
        request.destroy()
        yield* Effect.promise(() => nativeDelay(10))

        yield* Deferred.succeed(closeCapability, undefined)
        const completed = yield* completesWithin(Fiber.join(capabilityFiber), 200)
        expect(completed).toBe(true)
      }).pipe(Effect.provide(layer))
    }),
  )

  it.scoped("interrupts MCP setup when the response disconnects", () =>
    Effect.gen(function* () {
      const setupStarted = yield* Deferred.make<void>()
      const setupGate = yield* Deferred.make<void>()
      const setupFinalized = yield* Deferred.make<void>()
      const layer = makeTestLayer({
        capabilityGraceMs: 1_000,
        hooks: {
          beforeMcpConnect: Deferred.succeed(setupStarted, undefined).pipe(
            Effect.zipRight(Deferred.await(setupGate)),
            Effect.ensuring(Deferred.succeed(setupFinalized, undefined)),
          ),
        },
      })

      yield* Effect.gen(function* () {
        const server = yield* DiffDashMcpServer
        const accessReady = yield* Deferred.make<AwaitedAccess>()
        const closeCapability = yield* Deferred.make<void>()
        const capabilityFiber = yield* Effect.scoped(
          Effect.gen(function* () {
            const access = yield* server.acquireRun(runContext("run-setup-disconnect"))
            yield* Deferred.succeed(accessReady, access)
            yield* Deferred.await(closeCapability)
          }),
        ).pipe(Effect.fork)
        const access = yield* Deferred.await(accessReady)
        const request = openPartialRequest(access)
        request.end(INITIALIZE_BODY)
        yield* Deferred.await(setupStarted)
        request.destroy()
        yield* Deferred.await(setupFinalized)

        yield* Deferred.succeed(closeCapability, undefined)
        expect(yield* completesWithin(Fiber.join(capabilityFiber), 200)).toBe(true)
      }).pipe(Effect.provide(layer))
    }),
  )

  it.scoped("rejects oversized bodies without stranding capability disposal", () =>
    Effect.gen(function* () {
      const layer = makeTestLayer({ capabilityGraceMs: 1_000 })
      yield* Effect.gen(function* () {
        const server = yield* DiffDashMcpServer
        const access = yield* server.acquireRun(runContext("run-oversized"))
        const response = yield* Effect.promise(() =>
          fetch(access.url, {
            method: "POST",
            headers: authorizedHeaders(access),
            body: "x".repeat(1024 * 1024 + 1),
          }),
        )
        expect(response.status).toBe(413)
      }).pipe(Effect.scoped, Effect.provide(layer))
    }),
  )

  it.scoped("bounds layer disposal with a slow request body and force-closes the listener", () =>
    Effect.gen(function* () {
      const requestAdmitted = yield* Deferred.make<void>()
      let callbacks = 0
      const layer = makeTestLayer({
        capabilityGraceMs: 0,
        requestFinalizerMs: 100,
        httpCloseMs: 25,
        httpForceCloseMs: 25,
        hooks: {
          onHttpRequest: Effect.sync(() => {
            callbacks += 1
          }).pipe(Effect.zipRight(Deferred.succeed(requestAdmitted, undefined))),
        },
      })
      const layerScope = yield* Scope.make()
      const services = yield* Layer.buildWithScope(layer, layerScope)
      const server = Context.get(services, DiffDashMcpServer)
      const capabilityScope = yield* Scope.make()
      const access = yield* server
        .acquireRun(runContext("run-layer-disposal"))
        .pipe(Effect.provideService(Scope.Scope, capabilityScope))
      const request = openPartialRequest(access)
      request.write("{")
      yield* Deferred.await(requestAdmitted)

      expect(yield* completesWithin(Scope.close(layerScope, Exit.void), 300)).toBe(true)
      const callbackCount = callbacks
      const afterClose = yield* Effect.tryPromise(() => initialize(access)).pipe(Effect.either)
      expect(Either.isLeft(afterClose)).toBe(true)
      expect(callbacks).toBe(callbackCount)
      request.destroy()
      yield* Scope.close(capabilityScope, Exit.void)
    }),
  )

  it.scoped("disconnects an initialized client when the server layer scope closes", () =>
    Effect.gen(function* () {
      let callbacks = 0
      const layer = makeTestLayer({
        hooks: { onHttpRequest: Effect.sync(() => void (callbacks += 1)) },
      })
      const layerScope = yield* Scope.make()
      const services = yield* Layer.buildWithScope(layer, layerScope)
      const server = Context.get(services, DiffDashMcpServer)
      const capabilityScope = yield* Scope.make()
      const access = yield* server
        .acquireRun(runContext("run-connected-close"))
        .pipe(Effect.provideService(Scope.Scope, capabilityScope))
      const connected = yield* connectClient(access)
      yield* Effect.promise(() => connected.client.listTools())
      yield* Scope.close(layerScope, Exit.void)
      const callbackCount = callbacks

      const afterClose = yield* Effect.tryPromise(() => connected.client.listTools()).pipe(
        Effect.either,
      )
      expect(Either.isLeft(afterClose)).toBe(true)
      expect(callbacks).toBe(callbackCount)
      yield* Effect.promise(() => connected.client.close())
      yield* Scope.close(capabilityScope, Exit.void)
    }),
  )

  it.scoped("awaits explicit transport and MCP server close finalizers", () =>
    Effect.gen(function* () {
      const closeStarted = yield* Deferred.make<void>()
      const allowClose = yield* Deferred.make<void>()
      const closed: string[] = []
      const layer = makeTestLayer({
        capabilityGraceMs: 500,
        hooks: {
          beforeMcpClose: (resource) =>
            Effect.sync(() => closed.push(resource)).pipe(
              Effect.zipRight(Deferred.succeed(closeStarted, undefined)),
              Effect.zipRight(Deferred.await(allowClose)),
            ),
        },
      })

      yield* Effect.gen(function* () {
        const server = yield* DiffDashMcpServer
        const accessReady = yield* Deferred.make<AwaitedAccess>()
        const closeCapability = yield* Deferred.make<void>()
        const capabilityFiber = yield* Effect.scoped(
          Effect.gen(function* () {
            const access = yield* server.acquireRun(runContext("run-awaited-close"))
            yield* Deferred.succeed(accessReady, access)
            yield* Deferred.await(closeCapability)
          }),
        ).pipe(Effect.fork)
        const access = yield* Deferred.await(accessReady)
        const requestFiber = yield* Effect.promise(() => initialize(access)).pipe(Effect.fork)
        yield* Deferred.await(closeStarted)
        yield* Deferred.succeed(closeCapability, undefined)
        expect(Option.isNone(yield* Fiber.poll(capabilityFiber))).toBe(true)

        yield* Deferred.succeed(allowClose, undefined)
        expect((yield* Fiber.join(requestFiber)).status).toBe(200)
        yield* Fiber.join(capabilityFiber)
        expect(closed).toEqual(["transport", "server"])
      }).pipe(Effect.provide(layer))
    }),
  )

  it.scoped("inherits constructing FiberRefs in MCP callback fibers", () =>
    Effect.gen(function* () {
      const marker = yield* FiberRef.make("default")
      const observed: string[] = []
      const layer = makeTestLayer({}, () =>
        FiberRef.get(marker).pipe(
          Effect.tap((value) => Effect.sync(() => observed.push(value))),
          Effect.as(details),
        ),
      )
      yield* FiberRef.set(marker, "captured-runtime")

      yield* Effect.gen(function* () {
        const server = yield* DiffDashMcpServer
        const access = yield* server.acquireRun(runContext("run-fiber-ref"))
        const connected = yield* connectClient(access)
        yield* Effect.promise(() =>
          connected.client.callTool({ name: "getThreadContext", arguments: {} }),
        )
        yield* Effect.promise(() => connected.client.close())
      }).pipe(Effect.scoped, Effect.provide(layer))

      expect(observed).toEqual(["captured-runtime"])
    }),
  )

  it("guards review-agent source against direct global Effect promise roots", () => {
    const forbidden = ["Effect", "runPromise"].join(".")
    const sourceDirectory = new URL("./", import.meta.url)
    const violations = readdirSync(sourceDirectory, { withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"),
      )
      .filter((entry) =>
        readFileSync(new URL(entry.name, sourceDirectory), "utf8").includes(forbidden),
      )
      .map((entry) => entry.name)

    expect(violations).toEqual([])
  })
})

type AwaitedAccess = DiffDashMcpRunAccess

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "diffdash-lifecycle-test", version: "1" },
  },
})

const runContext = (runId: string) => ({
  runId: AgentRunId.make(runId),
  threadId,
  repoId: "github:fungsi/diffdash",
  snapshot,
  localPath: null,
  walkthrough: null,
})

const authorizedHeaders = (access: DiffDashMcpRunAccess) => ({
  accept: "application/json, text/event-stream",
  authorization: `Bearer ${Redacted.value(access.bearerToken)}`,
  "content-type": "application/json",
})

const initialize = (access: DiffDashMcpRunAccess) =>
  fetch(access.url, {
    method: "POST",
    headers: authorizedHeaders(access),
    body: INITIALIZE_BODY,
  })

const connectClient = (access: DiffDashMcpRunAccess) =>
  Effect.promise(async () => {
    const client = new Client({ name: "diffdash-lifecycle-test", version: "1" })
    const transport = new StreamableHTTPClientTransport(new URL(access.url), {
      requestInit: { headers: authorizedHeaders(access) },
    })
    // SAFETY: SDK callback optionality conflicts with exactOptionalPropertyTypes.
    await client.connect(transport as Transport)
    return { client, transport }
  })

const openPartialRequest = (access: DiffDashMcpRunAccess) => {
  const request = httpRequest(
    access.url,
    { method: "POST", headers: authorizedHeaders(access) },
    (response) => response.resume(),
  )
  request.on("error", () => undefined)
  return request
}

const nativeDelay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

const completesWithin = <A, E, R>(effect: Effect.Effect<A, E, R>, milliseconds: number) =>
  Effect.raceFirst(
    effect.pipe(
      Effect.as(true),
      Effect.catchAllCause(() => Effect.succeed(true)),
    ),
    Effect.promise(() => nativeDelay(milliseconds)).pipe(Effect.as(false)),
  )

const promiseDeferred = <A>() => {
  let complete: ((value: A | PromiseLike<A>) => void) | undefined
  const promise = new Promise<A>((resolve) => {
    complete = resolve
  })
  return {
    promise,
    resolve: (value: A | PromiseLike<A>) => complete?.(value),
  }
}

const processExitError = (request: ProcessRequest, exitCode: number) =>
  ProcessExitError.make({
    command: request.command,
    args: request.args,
    cwd: request.cwd,
    exitCode,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    outputTruncated: false,
    message: `Command exited with code ${exitCode}`,
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
