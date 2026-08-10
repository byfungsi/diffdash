import { McpToolName } from "@diffdash/domain/agent-provider"
import { ReviewAgentArtifactId } from "@diffdash/domain/review-agent"
import { ReviewFileId, ReviewHunkId } from "@diffdash/domain/review-identity"
import { Schema } from "effect"

/** Canonical names for the read-only DiffDash review-context tools. */
export const DiffDashReviewMcpTool = {
  getReviewContext: "getReviewContext",
  getChangedFiles: "getChangedFiles",
  searchReviewDiff: "searchReviewDiff",
  getDiffHunk: "getDiffHunk",
  getDiffFile: "getDiffFile",
  searchRepository: "searchRepository",
  readRepositoryFile: "readRepositoryFile",
  getThreadContext: "getThreadContext",
  getOlderThreadMessages: "getOlderThreadMessages",
  getPriorArtifact: "getPriorArtifact",
  getWalkthroughContext: "getWalkthroughContext",
} as const

/** Closed schema for a canonical DiffDash review-context tool name. */
export const DiffDashMcpToolName = Schema.Literals([
  DiffDashReviewMcpTool.getReviewContext,
  DiffDashReviewMcpTool.getChangedFiles,
  DiffDashReviewMcpTool.searchReviewDiff,
  DiffDashReviewMcpTool.getDiffHunk,
  DiffDashReviewMcpTool.getDiffFile,
  DiffDashReviewMcpTool.searchRepository,
  DiffDashReviewMcpTool.readRepositoryFile,
  DiffDashReviewMcpTool.getThreadContext,
  DiffDashReviewMcpTool.getOlderThreadMessages,
  DiffDashReviewMcpTool.getPriorArtifact,
  DiffDashReviewMcpTool.getWalkthroughContext,
])

/** Closed type for a canonical DiffDash review-context tool name. */
export type DiffDashMcpToolName = typeof DiffDashMcpToolName.Type

/** Complete canonical review-context tool allowlist for provider execution policies. */
export const DIFFDASH_REVIEW_MCP_TOOLS: ReadonlyArray<McpToolName> = [
  McpToolName.make(DiffDashReviewMcpTool.getReviewContext),
  McpToolName.make(DiffDashReviewMcpTool.getChangedFiles),
  McpToolName.make(DiffDashReviewMcpTool.searchReviewDiff),
  McpToolName.make(DiffDashReviewMcpTool.getDiffHunk),
  McpToolName.make(DiffDashReviewMcpTool.getDiffFile),
  McpToolName.make(DiffDashReviewMcpTool.searchRepository),
  McpToolName.make(DiffDashReviewMcpTool.readRepositoryFile),
  McpToolName.make(DiffDashReviewMcpTool.getThreadContext),
  McpToolName.make(DiffDashReviewMcpTool.getOlderThreadMessages),
  McpToolName.make(DiffDashReviewMcpTool.getPriorArtifact),
  McpToolName.make(DiffDashReviewMcpTool.getWalkthroughContext),
]

/** Request for immutable metadata about the current review run. */
export const GetReviewContextRequest = Schema.Struct({
  tool: Schema.Literal(DiffDashReviewMcpTool.getReviewContext),
})

/** Type of a request for immutable metadata about the current review run. */
export type GetReviewContextRequest = typeof GetReviewContextRequest.Type

/** Request for a deterministic page of changed files. */
export const GetChangedFilesRequest = Schema.Struct({
  tool: Schema.Literal(DiffDashReviewMcpTool.getChangedFiles),
  offset: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
})

/** Type of a request for a deterministic page of changed files. */
export type GetChangedFilesRequest = typeof GetChangedFilesRequest.Type

/** Request for fixed-string search across parsed review-diff lines. */
export const SearchReviewDiffRequest = Schema.Struct({
  tool: Schema.Literal(DiffDashReviewMcpTool.searchReviewDiff),
  query: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(1024)),
  ),
  path: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMinLength(1)))),
  caseSensitive: Schema.Boolean,
  maxResults: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
})

/** Type of a request for fixed-string search across parsed review-diff lines. */
export type SearchReviewDiffRequest = typeof SearchReviewDiffRequest.Type

/** Request for one bounded page of a stable diff hunk. */
export const GetDiffHunkRequest = Schema.Struct({
  tool: Schema.Literal(DiffDashReviewMcpTool.getDiffHunk),
  fileId: ReviewFileId,
  hunkId: ReviewHunkId,
  startLine: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  lineCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
})

/** Type of a request for one bounded page of a stable diff hunk. */
export type GetDiffHunkRequest = typeof GetDiffHunkRequest.Type

