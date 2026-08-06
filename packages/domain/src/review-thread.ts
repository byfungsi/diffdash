import { Schema } from "effect"

import { LocalReviewTarget } from "./local-review"
import { HostedReviewLocator } from "./git-provider"
import { RepositoryComparisonTarget } from "./repository-comparison"
import { findProjectedDiffHunkLine, projectDiffHunkLines } from "./diff-hunk-lines"

export { LocalReviewTarget } from "./local-review"

import {
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewKey,
  ReviewRevision,
} from "./review-identity"
import type { ParsedDiff } from "./diff"

/** Persistent identity for one local DiffDash review thread. */
export const ReviewThreadId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("ReviewThreadId"),
)

/** Persistent identity for one local DiffDash review thread. */
export type ReviewThreadId = typeof ReviewThreadId.Type

/** Persistent identity for one message in a local review thread. */
export const ReviewThreadMessageId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("ReviewThreadMessageId"),
)

/** Persistent identity for one message in a local review thread. */
export type ReviewThreadMessageId = typeof ReviewThreadMessageId.Type

/** Markdown content stored as a review thread message, including empty pending agent messages. */
export const MarkdownBody = Schema.String.pipe(Schema.brand("MarkdownBody"))

/** Markdown content stored as a review thread message. */
export type MarkdownBody = typeof MarkdownBody.Type

/** Repairs provider-escaped Markdown line breaks while preserving literal escapes in inline code. */
export const normalizeMarkdownLineBreaks = (value: string): MarkdownBody => {
  const normalizedLineEndings = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
  let normalized = ""
  let plainTextStart = 0
  let index = 0

  while (index < normalizedLineEndings.length) {
    if (normalizedLineEndings[index] !== "`") {
      index += 1
      continue
    }
    const delimiterLength = backtickRunLength(normalizedLineEndings, index)
    const fencedCode = delimiterLength >= 3 && isMarkdownLineStart(normalizedLineEndings, index)
    const closingIndex = findClosingBackticks(
      normalizedLineEndings,
      index + delimiterLength,
      delimiterLength,
      fencedCode,
    )
    if (closingIndex < 0) {
      index += delimiterLength
      continue
    }

    normalized += repairEscapedLineBreaks(normalizedLineEndings.slice(plainTextStart, index))
    const closingDelimiterLength = backtickRunLength(normalizedLineEndings, closingIndex)
    const codeEnd = closingIndex + closingDelimiterLength
    const code = normalizedLineEndings.slice(index, codeEnd)
    normalized +=
      fencedCode && isMarkdownLineStart(normalizedLineEndings, closingIndex)
        ? repairFencedCodeBoundaries(code, delimiterLength, closingDelimiterLength)
        : code
    plainTextStart = codeEnd
    index = codeEnd
  }

  normalized += repairEscapedLineBreaks(normalizedLineEndings.slice(plainTextStart))
  return MarkdownBody.make(normalized)
}

const repairEscapedLineBreaks = (value: string) =>
  value.replaceAll("\\r\\n", "\n").replaceAll("\\n", "\n")

const backtickRunLength = (value: string, start: number) => {
  let end = start
  while (value[end] === "`") end += 1
  return end - start
}

const findClosingBackticks = (
  value: string,
  start: number,
  delimiterLength: number,
  fencedCode: boolean,
) => {
  let index = start
  while (index < value.length) {
    const candidate = value.indexOf("`", index)
    if (candidate < 0) return -1
    const candidateLength = backtickRunLength(value, candidate)
    if (
      fencedCode
        ? candidateLength >= delimiterLength && isMarkdownLineStart(value, candidate)
        : candidateLength === delimiterLength
    )
      return candidate
    index = candidate + candidateLength
  }
  return -1
}

const repairFencedCodeBoundaries = (
  value: string,
  openingDelimiterLength: number,
  closingDelimiterLength: number,
) => {
  const closingIndex = value.length - closingDelimiterLength
  const openingBreak = escapedLineBreakAtOrAfter(value, openingDelimiterLength)
  const openingActualBreak = value.indexOf("\n", openingDelimiterLength)
  if (openingActualBreak >= 0 && (openingBreak === null || openingActualBreak < openingBreak.start))
    return value
  const closingBreak = escapedLineBreakBefore(value, closingIndex)
  const boundaries = [openingBreak, closingBreak]
    .filter((boundary): boundary is EscapedLineBreak => boundary !== null)
    .filter(
      (boundary, index, all) => all.findIndex(({ start }) => start === boundary.start) === index,
    )
  const firstBoundary = boundaries[0]
  const secondBoundary = boundaries[1]
  const orderedBoundaries =
    firstBoundary !== undefined &&
    secondBoundary !== undefined &&
    firstBoundary.start < secondBoundary.start
      ? [secondBoundary, firstBoundary]
      : boundaries

  return orderedBoundaries.reduce(
    (result, boundary) =>
      `${result.slice(0, boundary.start)}\n${result.slice(boundary.start + boundary.length)}`,
    value,
  )
}

