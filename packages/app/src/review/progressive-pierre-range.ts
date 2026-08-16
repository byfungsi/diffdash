import type {
  ProgressiveReviewApi,
  ReviewSessionRangeRequest,
} from "@diffdash/protocol/review-session"

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
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const content = range.blocks.map((block) => decoder.decode(block.bytes)).join("")
  const path = range.file.path
  const patch = content.startsWith("diff --git ")
    ? content
    : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${content}`
  const fileDiff = getSingularPatch(patch)
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
    resources: [],
  }
}