/** Request for exact patch text for one stable changed-file ID. */
export const GetDiffFileRequest = Schema.Struct({
  tool: Schema.Literal(DiffDashReviewMcpTool.getDiffFile),
  fileId: ReviewFileId,
})

/** Type of a request for exact patch text for one stable changed-file ID. */
export type GetDiffFileRequest = typeof GetDiffFileRequest.Type

/** Request for fixed-string search at the immutable review head revision. */
export const SearchRepositoryRequest = Schema.Struct({
  tool: Schema.Literal(DiffDashReviewMcpTool.searchRepository),
  query: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(1024)),
  ),
  path: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMinLength(1)))),
  caseSensitive: Schema.Boolean,
  maxResults: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
})

/** Type of a request for fixed-string search at the immutable review head revision. */
export type SearchRepositoryRequest = typeof SearchRepositoryRequest.Type

/** Request for one repository file at the immutable review head revision. */
export const ReadRepositoryFileRequest = Schema.Struct({
  tool: Schema.Literal(DiffDashReviewMcpTool.readRepositoryFile),
  path: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(4096)),
  ),
})

/** Type of a request for one repository file at the immutable review head revision. */
export type ReadRepositoryFileRequest = typeof ReadRepositoryFileRequest.Type

/** Request for the local thread context associated with this review run. */
export const GetThreadContextRequest = Schema.Struct({
  tool: Schema.Literal(DiffDashReviewMcpTool.getThreadContext),
})

/** Type of a request for the local thread context associated with this review run. */
export type GetThreadContextRequest = typeof GetThreadContextRequest.Type

/** Request for older messages in the local thread. */
export const GetOlderThreadMessagesRequest = Schema.Struct({
  tool: Schema.Literal(DiffDashReviewMcpTool.getOlderThreadMessages),
  beforeSequence: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
  limit: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
})

/** Type of a request for older messages in the local thread. */
export type GetOlderThreadMessagesRequest = typeof GetOlderThreadMessagesRequest.Type

/** Request for one normalized artifact owned by the current thread. */
export const GetPriorArtifactRequest = Schema.Struct({
  tool: Schema.Literal(DiffDashReviewMcpTool.getPriorArtifact),
  artifactId: ReviewAgentArtifactId,
})

/** Type of a request for one normalized artifact owned by the current thread. */
export type GetPriorArtifactRequest = typeof GetPriorArtifactRequest.Type

/** Request for the cached walkthrough associated with this review run. */
export const GetWalkthroughContextRequest = Schema.Struct({
  tool: Schema.Literal(DiffDashReviewMcpTool.getWalkthroughContext),
})

/** Type of a request for the cached walkthrough associated with this review run. */
export type GetWalkthroughContextRequest = typeof GetWalkthroughContextRequest.Type

/** Complete decoded request accepted by the Core-owned MCP handler port. */
export const DiffDashMcpToolRequest = Schema.Union([
  GetReviewContextRequest,
  GetChangedFilesRequest,
  SearchReviewDiffRequest,
  GetDiffHunkRequest,
  GetDiffFileRequest,
  SearchRepositoryRequest,
  ReadRepositoryFileRequest,
  GetThreadContextRequest,
  GetOlderThreadMessagesRequest,
  GetPriorArtifactRequest,
  GetWalkthroughContextRequest,
])

/** Type of a decoded request accepted by the Core-owned MCP handler port. */
export type DiffDashMcpToolRequest = typeof DiffDashMcpToolRequest.Type

/** Successful JSON-safe result from a Core-owned MCP tool handler. */
export const DiffDashMcpToolAvailableResponse = Schema.Struct({
  status: Schema.Literal("available"),
  data: Schema.Json,
})

/** Type of a successful JSON-safe result from a Core-owned MCP tool handler. */
export type DiffDashMcpToolAvailableResponse = typeof DiffDashMcpToolAvailableResponse.Type

/** Unavailable result from a Core-owned MCP tool handler. */
export const DiffDashMcpToolUnavailableResponse = Schema.Struct({
  status: Schema.Literal("unavailable"),
  reason: Schema.String,
})

/** Type of an unavailable result from a Core-owned MCP tool handler. */
export type DiffDashMcpToolUnavailableResponse = typeof DiffDashMcpToolUnavailableResponse.Type

/** Complete response union returned by the Core-owned MCP handler port. */
export const DiffDashMcpToolResponse = Schema.Union([
  DiffDashMcpToolAvailableResponse,
  DiffDashMcpToolUnavailableResponse,
])

/** Type of a response returned by the Core-owned MCP handler port. */
export type DiffDashMcpToolResponse = typeof DiffDashMcpToolResponse.Type
