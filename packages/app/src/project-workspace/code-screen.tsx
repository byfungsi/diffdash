import type { CodeThemePreferences } from "@diffdash/domain/ai-settings"
import {
  type CodeWorkspaceEntry,
  type CodeWorkspaceFileReadRejectionReason,
  type CodeWorkspaceLease,
  type CodeWorkspaceLeaseId,
  type CodeWorkspaceTarget,
  ProjectHeadCodeWorkspaceTarget,
} from "@diffdash/domain/code-workspace"
import type { ProjectWorkspaceRibbon } from "@diffdash/domain/project-workspace"
import type { Repo } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { Match, Schema } from "effect"
import { useEffect, useEffectEvent, useRef, useState } from "react"

import { runRendererPromise, useCodeWorkspace } from "@/platform/renderer-runtime"
import { formatError } from "@/shared/errors"
import { Button } from "@/shared/ui/button"
import { EmptyState } from "@/shared/ui/empty-state"
import { ProjectWorkspaceStatePanel } from "@/shared/ui/project-workspace-state-panel"
import type { ColorScheme } from "@/settings/theme"
import { CommandPaletteDialog, type CommandPaletteItem } from "@/shell/command-palette"

import { CodeFileViewer } from "./code-file-viewer"
import { CodeWorkspaceTree } from "./code-workspace-tree"
import { ProjectWorkspaceFrame } from "./project-workspace-frame"

type WorkspaceState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly lease: CodeWorkspaceLease }
  | { readonly _tag: "failure"; readonly message: string }

type FileState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading"; readonly path: RepositoryRelativePath }
  | { readonly _tag: "ready"; readonly path: RepositoryRelativePath; readonly content: string }
  | { readonly _tag: "failure"; readonly path: RepositoryRelativePath; readonly message: string }

const DIRECTORY_PAGE_SIZE = 500
const SEARCH_LIMIT = 100
const HEARTBEAT_INTERVAL_MS = 20 * 60 * 1_000

