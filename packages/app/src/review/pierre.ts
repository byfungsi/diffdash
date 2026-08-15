import { registerDiffDashSyntax } from "./diffdash-syntax"
import {
  FileDiff as PierreRangeFileDiff,
  type FileDiff as PierreFileDiff,
  VirtualizedFileDiff,
} from "@pierre/diffs"
import { Predicate } from "effect"

registerDiffDashSyntax()

export {
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type FileDiffOptions,
  getSingularPatch,
  type PostRenderPhase,
  type SelectionSide,
  Virtualizer as DiffVirtualizer,
  type VirtualFileMetrics,
} from "@pierre/diffs"
export { VirtualizedFileDiff }
export { PierreRangeFileDiff }
export {
  FileDiff,
  PatchDiff,
  type WorkerInitializationRenderOptions,
  WorkerPoolContextProvider,
  type WorkerPoolOptions,
  useWorkerPool,
  VirtualizerContext,
  useStableCallback,
} from "@pierre/diffs/react"
export { prepareFileTreeInput } from "@pierre/trees"
export { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react"

/** Narrows a Pierre callback value to a virtualized diff by its stable public methods. */
export const isVirtualizedFileDiff = <Annotation = undefined>(
  value: PierreFileDiff<Annotation>,
): value is VirtualizedFileDiff<Annotation> =>
  Predicate.isObject(value) &&
  "getLinePosition" in value &&
  Predicate.isFunction(value.getLinePosition) &&
  "getVirtualizedHeight" in value &&
  Predicate.isFunction(value.getVirtualizedHeight)

// Vite's worker query exposes the module as a worker-constructor default export.
// oxlint-disable-next-line import/default
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker"

/** Creates a syntax-highlighting worker for Pierre diff rendering. */
export const createDiffsWorker = () => new DiffsWorker()
