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
    --truncate-marker-opacity: 0%;
    --truncate-middle-marker-opacity: 0%;
    --truncate-fade-marker-color: transparent;
  }
  [data-type="item"]:hover { background: var(--review-sidebar-control-hover); }
  [data-type="item"] [data-truncate-marker],
  [data-type="item"] [data-truncate-marker]::before,
  [data-type="item"] [data-truncate-marker]::after,
  [data-type="item"] [data-truncate-fade] {
    background: transparent !important;
    background-color: transparent !important;
    background-image: none !important;
    box-shadow: none !important;
  }
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
  const suppressSelectionChangeRef = useRef(false)
  const treeInput = buildReviewFileTreeInput(files, true)
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
      if (suppressSelectionChangeRef.current) return
      const path = paths[0]
      if (path !== undefined && treeInput.paths.includes(path)) onSelectPath(path)
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
    const previousSelectedPath = appliedSelectedPathRef.current
    if (previousSelectedPath !== null && previousSelectedPath !== selectedPath) {
      model.getItem(previousSelectedPath)?.deselect()
    }
    if (selectedPath === null || !treeInput.paths.includes(selectedPath)) {
      appliedSelectedPathRef.current = null
      return
    }
    suppressSelectionChangeRef.current = true
    model.getItem(selectedPath)?.select()
    model.scrollToPath(selectedPath, { focus: false, offset: "nearest" })
    appliedSelectedPathRef.current = selectedPath
    window.setTimeout(() => {
      suppressSelectionChangeRef.current = false
    }, 0)
  }, [model, selectedPath, treeInput.paths])

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
