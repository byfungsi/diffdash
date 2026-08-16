import type {
  ProgressiveReviewApi,
  ReviewSessionRange,
  ReviewSessionRangeRequest,
} from "@diffdash/protocol/review-session"
import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import type { ParsedDiffFile } from "@diffdash/domain/diff"

import type { PierreLoadedRange, PierreRangeIdentity } from "./pierre-loaded-range-adapter"
import { getSingularPatch } from "./pierre"

/** Loads one bounded committed range and translates it to Pierre's loaded-range contract. */
export const loadProgressivePierreRange = async <Annotation>(
  api: Pick<ProgressiveReviewApi, "readRange" | "waitForRange">,
  identity: PierreRangeIdentity,
  request: ReviewSessionRangeRequest,
  wait: boolean,
  signal: AbortSignal,
): Promise<PierreLoadedRange<Annotation>> => {
  if (signal.aborted) throw signal.reason
  const range = await (wait ? api.waitForRange(request) : api.readRange(request))
  if (signal.aborted) throw signal.reason
  return progressivePierreRange(identity, range)
}

/** Translates one already-loaded legal range without joining any other file content. */
export const progressivePierreRange = <Annotation>(
  identity: PierreRangeIdentity,
  range: ReviewSessionRange,
): PierreLoadedRange<Annotation> => {
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const content = range.blocks.map((block) => decoder.decode(block.bytes)).join("")
  const normalizedContent = content.endsWith("\n") ? content.slice(0, -1) : content
  const path = range.file.path
  const patch = normalizedContent.startsWith("diff --git ")
    ? normalizedContent
    : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${normalizedContent}`
  const fileDiff = {
    ...getSingularPatch(patch),
    cacheKey: `${identity.snapshotGeneration}:${identity.rangeKey}`,
  }
  const totalLines = identity.mode === "split" ? fileDiff.splitLineCount : fileDiff.unifiedLineCount
  return {
    identity,
    fileDiff,
    renderRange: {
      startingLine: 0,
      totalLines,
      bufferBefore: 0,
      bufferAfter: 0,
    },
    annotations: [],
    resources: [{ kind: "text", bytes: range.byteCount, release: () => undefined }],
  }
}

/** Parses only the legal bounded range currently owned by a Pierre shell. */
export const parseProgressiveRangeFile = (range: ReviewSessionRange): ParsedDiffFile => {
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const content = range.blocks.map((block) => decoder.decode(block.bytes)).join("")
  const normalizedContent = content.endsWith("\n") ? content.slice(0, -1) : content
  const path = range.file.path
  const patch = normalizedContent.startsWith("diff --git ")
    ? normalizedContent
    : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${normalizedContent}`
  const file = parseUnifiedDiff(patch).files[0]
  if (file === undefined) throw new Error(`Bounded range for ${path} did not contain a diff file`)
  return file
}
