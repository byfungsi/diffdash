import type { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { Data, Option } from "effect"
import { useEffect, useMemo, useRef } from "react"

import { PierreFileTree, prepareFileTreeInput, useFileTree } from "@/review/pierre"

const REPOSITORY_FILE_TREE_CSS = `
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
    --trees-icon-orange: var(--theme-peach);
    --trees-icon-yellow: var(--review-modified-text);
    --trees-icon-green: var(--review-success-text);
    --trees-icon-teal: var(--review-renamed-text);
    --trees-icon-blue: var(--theme-sapphire);
    --trees-icon-purple: var(--theme-mauve);
    --trees-icon-pink: var(--theme-pink);
  }
  [data-file-tree-id], [data-type="root"], [data-type="tree"], [data-type="viewport"],
  [data-type="scroll-container"], [data-type="sticky-overlay"] { background: transparent !important; }
  [data-type="item"] { background: transparent; }
  [data-type="item"]:hover { background: var(--review-sidebar-control-hover); }
  [data-type="item"][data-item-selected] {
    background: var(--review-tree-selected) !important;
    box-shadow: none !important;
    outline: 1px solid var(--review-tree-selected-border);
    outline-offset: -1px;
  }
`

type TreeSelection = Data.TaggedEnum<{
  readonly next: { readonly path: RepositoryRelativePath }
  readonly stable: {}
  readonly restore: {}
}>
const TreeSelection = Data.taggedEnum<TreeSelection>()

/** Repository file tree synchronized with the file rendered by the Code ribbon. */
export const RepositoryFileTree = ({
  paths,
  selectedPath,
  onSelectPath,
}: {
  readonly paths: readonly RepositoryRelativePath[]
  readonly selectedPath: Option.Option<RepositoryRelativePath>
  readonly onSelectPath: (path: RepositoryRelativePath) => void
}) => {
  const availablePaths = useMemo(() => new Set<RepositoryRelativePath>(paths), [paths])
  const availablePathsRef = useRef<ReadonlySet<RepositoryRelativePath>>(availablePaths)
  const selectedPathRef = useRef(selectedPath)
  const onSelectPathRef = useRef(onSelectPath)
  const modelRef = useRef<Option.Option<ReturnType<typeof useFileTree>["model"]>>(Option.none())
  const preparedInput = useMemo(() => prepareFileTreeInput(paths), [paths])
  const appliedPreparedInputRef = useRef(preparedInput)

  availablePathsRef.current = availablePaths
  selectedPathRef.current = selectedPath
  onSelectPathRef.current = onSelectPath

  const { model } = useFileTree({
    preparedInput,
    initialExpansion: 3,
    initialSelectedPaths: Option.match(selectedPath, {
      onNone: () => [],
      onSome: (path) => [path],
    }),
    icons: { set: "complete", colored: true },
    itemHeight: 26,
    onSelectionChange: (selectedPaths) => {
      const selectedFile = Option.fromNullishOr(
        [...availablePathsRef.current].find((candidate) => selectedPaths.includes(candidate)),
      )
      const nextPath = Option.fromNullishOr(
        [...availablePathsRef.current].find(
          (candidate) =>
            !Option.contains(selectedPathRef.current, candidate) &&
            selectedPaths.includes(candidate),
        ),
      )
      const selection = Option.match(nextPath, {
        onSome: (path) => TreeSelection.next({ path }),
        onNone: () =>
          Option.match(selectedFile, {
            onNone: TreeSelection.restore,
            onSome: (path) =>
              Option.contains(selectedPathRef.current, path) && selectedPaths.length === 1
                ? TreeSelection.stable()
                : TreeSelection.restore(),
          }),
      })
      TreeSelection.$match(selection, {
        next: ({ path }) => onSelectPathRef.current(path),
        stable: () => {},
        restore: () =>
          Option.match(modelRef.current, {
            onNone: () => {},
            onSome: (currentModel) => {
              for (const path of currentModel.getSelectedPaths()) {
                currentModel.getItem(path)?.deselect()
              }
              Option.match(selectedPathRef.current, {
                onNone: () => {},
                onSome: (path) => currentModel.getItem(path)?.select(),
              })
            },
          }),
      })
    },
    search: false,
    stickyFolders: false,
    unsafeCSS: REPOSITORY_FILE_TREE_CSS,
  })
  modelRef.current = Option.some(model)

  useEffect(() => {
    if (appliedPreparedInputRef.current !== preparedInput) {
      model.resetPaths({ preparedInput })
      appliedPreparedInputRef.current = preparedInput
    }
  }, [model, preparedInput])

  useEffect(() => {
    const nextPath = Option.filter(selectedPath, (path) => availablePathsRef.current.has(path))
    for (const path of model.getSelectedPaths()) {
      if (!Option.contains(nextPath, path)) model.getItem(path)?.deselect()
    }
    Option.match(nextPath, {
      onNone: () => {},
      onSome: (path) => {
        if (!model.getSelectedPaths().includes(path)) model.getItem(path)?.select()
        model.scrollToPath(path, { focus: false, offset: "nearest" })
      },
    })
  }, [model, preparedInput, selectedPath])

  return (
    <div className="h-full overflow-hidden bg-transparent">
      <PierreFileTree
        aria-label="Repository files"
        className="text-review-sidebar-fg block h-full bg-transparent text-xs [&_*]:border-review-tree-indent"
        model={model}
        style={{ background: "transparent" }}
      />
    </div>
  )
}