/** Managed exact-revision Code browser with lazy directory and filename loading. */
export const CodeScreen = ({
  codeThemes,
  colorScheme,
  contextWidth,
  repo,
  selectedPath,
  sidebarExpanded,
  target,
  threadDetailWidth,
  onActiveRibbonChange,
  onLinkRepository,
  onSelectedPathChange,
  onSidebarExpandedChange,
  onSidebarWidthChange,
  onThreadDetailWidthChange,
}: {
  readonly codeThemes: CodeThemePreferences
  readonly colorScheme: ColorScheme
  readonly contextWidth: number
  readonly repo: Repo
  readonly selectedPath: RepositoryRelativePath | null
  readonly sidebarExpanded: boolean
  readonly target: CodeWorkspaceTarget
  readonly threadDetailWidth: number
  readonly onActiveRibbonChange: (ribbon: ProjectWorkspaceRibbon) => void
  readonly onLinkRepository: () => void
  readonly onSelectedPathChange: (path: RepositoryRelativePath | null) => void
  readonly onSidebarExpandedChange: (expanded: boolean) => void
  readonly onSidebarWidthChange: (width: number) => void
  readonly onThreadDetailWidthChange: (width: number) => void
}) => {
  const workspaces = useCodeWorkspace()
  const [workspace, setWorkspace] = useState<WorkspaceState>({ _tag: "loading" })
  const [file, setFile] = useState<FileState>({ _tag: "idle" })
  const [directories, setDirectories] = useState<
    ReadonlyMap<string, readonly CodeWorkspaceEntry[]>
  >(new Map())
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<RepositoryRelativePath>>(new Set())
  const [loadingPaths, setLoadingPaths] = useState<ReadonlySet<string>>(new Set())
  const [directoryOffsets, setDirectoryOffsets] = useState<ReadonlyMap<string, number | null>>(
    new Map(),
  )
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteItems, setPaletteItems] = useState<readonly CommandPaletteItem[]>([])
  const [paletteLoading, setPaletteLoading] = useState(false)
  const [reloadVersion, setReloadVersion] = useState(0)
  const activeLeaseId = useRef<CodeWorkspaceLeaseId | null>(null)
  const searchSequence = useRef(0)
  const readyWorkspace = Match.valueTags(workspace, {
    loading: () => null,
    failure: () => null,
    ready: (state) => state,
  })

  const requestDirectory = async (
    lease: CodeWorkspaceLease,
    path: RepositoryRelativePath | null,
    offset = 0,
  ) => {
    const key = path ?? ""
    setLoadingPaths((current) => new Set(current).add(key))
    try {
      const page = await runRendererPromise(
        workspaces.listDirectory(lease.id, path, offset, DIRECTORY_PAGE_SIZE),
      )
      if (activeLeaseId.current !== lease.id) return
      setDirectories((current) =>
        new Map(current).set(
          key,
          offset === 0 ? page.entries : [...(current.get(key) ?? []), ...page.entries],
        ),
      )
      setDirectoryOffsets((current) => new Map(current).set(key, page.nextOffset))
    } finally {
      if (activeLeaseId.current === lease.id) {
        setLoadingPaths((current) => {
          const updated = new Set(current)
          updated.delete(key)
          return updated
        })
      }
    }
  }
  const loadDirectory = (
    lease: CodeWorkspaceLease,
    path: RepositoryRelativePath | null,
    offset = 0,
  ) =>
    requestDirectory(lease, path, offset).catch((error) => {
      if (activeLeaseId.current === lease.id) {
        setWorkspace({
          _tag: "failure",
          message: formatError(error, "DiffDash could not load repository files."),
        })
      }
    })
  const loadDirectoryFromEffect = useEffectEvent(loadDirectory)

  useEffect(() => {
    let active = true
    let lease: CodeWorkspaceLease | null = null
    setWorkspace({ _tag: "loading" })
    setDirectories(new Map())
    setExpandedPaths(new Set())
    setDirectoryOffsets(new Map())
    setFile({ _tag: "idle" })
    if (Schema.is(ProjectHeadCodeWorkspaceTarget)(target) && repo.localPath === null) {
      setWorkspace({
        _tag: "failure",
        message: "Link a checkout to browse code at the project's current HEAD.",
      })
      return
    }
    const open = async () => {
      try {
        lease = await runRendererPromise(workspaces.open(target))
        if (!active) {
          await runRendererPromise(workspaces.release(lease.id)).catch(() => undefined)
          return
        }
        activeLeaseId.current = lease.id
        setWorkspace({ _tag: "ready", lease })
        await loadDirectoryFromEffect(lease, null)
      } catch (error) {
        if (active)
          setWorkspace({
            _tag: "failure",
            message: formatError(error, "DiffDash could not prepare the Code workspace."),
          })
      }
    }
    void open()
    return () => {
      active = false
      if (lease !== null) {
        if (activeLeaseId.current === lease.id) activeLeaseId.current = null
        void runRendererPromise(workspaces.release(lease.id)).catch(() => undefined)
      }
    }
  }, [reloadVersion, repo.localPath, target, workspaces])

  useEffect(() => {
    if (readyWorkspace === null) return
    const leaseId = readyWorkspace.lease.id
    const heartbeat = window.setInterval(() => {
      void runRendererPromise(workspaces.heartbeat(leaseId)).catch((error) => {
        if (activeLeaseId.current !== leaseId) return
        activeLeaseId.current = null
        void runRendererPromise(workspaces.release(leaseId)).catch(() => undefined)
        setWorkspace({
          _tag: "failure",
          message: formatError(error, "The Code workspace lease expired."),
        })
      })
    }, HEARTBEAT_INTERVAL_MS)
    return () => window.clearInterval(heartbeat)
  }, [readyWorkspace, workspaces])

  useEffect(() => {
    if (readyWorkspace === null || selectedPath === null) {
      if (selectedPath === null) setFile({ _tag: "idle" })
      return
    }
    let active = true
    setFile({ _tag: "loading", path: selectedPath })
    void runRendererPromise(workspaces.readFile(readyWorkspace.lease.id, selectedPath))
      .then((result) => {
        if (active) {
          setFile(
            Match.valueTags(result, {
              content: (content) => ({
                _tag: "ready" as const,
                path: content.path,
                content: content.content,
              }),
              rejected: (rejected) => ({
                _tag: "failure" as const,
                path: rejected.path,
                message: readRejectionMessage(rejected.reason),
              }),
            }),
          )
        }
        return undefined
      })
      .catch((error) => {
        if (active)
          setFile({
            _tag: "failure",
            path: selectedPath,
            message: formatError(error, "DiffDash could not read this file."),
          })
      })
    return () => {
      active = false
    }
  }, [readyWorkspace, selectedPath, workspaces])

  useEffect(() => {
    if (readyWorkspace === null || selectedPath === null) return
    const ancestors = selectedPath.split("/").slice(0, -1)
    if (ancestors.length === 0) return
    const paths = ancestors.map((_, index) =>
      RepositoryRelativePath.make(ancestors.slice(0, index + 1).join("/")),
    )
    setExpandedPaths((current) => new Set([...current, ...paths]))
    for (const path of paths) {
      if (!directories.has(path)) void loadDirectoryFromEffect(readyWorkspace.lease, path)
    }
  }, [directories, readyWorkspace, selectedPath])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return
      event.preventDefault()
      setPaletteOpen(true)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const searchPage = (query: string, offset: number, append: boolean) => {
    if (readyWorkspace === null) return
    const sequence = searchSequence.current + 1
    searchSequence.current = sequence
    const leaseId = readyWorkspace.lease.id
    setPaletteLoading(true)
    void runRendererPromise(workspaces.search(leaseId, query, offset, SEARCH_LIMIT))
      .then(({ paths, nextOffset }) => {
        if (searchSequence.current !== sequence || activeLeaseId.current !== leaseId) return
        const items: CommandPaletteItem[] = paths.map((path) => ({
          id: path,
          title: path.split("/").at(-1) ?? path,
          subtitle: path,
          keywords: path,
          onSelect: () => {
            onSelectedPathChange(path)
            setPaletteOpen(false)
          },
        }))
        if (nextOffset !== null) {
          items.push({
            id: `load-more:${nextOffset}`,
            title: "Load more results",
            subtitle: `Continue after ${nextOffset} matches`,
            keywords: query,
            keepOpen: true,
            onSelect: () => searchPage(query, nextOffset, true),
          })
        }
        setPaletteItems((current) => (append ? [...current.slice(0, -1), ...items] : items))
        return undefined
      })
      .catch(() => {
        if (searchSequence.current === sequence) setPaletteItems([])
      })
      .finally(() => {
        if (searchSequence.current === sequence) setPaletteLoading(false)
      })
  }

  const search = (query: string) => searchPage(query, 0, false)

  const toggleDirectory = (path: RepositoryRelativePath) => {
    if (readyWorkspace === null) return
    const isExpanded = expandedPaths.has(path)
    setExpandedPaths((current) => {
      const updated = new Set(current)
      if (isExpanded) updated.delete(path)
      else updated.add(path)
      return updated
    })
    if (!isExpanded && !directories.has(path)) void loadDirectory(readyWorkspace.lease, path)
  }

  const context =
    readyWorkspace !== null ? (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-9 shrink-0 items-center justify-end border-b px-2">
          <Button
            aria-label="Refresh repository files"
            size="icon-xs"
            variant="ghost"
            onClick={() => setReloadVersion((value) => value + 1)}
          >
            <span aria-hidden="true">↻</span>
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <CodeWorkspaceTree
            entries={directories}
            expandedPaths={expandedPaths}
            loadingPaths={loadingPaths}
            nextOffsets={directoryOffsets}
            selectedPath={selectedPath}
            onOpenFile={onSelectedPathChange}
            onLoadMore={(path) => {
              const offset = directoryOffsets.get(path ?? "")
              if (offset !== undefined && offset !== null) {
                void loadDirectory(readyWorkspace.lease, path, offset)
              }
            }}
            onToggleDirectory={toggleDirectory}
          />
        </div>
      </div>
    ) : (
      <div className="p-3 text-xs text-muted-foreground">Preparing repository files...</div>
    )

  const main = Match.valueTags(workspace, {
    loading: () => (
      <ProjectWorkspaceStatePanel
        announcement="loading"
        title="Preparing Code workspace"
        description="DiffDash is materializing an isolated checkout at the requested revision."
        tone="neutral"
      />
    ),
    failure: (failure) => (
      <div aria-label={repo.localPath === null ? "Local repository not linked" : undefined}>
        <ProjectWorkspaceStatePanel
          title="Code workspace unavailable"
          description={failure.message}
          tone="danger"
          actions={
            <>
              <Button size="sm" onClick={() => setReloadVersion((value) => value + 1)}>
                Retry
              </Button>
              <Button size="sm" variant="outline" onClick={onLinkRepository}>
                Link folder
              </Button>
            </>
          }
        />
      </div>
    ),
    ready: () =>
      Match.valueTags(file, {
        ready: (ready) => (
          <CodeFileViewer
            codeThemes={codeThemes}
            colorScheme={colorScheme}
            contents={ready.content}
            path={ready.path}
          />
        ),
        loading: (loading) => (
          <ProjectWorkspaceStatePanel
            announcement="loading"
            title="Loading file"
            description={loading.path}
            tone="neutral"
          />
        ),
        failure: (failure) => (
          <ProjectWorkspaceStatePanel
            title="File unavailable"
            description={failure.message}
            tone="warning"
          />
        ),
        idle: () => (
          <EmptyState className="h-full">Select a file from the repository tree.</EmptyState>
        ),
      }),
  })

  return (
    <>
      <ProjectWorkspaceFrame
        activeRibbon="code"
        context={context}
        contextWidth={contextWidth}
        main={main}
        sidebarExpanded={sidebarExpanded}
        threadDetailWidth={threadDetailWidth}
        onActiveRibbonChange={onActiveRibbonChange}
        onSidebarExpandedChange={onSidebarExpandedChange}
        onSidebarWidthChange={onSidebarWidthChange}
        onThreadDetailWidthChange={onThreadDetailWidthChange}
      />
      <CommandPaletteDialog
        filterItems={false}
        items={paletteItems}
        loading={paletteLoading}
        open={paletteOpen}
        placeholder="Search repository files"
        title="Go to file"
        onOpenChange={(open) => {
          setPaletteOpen(open)
          if (open) search("")
        }}
        onQueryChange={search}
      />
    </>
  )
}

const readRejectionMessage = (reason: CodeWorkspaceFileReadRejectionReason): string => {
  if (reason === "binary") return "Binary files cannot be displayed."
  if (reason === "oversized") return "This file exceeds the Code viewer size limit."
  if (reason === "invalidUtf8") return "This file is not valid UTF-8 text."
  if (reason === "unsafeSymlink") return "This symbolic link points outside the managed checkout."
  if (reason === "missing") return "This file no longer exists in the managed checkout."
  if (reason === "notRegularFile") return "The selected path is not a regular file."
  return "DiffDash could not read this file."
}
