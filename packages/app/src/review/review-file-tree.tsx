import type { ReviewSnapshotFileInventory } from "@diffdash/domain/review-context"
import { useEffect, useRef } from "react"
import { buildReviewFileTreeInput } from "./file-tree-adapter"
import { PierreFileTree, prepareFileTreeInput, useFileTree } from "./pierre"

const REVIEW_FILE_TREE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-input-bg-override: transparent;
    --trees-border-color-override: var(--review-tree-indent);
    --trees-fg-override: var(--review-sidebar-fg);
    --trees-fg-muted-override: var(--review-sidebar-muted);
    --trees-selected-bg-override: var(--review-tree-selected);
  }
  [data-file-tree-id], [data-type="root"], [data-type="tree"], [data-type="viewport"],
  [data-type="scroll-container"], [data-type="sticky-overlay"] { background: transparent !important; }
  [data-type="item"] {
    background: transparent;
  }
  [data-type="item"]:hover { background: var(--review-sidebar-control-hover); }
  [data-type="item"][data-item-selected] {
    background: var(--review-tree-selected) !important;
    box-shadow: none !important;
    outline: 1px solid var(--review-tree-selected-border);
    outline-offset: -1px;
  }
`

/** Pierre file tree synchronized with the active diff path. */
export const ReviewFileTree = ({
  files,
  selectedPath,
  onSelectPath,
}: {
  readonly files: readonly ReviewSnapshotFileInventory[]
  readonly selectedPath: string | null
  readonly onSelectPath: (path: string) => void
}) => {
  const appliedSelectedPathRef = useRef<string | null>(null)
  const applyingSelectionRef = useRef(false)
  const selectionReleaseFrameRef = useRef<number | null>(null)
  const availablePathsRef = useRef<ReadonlySet<string>>(new Set())
  const onSelectPathRef = useRef(onSelectPath)
  const treeInput = buildReviewFileTreeInput(files, true)
  availablePathsRef.current = new Set(treeInput.paths)
  onSelectPathRef.current = onSelectPath
  const preparedInput = prepareFileTreeInput(treeInput.paths)
  const treeInputKey = `${treeInput.paths.join("\u0000")}\u0001${treeInput.gitStatus
    .map((entry) => `${entry.path}\u0000${entry.status}`)
    .join("\u0000")}`
  const appliedTreeInputKeyRef = useRef(treeInputKey)
  const { model } = useFileTree({
    preparedInput,
    gitStatus: treeInput.gitStatus,
    initialExpansion: 20,
    initialSelectedPaths: selectedPath === null ? [] : [selectedPath],
    itemHeight: 26,
    onSelectionChange: (paths) => {
      if (applyingSelectionRef.current) return
      const path =
        paths.find((candidate) => candidate !== appliedSelectedPathRef.current) ?? paths.at(-1)
      if (path !== undefined && availablePathsRef.current.has(path)) onSelectPathRef.current(path)
    },
    search: false,
    stickyFolders: false,
    unsafeCSS: REVIEW_FILE_TREE_CSS,
  })

  useEffect(() => {
    if (appliedTreeInputKeyRef.current === treeInputKey) return
    model.resetPaths({ preparedInput })
    model.setGitStatus(treeInput.gitStatus)
    appliedTreeInputKeyRef.current = treeInputKey
  }, [model, preparedInput, treeInput.gitStatus, treeInputKey])

  useEffect(() => {
    const nextSelectedPath =
      selectedPath !== null && availablePathsRef.current.has(selectedPath) ? selectedPath : null
    applyingSelectionRef.current = true
    for (const path of model.getSelectedPaths()) {
      if (path !== nextSelectedPath) model.getItem(path)?.deselect()
    }
    if (nextSelectedPath !== null && !model.getSelectedPaths().includes(nextSelectedPath)) {
      model.getItem(nextSelectedPath)?.select()
    }
    appliedSelectedPathRef.current = nextSelectedPath
    if (nextSelectedPath !== null) {
      model.scrollToPath(nextSelectedPath, { focus: false, offset: "nearest" })
    }
    if (selectionReleaseFrameRef.current !== null) {
      window.cancelAnimationFrame(selectionReleaseFrameRef.current)
    }
    selectionReleaseFrameRef.current = window.requestAnimationFrame(() => {
      selectionReleaseFrameRef.current = null
      applyingSelectionRef.current = false
    })
  }, [model, selectedPath, treeInputKey])

  useEffect(
    () => () => {
      if (selectionReleaseFrameRef.current !== null) {
        window.cancelAnimationFrame(selectionReleaseFrameRef.current)
      }
    },
    [],
  )

  return (
    <div
      className="h-full overflow-hidden bg-transparent"
      data-selected-review-path={selectedPath ?? undefined}
    >
      <PierreFileTree
        aria-label="Changed files"
        className="text-review-sidebar-fg block h-full bg-transparent text-xs [&_*]:border-review-tree-indent"
        model={model}
        style={{ background: "transparent" }}
      />
    </div>
  )
}
