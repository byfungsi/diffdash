import { describe, expect, it } from "@effect/vitest"
import { AgentProviderId } from "@diffdash/domain/agent-provider"
import { ExecutablePath } from "@diffdash/domain/executable-path"
import { WebUrl } from "@diffdash/domain/web-url"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewKey,
  ReviewProjectId,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import {
  CurrentReviewAnchor,
  LineReviewAnchor,
  MarkdownBody,
  ReviewThread,
  ReviewThreadDetails,
  ReviewThreadId,
  ReviewThreadMessageId,
  UserReviewThreadMessage,
  UserReviewTurn,
} from "@diffdash/domain/review-thread"
import { Result, Schema } from "effect"

import { EventChannel, InvokeChannel } from "./channels"
import { HostedRepositorySearchRequest, HostedReviewRequest } from "./hosted-git"
import { DiffDashMcpToolRequest, DiffDashMcpToolResponse, DiffDashReviewMcpTool } from "./mcp"
import {
  bridgeResult,
  EventContract,
  FailureEnvelope,
  InvokeContract,
  MINIMUM_FAILURE_ENVELOPE_BYTES,
} from "./ipc"
import { ReviewSnapshotSearchMatchId } from "./review-snapshot"
import { AddReviewThreadUserMessageRequest, RunReviewThreadAgentRequest } from "./review-threads"
import { DiffDashCliInstallResult, SetupRequirement, SetupRequirementKey } from "./prerequisites"
import {
  decodeTransportError,
  hasBridgeTransportErrorEncoding,
  isTransientTransportError,
  safeTransportErrorMessage,
  TransportError,
  TransportErrorDiagnosticTrace,
  toTransportError,
  transportError,
  UNKNOWN_TRANSPORT_ERROR_MESSAGE,
} from "./transport-error"
import { legacyBridgeTransportError } from "./testing"
import { SetHostedViewedFileRequest, SetLocalViewedFileRequest } from "./viewed-files"