const isMarkdownLineStart = (value: string, index: number) =>
  index === 0 ||
  value[index - 1] === "\n" ||
  value.slice(Math.max(0, index - 4), index).endsWith("\\r\\n") ||
  value.slice(Math.max(0, index - 2), index).endsWith("\\n")

interface EscapedLineBreak {
  readonly start: number
  readonly length: number
}

const escapedLineBreakAtOrAfter = (value: string, start: number): EscapedLineBreak | null => {
  const windows = value.indexOf("\\r\\n", start)
  const unix = value.indexOf("\\n", start)
  if (windows < 0 && unix < 0) return null
  if (windows >= 0 && (unix < 0 || windows <= unix)) return { start: windows, length: 4 }
  return { start: unix, length: 2 }
}

const escapedLineBreakBefore = (value: string, end: number): EscapedLineBreak | null => {
  const windows = value.lastIndexOf("\\r\\n", end)
  const unix = value.lastIndexOf("\\n", end)
  if (windows < 0 && unix < 0) return null
  if (windows >= 0 && (windows >= unix || unix === windows + 2))
    return { start: windows, length: 4 }
  return { start: unix, length: 2 }
}

/** Current relationship between an original anchor and the latest review revision. */
export const ReviewAnchorStatus = Schema.Literal("active", "outdated", "unresolved_anchor")

/** Current relationship between an original anchor and the latest review revision. */
export type ReviewAnchorStatus = typeof ReviewAnchorStatus.Type

/** Author type for a persisted local thread message. */
export const ReviewThreadMessageAuthor = Schema.Literal("user", "agent")

/** Author type for a persisted local thread message. */
export type ReviewThreadMessageAuthor = typeof ReviewThreadMessageAuthor.Type

/** Lifecycle status for a persisted local thread message. */
export const ReviewThreadMessageStatus = Schema.Literal("pending", "complete", "failed")

/** Lifecycle status for a persisted local thread message. */
export type ReviewThreadMessageStatus = typeof ReviewThreadMessageStatus.Type

/** Anchor applying to the complete review rather than one changed file. */
export class ReviewLevelAnchor extends Schema.TaggedClass<ReviewLevelAnchor>()("review", {}) {}

/** Anchor applying to one changed file. */
export class FileReviewAnchor extends Schema.TaggedClass<FileReviewAnchor>()("file", {
  fileId: ReviewFileId,
  filePath: Schema.String,
  oldPath: Schema.NullOr(Schema.String),
}) {}

/** Anchor applying to one parsed diff hunk. */
export class HunkReviewAnchor extends Schema.TaggedClass<HunkReviewAnchor>()("hunk", {
  fileId: ReviewFileId,
  filePath: Schema.String,
  oldPath: Schema.NullOr(Schema.String),
  hunkId: ReviewHunkId,
  hunkFingerprint: ReviewHunkFingerprint,
  header: Schema.String,
  oldStart: Schema.Number,
  oldLines: Schema.Number,
  newStart: Schema.Number,
  newLines: Schema.Number,
}) {}

/** Side of a split diff containing an anchored line. */
export const ReviewLineSide = Schema.Literal("old", "new")

/** Side of a split diff containing an anchored line. */
export type ReviewLineSide = typeof ReviewLineSide.Type

/** Anchor applying to one old-side or new-side diff line. */
export class LineReviewAnchor extends Schema.TaggedClass<LineReviewAnchor>()("line", {
  fileId: ReviewFileId,
  filePath: Schema.String,
  oldPath: Schema.NullOr(Schema.String),
  hunkId: ReviewHunkId,
  hunkFingerprint: ReviewHunkFingerprint,
  hunkHeader: Schema.String,
  side: ReviewLineSide,
  lineNumber: Schema.Number,
  lineContent: Schema.String,
}) {}

/** Any diff location that an agent may reference in a response. */
export const ReviewAnchor = Schema.Union(
  ReviewLevelAnchor,
  FileReviewAnchor,
  HunkReviewAnchor,
  LineReviewAnchor,
)

/** Any diff location that an agent may reference in a response. */
export type ReviewAnchor = typeof ReviewAnchor.Type

/** The exact line scope required by every persisted local review thread. */
export const ReviewThreadAnchor = LineReviewAnchor

