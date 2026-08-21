import type { CodeWorkspaceEntry } from "@diffdash/domain/code-workspace"
import type { DiffFileStatus } from "@diffdash/domain/diff"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { createFileTreeIconResolver, getBuiltInSpriteSheet } from "@pierre/trees"
import { Match } from "effect"
import { ChevronRight, Folder } from "lucide-react"

import { cn } from "@/shared/utils"

const FILE_ICON_RESOLVER = createFileTreeIconResolver({ set: "complete", colored: true })
const FILE_ICON_SPRITE = getBuiltInSpriteSheet("complete")

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
  fileStatuses,
  loadingPaths,
  nextOffsets,
  selectedPath,
  onOpenFile,
  onLoadMore,
  onToggleDirectory,
}: {
  readonly entries: ReadonlyMap<string, readonly CodeWorkspaceEntry[]>
  readonly expandedPaths: ReadonlySet<RepositoryRelativePath>
  readonly fileStatuses: ReadonlyMap<RepositoryRelativePath, DiffFileStatus>
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
        const fileStatus = entry.kind === "file" ? fileStatuses.get(entry.path) : undefined
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
              <FileTypeIcon path={entry.path} />
            )}
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {fileStatus === "added" ? (
              <span aria-label="Added" className="text-review-success-text shrink-0 font-medium">
                A
              </span>
            ) : fileStatus === undefined || fileStatus === "deleted" ? null : (
              <span
                aria-label="Modified"
                className="text-review-modified-text shrink-0 font-medium"
              >
                M
              </span>
            )}
          </button>
        )
      },
    })
  return (
    <>
      <div
        aria-hidden="true"
        className="absolute size-0 overflow-hidden"
        dangerouslySetInnerHTML={{ __html: FILE_ICON_SPRITE }}
      />
      <div role="tree" aria-label="Repository files" className="h-full overflow-auto py-1">
        {visible.map(renderVisible)}
      </div>
    </>
  )
}

const FileTypeIcon = ({ path }: { readonly path: RepositoryRelativePath }) => {
  const icon = FILE_ICON_RESOLVER.resolveIcon("file-tree-icon-file", path)
  return (
    <svg
      aria-hidden="true"
      data-icon-token={icon.token}
      className={cn("size-3.5 shrink-0", fileIconColor(icon.token))}
      viewBox={icon.viewBox ?? `0 0 ${icon.width ?? 16} ${icon.height ?? 16}`}
    >
      <use href={`#${icon.name}`} />
    </svg>
  )
}

const fileIconColor = (token: string | undefined): string => {
  if (token === undefined || token === "default" || token === "text") return "text-muted-foreground"
  if (["npm", "postcss", "ruby", "svelte", "yml"].includes(token)) return "text-review-danger-text"
  if (["bash", "markdown", "svgo", "vue"].includes(token)) return "text-review-success-text"
  if (["babel", "browserslist", "javascript"].includes(token)) return "text-review-modified-text"
  if (["go", "oxc", "react", "tailwind"].includes(token)) return "text-theme-sky"
  if (["graphql", "image", "sass"].includes(token)) return "text-theme-pink"
  if (["astro", "database", "vite"].includes(token)) return "text-theme-mauve"
  if (["bootstrap", "css", "eslint", "terraform", "wasm"].includes(token)) return "text-theme-blue"
  if (["claude", "html", "json", "rust", "svg", "swift", "zig", "zip"].includes(token))
    return "text-theme-peach"
  if (["git"].includes(token)) return "text-theme-flamingo"
  if (["mcp", "prettier", "table"].includes(token)) return "text-review-renamed-text"
  return "text-theme-sapphire"
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
