import type { ReviewSnapshotFileInventory } from "@diffdash/domain/review-context"
import { Predicate } from "effect"
import { useEffect, useRef } from "react"
import { buildReviewFileTreeInput } from "./file-tree-adapter"
import { PierreFileTree, prepareFileTreeInput, useFileTree } from "./pierre"

const REVIEW_FILE_TREE_CSS = `
  :host {
    --trees-accent-override: var(--accent-foreground);
    --trees-bg-override: var(--review-sidebar);
    --trees-bg-muted-override: var(--review-sidebar-control-hover);
    --trees-input-bg-override: transparent;
    --trees-border-color-override: var(--review-tree-indent);
    --trees-fg-override: var(--review-sidebar-fg);
    --trees-fg-muted-override: var(--review-sidebar-muted);
    --trees-focus-ring-color-override: var(--review-tree-selected-border);
    --trees-selected-bg-override: var(--review-tree-selected);
    --trees-selected-focused-border-color-override: var(--review-tree-selected-border);
    --trees-icon-gray: var(--review-sidebar-muted);
    --trees-icon-red: var(--review-danger-text);
    --trees-icon-vermilion: var(--theme-flamingo);
    --trees-icon-orange: var(--theme-peach);
    --trees-icon-yellow: var(--review-modified-text);
    --trees-icon-green: var(--review-success-text);
    --trees-icon-teal: var(--review-renamed-text);
    --trees-icon-cyan: var(--theme-sky);
    --trees-icon-blue: var(--theme-sapphire);
    --trees-icon-indigo: var(--theme-blue);
    --trees-icon-purple: var(--theme-mauve);
    --trees-icon-pink: var(--theme-pink);
    --trees-icon-mauve: var(--theme-rosewater);
    --trees-status-added-override: var(--review-success-text);
    --trees-status-untracked-override: var(--review-success-text);
    --trees-status-modified-override: var(--review-modified-text);
    --trees-status-renamed-override: var(--review-renamed-text);
    --trees-status-deleted-override: var(--review-danger-text);
    --trees-status-ignored-override: var(--review-sidebar-muted);
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
  [data-item-git-status] > [data-item-section="content"] {
    color: var(--review-sidebar-fg) !important;
  }
  [data-item-git-status="added"] { --diffdash-tree-status-text: var(--review-success-text); }
  [data-item-git-status="deleted"] { --diffdash-tree-status-text: var(--review-danger-text); }
  [data-item-git-status="modified"] { --diffdash-tree-status-text: var(--review-modified-text); }
  [data-item-git-status="renamed"] { --diffdash-tree-status-text: var(--review-renamed-text); }
  [data-item-git-status] > [data-item-section="content"]:not(:has([data-item-flattened-subitems])),
  [data-item-git-status] > [data-item-section="content"]
    > [data-item-flattened-subitems]
    > [data-item-flattened-subitem]:last-child {
    color: var(--diffdash-tree-status-text) !important;
  }
  [data-item-type="file"]:is(
      [data-item-path*=".test." i],
      [data-item-path*=".spec." i],
      [data-item-path^="test/" i],
      [data-item-path*="/test/" i],
      [data-item-path^="tests/" i],
      [data-item-path*="/tests/" i],
      [data-item-path^="spec/" i],
      [data-item-path*="/spec/" i],
      [data-item-path^="specs/" i],
      [data-item-path*="/specs/" i],
      [data-item-path^="__tests__/" i],
      [data-item-path*="/__tests__/" i]
    )
    > [data-item-section="icon"]
    > [data-icon-token] {
    color: var(--review-danger-text) !important;
  }
`

const fileTreeItemPath = (target: EventTarget): string | null => {
  if (!Predicate.hasProperty(target, "dataset") || !Predicate.isObject(target.dataset)) {
    return null
  }
  if (
    !Predicate.hasProperty(target.dataset, "itemPath") ||
    !Predicate.isString(target.dataset.itemPath)
  ) {
    return null
  }
  return target.dataset.itemPath
}

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
  const appliedSelectedPathRef = useRef<string | null>(selectedPath)
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
    icons: { set: "complete", colored: true },
    itemHeight: 26,
    onSelectionChange: (paths) => {
      if (
        paths.length > 0 &&
        paths.every((candidate) => candidate === appliedSelectedPathRef.current)
      ) {
        return
      }
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
    appliedSelectedPathRef.current = nextSelectedPath
    for (const path of model.getSelectedPaths()) {
      if (path !== nextSelectedPath) model.getItem(path)?.deselect()
    }
    if (nextSelectedPath !== null && !model.getSelectedPaths().includes(nextSelectedPath)) {
      model.getItem(nextSelectedPath)?.select()
    }
    if (nextSelectedPath !== null) {
      model.scrollToPath(nextSelectedPath, { focus: false, offset: "nearest" })
    }
  }, [model, selectedPath, treeInputKey])

  return (
    <div
      className="h-full overflow-hidden bg-transparent"
      data-selected-review-path={selectedPath ?? undefined}
    >
      <PierreFileTree
        aria-label="Changed files"
        className="text-review-sidebar-fg block h-full bg-transparent text-xs [&_*]:border-review-tree-indent"
        model={model}
        onClickCapture={(event) => {
          const activeSelectedPath = appliedSelectedPathRef.current
          if (activeSelectedPath === null) return
          const clickedPath = event.nativeEvent
            .composedPath()
            .map(fileTreeItemPath)
            .find((path) => path !== null)
          if (clickedPath === activeSelectedPath) {
            onSelectPathRef.current(activeSelectedPath)
          }
        }}
        style={{ background: "transparent" }}
      />
    </div>
  )
}