describe("protocol boundaries", () => {
  it("encodes review thread responses as invariant conversation entries", () => {
    const anchor = LineReviewAnchor.make({
      fileId: ReviewFileId.make("file-1"),
      filePath: RepositoryRelativePath.make("src/app.ts"),
      oldPath: null,
      hunkId: ReviewHunkId.make("hunk-1"),
      hunkFingerprint: ReviewHunkFingerprint.make("fingerprint-1"),
      hunkHeader: "@@ -1 +1 @@",
      side: "new",
      lineNumber: 1,
      lineContent: "const value = true",
    })
    const threadId = ReviewThreadId.make("thread-1")
    const timestamp = "2026-08-10T00:00:00.000Z"
    const details = ReviewThreadDetails.make({
      thread: ReviewThread.make({
        id: threadId,
        repoId: ReviewProjectId.make("repo-1"),
        reviewKey: ReviewKey.make("review-1"),
        prNumber: 1,
        baseRevision: ReviewRevision.make("base"),
        headRevision: ReviewRevision.make("head"),
        currentBaseRevision: ReviewRevision.make("base"),
        currentHeadRevision: ReviewRevision.make("head"),
        originalAnchor: anchor,
        currentAnchor: CurrentReviewAnchor.cases.Active.make({ anchor }),
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      conversation: [
        UserReviewTurn.make({
          message: UserReviewThreadMessage.make({
            id: ReviewThreadMessageId.make("message-1"),
            threadId,
            sequence: 1,
            bodyMarkdown: MarkdownBody.make("Is this safe?"),
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        }),
      ],
    })

    const encoded = Schema.encodeSync(InvokeContract[InvokeChannel.getReviewThread].response)(
      details,
    )
    expect(encoded).toMatchObject({
      conversation: [{ _tag: "User", message: { _tag: "User", bodyMarkdown: "Is this safe?" } }],
    })
    expect("messages" in encoded).toBe(false)
  })

  it("validates search match identity while preserving its string encoding", () => {
    const id = ReviewSnapshotSearchMatchId.make("file:hunk:0:0")

    expect(Schema.encodeSync(ReviewSnapshotSearchMatchId)(id)).toBe("file:hunk:0:0")
    expect(Result.isFailure(Schema.decodeUnknownResult(ReviewSnapshotSearchMatchId)(""))).toBe(true)
  })

  it("serializes prerequisite URLs and executable paths as strings", () => {
    const requirement = SetupRequirement.make({
      key: SetupRequirementKey.make("provider:github"),
      providerId: null,
      title: "GitHub ready",
      description: "Connect GitHub.",
      detail: "Authentication required.",
      ready: false,
      requiredForLocalUse: false,
      helpUrl: WebUrl.make("https://cli.github.com/manual/gh_auth_login"),
    })
    const installResult = DiffDashCliInstallResult.make({
      path: ExecutablePath.make("/usr/local/bin/diffdash"),
      pathSetupCommand: null,
    })

    expect(Schema.encodeSync(SetupRequirement)(requirement).helpUrl).toBe(
      "https://cli.github.com/manual/gh_auth_login",
    )
    expect(Schema.encodeSync(DiffDashCliInstallResult)(installResult).path).toBe(
      "/usr/local/bin/diffdash",
    )
  })

  it("owns unique invoke and event channel names", () => {
    const invokeChannels = Object.values(InvokeChannel)
    const eventChannels = Object.values(EventChannel)

    expect(new Set(invokeChannels).size).toBe(62)
    expect(new Set(eventChannels).size).toBe(3)
    expect(new Set([...invokeChannels, ...eventChannels]).size).toBe(65)
    expect(invokeChannels).not.toEqual(
      expect.arrayContaining([
        "repositories:addLocal",
        "hostedReviews:get",
        "hostedReviews:refresh",
        "hostedReviews:getDiff",
        "hostedReviews:getSnapshot",
        "localReviews:getDetail",
        "localReviews:getDiff",
        "localReviews:getSnapshot",
      ]),
    )
  })

  it("owns closed MCP tool names and schema-backed request-response unions", () => {
    const request = Schema.decodeUnknownResult(DiffDashMcpToolRequest)({
      tool: DiffDashReviewMcpTool.searchReviewDiff,
      query: "TODO",
      caseSensitive: false,
      maxResults: 10,
    })
    const response = Schema.decodeUnknownResult(DiffDashMcpToolResponse)({
      status: "available",
      data: { matches: [], total: 0 },
    })
    const invalidRequest = Schema.decodeUnknownResult(DiffDashMcpToolRequest)({
      tool: "not-a-diffdash-tool",
    })

    expect(Result.isSuccess(request)).toBe(true)
    expect(Result.isSuccess(response)).toBe(true)
    expect(Result.isFailure(invalidRequest)).toBe(true)
  })

  it("decodes MCP file, hunk, and artifact identities through domain schemas", () => {
    const malformedRequests = [
      {
        tool: DiffDashReviewMcpTool.getDiffHunk,
        fileId: "",
        hunkId: "hunk-1",
        startLine: 0,
        lineCount: 10,
      },
      {
        tool: DiffDashReviewMcpTool.getDiffHunk,
        fileId: "file-1",
        hunkId: "",
        startLine: 0,
        lineCount: 10,
      },
      { tool: DiffDashReviewMcpTool.getDiffFile, fileId: "" },
      { tool: DiffDashReviewMcpTool.getPriorArtifact, artifactId: "" },
    ]

    for (const request of malformedRequests) {
      expect(Result.isFailure(Schema.decodeUnknownResult(DiffDashMcpToolRequest)(request))).toBe(
        true,
      )
    }
  })

  it("owns positive safe-integer byte budgets on every contract entry", () => {
    for (const contract of Object.values(InvokeContract)) {
      expect(Number.isSafeInteger(contract.maxRequestBytes)).toBe(true)
      expect(contract.maxRequestBytes).toBeGreaterThan(0)
      expect(Number.isSafeInteger(contract.maxResponseBytes)).toBe(true)
      expect(contract.maxResponseBytes).toBeGreaterThanOrEqual(MINIMUM_FAILURE_ENVELOPE_BYTES)
    }
    for (const contract of Object.values(EventContract)) {
      expect(Number.isSafeInteger(contract.maxPayloadBytes)).toBe(true)
      expect(contract.maxPayloadBytes).toBeGreaterThan(0)
    }
  })

  it("decodes success and failure values through one typed bridge result schema", () => {
    const responseSchema = bridgeResult(InvokeContract[InvokeChannel.analyticsStart].response)
    const success = Schema.decodeUnknownResult(responseSchema)({ _tag: "Success", value: null })
    const failure = Schema.decodeUnknownResult(responseSchema)({
      _tag: "Failure",
      error: transportError("EXPECTED_FAILURE", "Expected failure"),
    })

    expect(Result.isSuccess(success)).toBe(true)
    expect(Result.isSuccess(failure)).toBe(true)
    expect(
      Schema.decodeUnknownSync(FailureEnvelope)({
        _tag: "Failure",
        error: transportError("EXPECTED_FAILURE", "Expected failure"),
      }).error.code,
    ).toBe("EXPECTED_FAILURE")
  })

  it("validates project opening and workspace identities at the IPC boundary", () => {
    const opening = Schema.decodeUnknownResult(InvokeContract[InvokeChannel.openProject].request)({
      localPath: "/workspace/diffdash",
      selectedRepository: {
        providerId: "github",
        namespace: "fungsi",
        name: "diffdash",
      },
    })
    const ambiguous = Schema.decodeUnknownResult(
      InvokeContract[InvokeChannel.openProject].response,
    )({
      _tag: "remoteSelectionRequired",
      rootPath: "/workspace/diffdash",
      candidates: [
        {
          remoteName: "origin",
          repository: { providerId: "github", namespace: "fungsi", name: "diffdash" },
        },
      ],
    })
    const forgotten = Schema.decodeUnknownResult(
      InvokeContract[InvokeChannel.forgetRepository].request,
    )({ projectId: "" })
    const workspace = Schema.decodeUnknownResult(
      InvokeContract[InvokeChannel.projectWorkspaceSave].request,
    )({
      input: { projectId: "", activeRibbon: "files", selectedReviewTarget: null },
    })
    const relativeCheckout = Schema.decodeUnknownResult(
      InvokeContract[InvokeChannel.openProject].request,
    )({ localPath: "relative/repository", selectedRepository: null })
    const traversingFile = Schema.decodeUnknownResult(
      InvokeContract[InvokeChannel.appOpenLocalRepositoryFile].request,
    )({ rootPath: "/workspace/diffdash", filePath: "../secret.txt" })
    const emptyFavorite = Schema.decodeUnknownResult(
      InvokeContract[InvokeChannel.setRepositoryFavorite].request,
    )({ id: "", isFavorite: true })

    expect(Result.isSuccess(opening)).toBe(true)
    expect(Result.isFailure(ambiguous)).toBe(true)
    expect(Result.isFailure(forgotten)).toBe(true)
    expect(Result.isFailure(workspace)).toBe(true)
    expect(Result.isFailure(relativeCheckout)).toBe(true)
    expect(Result.isFailure(traversingFile)).toBe(true)
    expect(Result.isFailure(emptyFavorite)).toBe(true)
  })

  it("rejects malformed review-thread requests", () => {
    const result = Schema.decodeUnknownResult(AddReviewThreadUserMessageRequest)({
      bodyMarkdown: "Follow up",
      threadId: "",
    })

    expect(Result.isFailure(result)).toBe(true)
  })

  it("requires canonical repository and revision identity on review-turn requests", () => {
    const result = Schema.decodeUnknownResult(RunReviewThreadAgentRequest)({
      threadId: "thread-10",
      target: {
        kind: "hosted",
        review: {
          repository: { providerId: "github", namespace: "fungsi", name: "diffdash" },
          number: 10,
        },
      },
    })

    expect(Result.isFailure(result)).toBe(true)
  })

  it("serializes review-thread anchor state as the tagged IPC contract", () => {
    const anchor = {
      _tag: "line",
      fileId: "file-1",
      filePath: "src/app.ts",
      oldPath: null,
      hunkId: "hunk-1",
      hunkFingerprint: "fingerprint-1",
      hunkHeader: "@@ -1 +1 @@",
      side: "new",
      lineNumber: 1,
      lineContent: "new",
    }
    const thread = {
      id: "thread-1",
      repoId: "repo-1",
      reviewKey: "review-1",
      prNumber: 1,
      baseRevision: "base",
      headRevision: "head",
      currentBaseRevision: "base",
      currentHeadRevision: "head",
      originalAnchor: anchor,
      currentAnchor: { _tag: "Active", anchor },
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    }
    const response = InvokeContract[InvokeChannel.listReviewThreads].response

    expect(Result.isSuccess(Schema.decodeUnknownResult(response)([thread]))).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(response)([
          { ...thread, currentAnchor: anchor, anchorStatus: "active" },
        ]),
      ),
    ).toBe(true)
  })

  it("FUN-126 AC: rejects hosted requests without complete provider identity", () => {
    const search = Schema.decodeUnknownResult(HostedRepositorySearchRequest)({
      query: "diffdash",
      namespaces: ["fungsi"],
    })
    const review = Schema.decodeUnknownResult(HostedReviewRequest)({
      review: {
        repository: { namespace: "fungsi", name: "diffdash" },
        number: 126,
      },
    })

    expect(Result.isFailure(search)).toBe(true)
    expect(Result.isFailure(review)).toBe(true)
  })

  it("rejects incomplete viewed-file content identities", () => {
    const hosted = Schema.decodeUnknownResult(SetHostedViewedFileRequest)({
      review: {
        repository: {
          providerId: "github",
          namespace: "fungsi",
          name: "diffdash",
        },
        number: 51,
      },
      baseRefName: "",
      reviewKey: "src/app.ts",
      patchHash: "",
      viewed: true,
    })
    const local = Schema.decodeUnknownResult(SetLocalViewedFileRequest)({
      target: { kind: "local", rootPath: "/repo", comparison: { _tag: "workingTree" } },
      sourceBranch: "feature/auth",
      reviewKey: "src/app.ts",
      patchHash: "",
      viewed: true,
    })

    expect(Result.isFailure(hosted)).toBe(true)
    expect(Result.isFailure(local)).toBe(true)
  })

  it("serializes unknown failures without messages, stacks, or cause data", () => {
    const encoded = Schema.encodeSync(TransportError)(
      toTransportError(
        new Error("Could not load /Users/example/private-repo: secret stderr"),
        InvokeChannel.getReviewThread,
      ),
    )

    expect(encoded).toEqual({
      _tag: "TransportError",
      code: "INTERNAL_ERROR",
      message: UNKNOWN_TRANSPORT_ERROR_MESSAGE,
      operation: "reviewThreads:get",
    })
    expect(encoded).not.toHaveProperty("stack")
    expect(encoded).not.toHaveProperty("cause")
  })

  it("extracts only bounded protocol-owned error messages", () => {
    const explicit = transportError("SAFE", `Safe reason\n${"x".repeat(600)}`)

    expect(safeTransportErrorMessage(explicit)).not.toContain("\n")
    expect(safeTransportErrorMessage(explicit)).toHaveLength(500)
    expect(safeTransportErrorMessage(new Error("/private/path and stderr"))).toBe(
      UNKNOWN_TRANSPORT_ERROR_MESSAGE,
    )
  })

  it("preserves validated transport data through a standard Error bridge encoding", () => {
    const diagnostic = new TransportErrorDiagnosticTrace({
      provider: AgentProviderId.make("claude"),
      errorTag: "AgentProviderOperationError",
      causeTag: "ProcessExitError",
      exitCode: 1,
      signal: null,
      reason: "Authentication or authorization failure reported.",
      stderr: "Authentication or authorization failure reported.",
      stackFrames: ["at generateWalkthrough", "at runProvider"],
    })
    const bridgeError = legacyBridgeTransportError(
      transportError(
        "AgentProviderExitError",
        "Provider claude exited before completing the walkthrough.",
        InvokeChannel.generateRepositoryComparisonWalkthrough,
        diagnostic,
      ),
    )
    const contextBridgeClone = {
      name: bridgeError.name,
      message: bridgeError.message,
      stack: bridgeError.stack,
    }

    expect(bridgeError).toBeInstanceOf(Error)
    expect(decodeTransportError(contextBridgeClone)).toMatchObject({
      code: "AgentProviderExitError",
      message: "Provider claude exited before completing the walkthrough.",
      operation: InvokeChannel.generateRepositoryComparisonWalkthrough,
      diagnostic,
    })
    expect(safeTransportErrorMessage(contextBridgeClone)).toBe(
      "Provider claude exited before completing the walkthrough.",
    )
  })

  it("rejects free-form diagnostic text and stack locations", () => {
    const unsafe = Schema.decodeUnknownResult(TransportErrorDiagnosticTrace)({
      provider: "claude",
      errorTag: "AgentProviderOperationError",
      causeTag: "ProcessExitError",
      exitCode: 1,
      signal: null,
      reason: "password=hunter2",
      stderr: "private prompt and diff content",
      stackFrames: ["at runProvider (/Users/example/private.ts:10:2)"],
    })

    expect(Result.isFailure(unsafe)).toBe(true)
  })

  it("rejects malformed bridge payloads instead of trusting error text", () => {
    const malformed = new Error(
      'Error invoking remote method: DIFFDASH_TRANSPORT_ERROR_V1:{"_tag":"TransportError","code":"SAFE"}',
    )

    expect(hasBridgeTransportErrorEncoding(malformed)).toBe(true)
    expect(decodeTransportError(malformed)).toBeNull()
    expect(safeTransportErrorMessage(malformed)).toBe(UNKNOWN_TRANSPORT_ERROR_MESSAGE)
  })

  it("classifies only typed IPC failures as transient", () => {
    expect(
      isTransientTransportError(transportError("IPC_FAILURE", "Temporarily unavailable")),
    ).toBe(true)
    expect(
      isTransientTransportError(
        legacyBridgeTransportError(transportError("IPC_FAILURE", "Temporarily unavailable")),
      ),
    ).toBe(true)
    expect(
      isTransientTransportError(transportError("INVALID_RESPONSE", "Malformed response")),
    ).toBe(false)
    expect(isTransientTransportError({ code: "IPC_FAILURE" })).toBe(false)
  })
})
