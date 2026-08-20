import type { CodeWorkspaceEntry } from "@diffdash/domain/code-workspace"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { Match } from "effect"
import { ChevronRight, File, Folder } from "lucide-react"

import { cn } from "@/shared/utils"

type VisibleEntry = {
  readonly _tag: "entry"
  readonly depth: number
  readonly entry: CodeWorkspaceEntry
}

type VisibleLoadMore = {
  readonly _tag: "loadMore"
  readonly depth: number
  readonly path: RepositoryRelativePath | null
}

/** Lazy filesystem tree backed by bounded immediate-directory pages from Core. */
export const CodeWorkspaceTree = ({
  entries,
  expandedPaths,
  loadingPaths,
  nextOffsets,
  selectedPath,
  onOpenFile,
  onLoadMore,
  onToggleDirectory,
}: {
  readonly entries: ReadonlyMap<string, readonly CodeWorkspaceEntry[]>
  readonly expandedPaths: ReadonlySet<RepositoryRelativePath>
  readonly loadingPaths: ReadonlySet<string>
  readonly nextOffsets: ReadonlyMap<string, number | null>
  readonly selectedPath: RepositoryRelativePath | null
  readonly onOpenFile: (path: RepositoryRelativePath) => void
  readonly onLoadMore: (path: RepositoryRelativePath | null) => void
  readonly onToggleDirectory: (path: RepositoryRelativePath) => void
}) => {
  const visible = flattenEntries(entries, expandedPaths, nextOffsets)
  const renderVisible = (visibleEntry: VisibleEntry | VisibleLoadMore) =>
    Match.valueTags(visibleEntry, {
      loadMore: (visibleEntry: VisibleLoadMore) => {
        const key = visibleEntry.path ?? ""
        return (
          <button
            key={`load:${key}`}
            type="button"
            className="text-muted-foreground hover:text-foreground h-7 w-full text-left text-xs"
            style={{ paddingLeft: `${22 + visibleEntry.depth * 14}px` }}
            onClick={() => onLoadMore(visibleEntry.path)}
          >
            {loadingPaths.has(key) ? "Loading..." : "Load more..."}
          </button>
        )
      },
      entry: (visibleEntry: VisibleEntry) => {
        const { depth, entry } = visibleEntry
        const expanded = entry.kind === "directory" && expandedPaths.has(entry.path)
        const loading = loadingPaths.has(entry.path)
        const label = basename(entry.path)
        return (
          <button
            key={entry.path}
            type="button"
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={entry.kind === "directory" ? expanded : undefined}
            aria-selected={entry.kind === "file" && selectedPath === entry.path}
            data-item-path={entry.path}
            className={cn(
              "hover:bg-review-sidebar-control-hover flex h-7 w-full items-center gap-1.5 pr-2 text-left text-xs",
              entry.kind === "file" &&
                selectedPath === entry.path &&
                "bg-review-tree-selected text-review-sidebar-fg",
            )}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            onClick={() =>
              entry.kind === "directory" ? onToggleDirectory(entry.path) : onOpenFile(entry.path)
            }
          >
            {entry.kind === "directory" ? (
              <ChevronRight
                aria-hidden="true"
                className={cn(
                  "size-3 shrink-0 transition-transform",
                  expanded && "rotate-90",
                  loading && "animate-pulse",
                )}
              />
            ) : (
              <span aria-hidden="true" className="size-3 shrink-0" />
            )}
            {entry.kind === "directory" ? (
              <Folder aria-hidden="true" className="text-muted-foreground size-3.5 shrink-0" />
            ) : (
              <File aria-hidden="true" className="text-muted-foreground size-3.5 shrink-0" />
            )}
            <span className="truncate">{label}</span>
          </button>
        )
      },
    })
  return (
    <div role="tree" aria-label="Repository files" className="h-full overflow-auto py-1">
      {visible.map(renderVisible)}
    </div>
  )
}

const flattenEntries = (
  entries: ReadonlyMap<string, readonly CodeWorkspaceEntry[]>,
  expandedPaths: ReadonlySet<RepositoryRelativePath>,
  nextOffsets: ReadonlyMap<string, number | null>,
): readonly (VisibleEntry | VisibleLoadMore)[] => {
  const visible: Array<VisibleEntry | VisibleLoadMore> = []
  const visit = (directory: string, depth: number) => {
    for (const entry of entries.get(directory) ?? []) {
      visible.push({ _tag: "entry", depth, entry })
      if (entry.kind === "directory" && expandedPaths.has(entry.path)) visit(entry.path, depth + 1)
    }
    if ((nextOffsets.get(directory) ?? null) !== null) {
      visible.push({
        _tag: "loadMore",
        depth,
        path: directory === "" ? null : RepositoryRelativePath.make(directory),
      })
    }
  }
  visit("", 0)
  return visible
}

const basename = (path: RepositoryRelativePath): string => path.split("/").at(-1) ?? path
