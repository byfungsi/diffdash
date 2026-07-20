export {
  type DiffLineAnnotation,
  type FileDiffOptions,
  type PostRenderPhase,
  type SelectionSide,
  Virtualizer as DiffVirtualizer,
  VirtualizedFileDiff,
  type VirtualFileMetrics,
} from "@pierre/diffs"
export {
  PatchDiff,
  type WorkerInitializationRenderOptions,
  WorkerPoolContextProvider,
  type WorkerPoolOptions,
  VirtualizerContext,
  useStableCallback,
} from "@pierre/diffs/react"
export { prepareFileTreeInput } from "@pierre/trees"
export { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react"

// Vite's worker query exposes the module as a worker-constructor default export.
// oxlint-disable-next-line import/default
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker"

/** Creates a syntax-highlighting worker for Pierre diff rendering. */
export const createDiffsWorker = () => new DiffsWorker()
