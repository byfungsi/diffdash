import { registerDiffDashSyntax } from "./diffdash-syntax"
import {
  type File as PierreFile,
  FileDiff as PierreRangeFileDiff,
  type FileDiff as PierreFileDiff,
  VirtualizedFileDiff,
} from "@pierre/diffs"
import { Predicate } from "effect"

registerDiffDashSyntax()

export {
  type CodeViewDiffItem,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type FileDiffLoadedFiles,
  type FileDiffOptions,
  type LineAnnotation,
  getSingularPatch,
  type PostRenderPhase,
  type RenderRange,
  type SelectionSide,
  type TokenEventBase,
  type VirtualizedFile,
  Virtualizer as DiffVirtualizer,
  type VirtualFileMetrics,
} from "@pierre/diffs"
export { VirtualizedFileDiff }
export { PierreRangeFileDiff }
export type { PierreFile, PierreFileDiff }
export {
  CodeView,
  type CodeViewFileItem,
  type CodeViewHandle,
  type CodeViewReactOptions,
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
