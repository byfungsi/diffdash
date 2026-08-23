import type { CodeWorkspaceEntry } from "@diffdash/domain/code-workspace"
import type { DiffFileStatus } from "@diffdash/domain/diff"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { createFileTreeIconResolver, getBuiltInSpriteSheet } from "@pierre/trees"
import { HashMap, HashSet, Match, Option } from "effect"
import { ChevronRight, Folder } from "lucide-react"
import type { ReactNode } from "react"

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
  readonly entries: Iterable<readonly [string, readonly CodeWorkspaceEntry[]]>
  readonly expandedPaths: Iterable<RepositoryRelativePath>
  readonly fileStatuses: HashMap.HashMap<RepositoryRelativePath, DiffFileStatus>
  readonly loadingPaths: Iterable<string>
  readonly nextOffsets: Iterable<readonly [string, number | null]>
  readonly selectedPath: RepositoryRelativePath | null
  readonly onOpenFile: (path: RepositoryRelativePath) => void
  readonly onLoadMore: (path: RepositoryRelativePath | null) => void
  readonly onToggleDirectory: (path: RepositoryRelativePath) => void
}) => {
  const entriesByDirectory = HashMap.fromIterable(entries)
  const expandedPathSet = HashSet.fromIterable(expandedPaths)
  const loadingPathSet = HashSet.fromIterable(loadingPaths)
  const offsetMap = HashMap.fromIterable(nextOffsets)
  const visibleItems = flattenEntries(entriesByDirectory, expandedPathSet, offsetMap)
  const directoryStatuses = collectDirectoryStatuses(fileStatuses)
  const renderVisible = (item: VisibleEntry | VisibleLoadMore) =>
    Match.valueTags(item, {
      loadMore: (loadMore: VisibleLoadMore) => {
        const key = loadMore.path ?? ""
        const loading = HashSet.has(loadingPathSet, key)
        return (
          <button
            key={`load:${key}`}
            type="button"
            aria-busy={loading}
            className="text-muted-foreground hover:text-foreground h-7 w-full text-left text-xs"
            disabled={loading}
            style={{ paddingLeft: `${22 + loadMore.depth * 14}px` }}
            onClick={() => {
              if (!loading) onLoadMore(loadMore.path)
            }}
          >
            {loading ? "Loading..." : "Load more..."}
          </button>
        )
      },
      entry: (visibleEntry: VisibleEntry) => {
        const { depth, entry } = visibleEntry
        const expanded = entry.kind === "directory" && HashSet.has(expandedPathSet, entry.path)
        const loading = HashSet.has(loadingPathSet, entry.path)
        const label = basename(entry.path)
        const statusByEntryKind = {
          directory: () => HashMap.get(directoryStatuses, entry.path),
          file: () => HashMap.get(fileStatuses, entry.path),
        } satisfies Readonly<
          Record<CodeWorkspaceEntry["kind"], () => Option.Option<DiffFileStatus>>
        >
        const status = statusByEntryKind[entry.kind]()
        return (
          <button
            key={entry.path}
            type="button"
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={entry.kind === "directory" ? expanded : undefined}
            aria-selected={entry.kind === "file" && selectedPath === entry.path}
            data-item-path={entry.path}
            data-item-status={Option.getOrUndefined(status)}
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
            <span className={cn("min-w-0 flex-1 truncate", statusTextColor(status))}>{label}</span>
            {statusMarker(entry.kind, status)}
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
        {visibleItems.map(renderVisible)}
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

const statusTextColor = (status: Option.Option<DiffFileStatus>): string | undefined =>
  Option.getOrUndefined(Option.flatMap(status, (fileStatus) => STATUS_TEXT_COLORS[fileStatus]))

const statusMarker = (kind: CodeWorkspaceEntry["kind"], status: Option.Option<DiffFileStatus>) => {
  const markers = {
    directory: () => null,
    file: () =>
      Option.match(status, {
        onNone: () => null,
        onSome: (fileStatus) => STATUS_MARKERS[fileStatus](),
      }),
  } satisfies Readonly<Record<CodeWorkspaceEntry["kind"], () => ReactNode>>
  return markers[kind]()
}

const STATUS_TEXT_COLORS = {
  added: Option.some("text-review-success-text"),
  binary: Option.some("text-review-modified-text"),
  deleted: Option.none(),
  modified: Option.some("text-review-modified-text"),
  renamed: Option.some("text-review-modified-text"),
} satisfies Readonly<Record<DiffFileStatus, Option.Option<string>>>

const STATUS_MARKERS = {
  added: () => (
    <span aria-label="Added" className="text-review-success-text shrink-0 font-medium">
      A
    </span>
  ),
  binary: modifiedStatusMarker,
  deleted: () => null,
  modified: modifiedStatusMarker,
  renamed: modifiedStatusMarker,
} satisfies Readonly<Record<DiffFileStatus, () => ReactNode>>

const DIRECTORY_STATUS_CONTRIBUTIONS = {
  added: Option.some<DiffFileStatus>("added"),
  binary: Option.some<DiffFileStatus>("modified"),
  deleted: Option.none<DiffFileStatus>(),
  modified: Option.some<DiffFileStatus>("modified"),
  renamed: Option.some<DiffFileStatus>("modified"),
} satisfies Readonly<Record<DiffFileStatus, Option.Option<DiffFileStatus>>>

const MERGE_DIRECTORY_STATUS = {
  added: (_current: DiffFileStatus, contribution: DiffFileStatus) => contribution,
  binary: (current: DiffFileStatus) => current,
  deleted: (current: DiffFileStatus) => current,
  modified: (current: DiffFileStatus) => current,
  renamed: (current: DiffFileStatus) => current,
} satisfies Readonly<
  Record<DiffFileStatus, (current: DiffFileStatus, contribution: DiffFileStatus) => DiffFileStatus>
>

function modifiedStatusMarker(): ReactNode {
  return (
    <span aria-label="Modified" className="text-review-modified-text shrink-0 font-medium">
      M
    </span>
  )
}

const collectDirectoryStatuses = (
  fileStatuses: HashMap.HashMap<RepositoryRelativePath, DiffFileStatus>,
): HashMap.HashMap<RepositoryRelativePath, DiffFileStatus> => {
  let directoryStatuses = HashMap.empty<RepositoryRelativePath, DiffFileStatus>()
  for (const [path, status] of fileStatuses) {
    Option.match(DIRECTORY_STATUS_CONTRIBUTIONS[status], {
      onNone: () => undefined,
      onSome: (contribution) => {
        let separatorIndex = path.indexOf("/")
        while (separatorIndex >= 0) {
          const directoryPath = RepositoryRelativePath.make(path.slice(0, separatorIndex))
          directoryStatuses = HashMap.modifyAt(directoryStatuses, directoryPath, (current) =>
            Option.some(
              Option.match(current, {
                onNone: () => contribution,
                onSome: (directoryStatus) =>
                  MERGE_DIRECTORY_STATUS[directoryStatus](directoryStatus, contribution),
              }),
            ),
          )
          separatorIndex = path.indexOf("/", separatorIndex + 1)
        }
      },
    })
  }
  return directoryStatuses
}

const flattenEntries = (
  entries: HashMap.HashMap<string, readonly CodeWorkspaceEntry[]>,
  expandedPaths: HashSet.HashSet<RepositoryRelativePath>,
  nextOffsets: HashMap.HashMap<string, number | null>,
): readonly (VisibleEntry | VisibleLoadMore)[] => {
  const visible: Array<VisibleEntry | VisibleLoadMore> = []
  const visit = (directory: string, depth: number) => {
    for (const entry of Option.getOrElse(HashMap.get(entries, directory), () => [])) {
      visible.push({ _tag: "entry", depth, entry })
      if (entry.kind === "directory" && HashSet.has(expandedPaths, entry.path)) {
        visit(entry.path, depth + 1)
      }
    }
    if (Option.exists(HashMap.get(nextOffsets, directory), (offset) => offset !== null)) {
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