/** The exact line scope required by every persisted local review thread. */
export type ReviewThreadAnchor = typeof ReviewThreadAnchor.Type

/** A local DiffDash-only review discussion. */
export class ReviewThread extends Schema.Class<ReviewThread>("ReviewThread")({
  id: ReviewThreadId,
  repoId: Schema.String,
  reviewKey: ReviewKey,
  prNumber: Schema.NullOr(Schema.Number),
  baseRevision: ReviewRevision,
  headRevision: ReviewRevision,
  currentBaseRevision: ReviewRevision,
  currentHeadRevision: ReviewRevision,
  originalAnchor: ReviewThreadAnchor,
  currentAnchor: Schema.NullOr(ReviewThreadAnchor),
  anchorStatus: ReviewAnchorStatus,
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) {}

/** One user or agent message stored in a local review thread. */
export class ReviewThreadMessage extends Schema.Class<ReviewThreadMessage>("ReviewThreadMessage")({
  id: ReviewThreadMessageId,
  threadId: ReviewThreadId,
  sequence: Schema.Number,
  author: ReviewThreadMessageAuthor,
  bodyMarkdown: MarkdownBody,
  status: ReviewThreadMessageStatus,
  agentRunId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) {}

/** A local review thread together with its deterministically ordered messages. */
export class ReviewThreadDetails extends Schema.Class<ReviewThreadDetails>("ReviewThreadDetails")({
  thread: ReviewThread,
  messages: Schema.Array(ReviewThreadMessage),
}) {}

/** Input for atomically creating a local thread and its initial user message. */
export class CreateReviewThreadInput extends Schema.Class<CreateReviewThreadInput>(
  "CreateReviewThreadInput",
)({
  repoId: Schema.String,
  reviewKey: ReviewKey,
  prNumber: Schema.NullOr(Schema.Number),
  baseRevision: ReviewRevision,
  headRevision: ReviewRevision,
  anchor: ReviewThreadAnchor,
  bodyMarkdown: MarkdownBody,
}) {}

/** Input to append a follow-up user message to an existing local line thread. */
export class AddReviewThreadUserMessageInput extends Schema.Class<AddReviewThreadUserMessageInput>(
  "AddReviewThreadUserMessageInput",
)({
  threadId: ReviewThreadId,
  bodyMarkdown: MarkdownBody,
}) {}

/** Scope for listing all carried and current threads belonging to one review. */
export class ReviewThreadListKey extends Schema.Class<ReviewThreadListKey>("ReviewThreadListKey")({
  repoId: Schema.String,
  reviewKey: ReviewKey,
}) {}

/** Strict revision scope used when callers need only threads mapped to one head. */
export class ReviewThreadRevisionKey extends Schema.Class<ReviewThreadRevisionKey>(
  "ReviewThreadRevisionKey",
)({
  repoId: Schema.String,
  reviewKey: ReviewKey,
  headRevision: ReviewRevision,
}) {}

/** Renderer-safe locator for one hosted review. */
export class HostedReviewTarget extends Schema.Class<HostedReviewTarget>("HostedReviewTarget")({
  kind: Schema.Literal("hosted"),
  review: HostedReviewLocator,
}) {}

/** Renderer-safe locator resolved into a canonical review snapshot by the main process. */
export const ReviewThreadTarget = Schema.Union(
  HostedReviewTarget,
  LocalReviewTarget,
  RepositoryComparisonTarget,
)

/** Renderer-safe locator resolved into a canonical review snapshot by the main process. */
export type ReviewThreadTarget = typeof ReviewThreadTarget.Type

/** Checks that an anchor still identifies exact content in a coherent parsed review snapshot. */
export const isReviewAnchorInParsedDiff = (anchor: ReviewThreadAnchor, diff: ParsedDiff) => {
  const file = diff.files.find(
    (candidate) =>
      candidate.fileId === anchor.fileId &&
      candidate.path === anchor.filePath &&
      candidate.oldPath === anchor.oldPath,
  )
  if (file === undefined) return false
  const hunk = file.hunks.find(
    (candidate) =>
      candidate.id === anchor.hunkId && candidate.fingerprint === anchor.hunkFingerprint,
  )
  if (hunk === undefined) return false
  return hunk.header === anchor.hunkHeader && hunkContainsLine(hunk, anchor)
}

const hunkContainsLine = (
  hunk: ParsedDiff["files"][number]["hunks"][number],
  anchor: LineReviewAnchor,
) =>
  findProjectedDiffHunkLine(projectDiffHunkLines(hunk), {
    side: anchor.side,
    lineNumber: anchor.lineNumber,
    content: anchor.lineContent,
  }) !== null
