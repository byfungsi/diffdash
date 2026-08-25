import type { CodeThemePreferences } from "@diffdash/domain/ai-settings"
import type { CodeLineChangeRange } from "@diffdash/domain/code-line-change"
import {
  type CodeWorkspaceEntry,
  CodeWorkspaceFileReadResult,
  type CodeWorkspaceFileReadRejectionReason,
  type CodeWorkspaceLease,
  CodeWorkspaceTarget,
  ProjectHeadCodeWorkspaceTarget,
} from "@diffdash/domain/code-workspace"
import type { DiffFileStatus } from "@diffdash/domain/diff"
import type { ProjectWorkspaceActivityId } from "@diffdash/domain/project-workspace"
import { LanguagePosition, LanguageRange } from "@diffdash/domain/language"
import type { Repo } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { Data, HashMap, HashSet, Match, Option, Schema } from "effect"
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react"

import type {
  CodeSourceContribution,
  OwnedExtensionContribution,
  ProjectActivityContribution,
  ProjectSurfaceContribution,
} from "@/extensions/extension-registry"
import { CodeActivityPaneProvider } from "@/extensions/code/code-activity-panes"
import { CodeSurfaceCapabilityProvider } from "@/extensions/code/code-surface-capability"
import { resolveProjectActivityMainPane } from "@/extensions/project-main-pane-resolver"
import { runRendererPromise, useCodeWorkspace } from "@/platform/renderer-runtime"
import { formatError } from "@/shared/errors"
import { Button } from "@/shared/ui/button"
import { EmptyState } from "@/shared/ui/empty-state"
import { ProjectWorkspaceStatePanel } from "@/shared/ui/project-workspace-state-panel"
import type { ColorScheme } from "@/settings/theme"
import { CommandPaletteDialog, type CommandPaletteItem } from "@/shell/command-palette"
import { useKeyboardShortcut } from "@/shell/keyboard-shortcuts"
import type { LanguageNavigationDestination } from "@/source-surface/language-navigation-capability"

import { CodeFileViewer } from "@/project-workspace/code-file-viewer"
import { CodeWorkspaceTree } from "@/project-workspace/code-workspace-tree"
import { ProjectWorkspaceFrame } from "@/project-workspace/project-workspace-frame"

type WorkspaceState = Data.TaggedEnum<{
  readonly loading: {}
  readonly ready: { readonly lease: CodeWorkspaceLease }
  readonly failure: { readonly message: string }
}>
const WorkspaceState = Data.taggedEnum<WorkspaceState>()

type FileState = Data.TaggedEnum<{
  readonly idle: {}
  readonly loading: { readonly path: RepositoryRelativePath }
  readonly ready: { readonly path: RepositoryRelativePath; readonly content: string }
  readonly failure: { readonly path: RepositoryRelativePath; readonly message: string }
}>
const FileState = Data.taggedEnum<FileState>()

const CodeDefinitionNavigation = Schema.Struct({
  id: Schema.Int,
  path: RepositoryRelativePath,
  range: LanguageRange,
})

/** Semantic Code definition destination restored from global navigation history. */
export type CodeDefinitionNavigation = typeof CodeDefinitionNavigation.Type

const DIRECTORY_PAGE_SIZE = 500
const SEARCH_LIMIT = 100
const HEARTBEAT_INTERVAL_MS = 20 * 60 * 1_000
const EMPTY_LINE_CHANGES = HashMap.empty<RepositoryRelativePath, readonly CodeLineChangeRange[]>()
const EMPTY_CODE_SOURCE_CONTRIBUTIONS: readonly OwnedExtensionContribution<CodeSourceContribution>[] =
  []

/** Inputs supplied by the project host to the trusted Code extension surface. */
export interface CodeScreenProps {
  readonly active: boolean
  readonly activeActivity: ProjectWorkspaceActivityId
  readonly activities: readonly OwnedExtensionContribution<ProjectActivityContribution>[]
  readonly codeThemes: CodeThemePreferences
  readonly codeSourceContributions?: readonly OwnedExtensionContribution<CodeSourceContribution>[]
  readonly colorScheme: ColorScheme
  readonly contextWidth: number
  readonly fileStatuses: Iterable<readonly [RepositoryRelativePath, DiffFileStatus]>
  readonly historyDefinitionNavigation?: Option.Option<CodeDefinitionNavigation>
  readonly lineChanges?: HashMap.HashMap<RepositoryRelativePath, readonly CodeLineChangeRange[]>
  readonly repo: Repo
  readonly surfaceContribution: OwnedExtensionContribution<ProjectSurfaceContribution>
  readonly selectedPath: RepositoryRelativePath | null
  readonly sidebarExpanded: boolean
  readonly target: CodeWorkspaceTarget
  readonly threadDetailWidth: number
  readonly onHistoryDefinitionNavigationHandled?: (id: number) => void
  readonly onActiveActivityChange: (activityId: ProjectWorkspaceActivityId) => void
  readonly onLinkRepository: () => void
  readonly onNavigateToDefinition?: (destination: LanguageNavigationDestination) => void
  readonly onSelectedPathChange: (path: RepositoryRelativePath | null) => void
  readonly onSidebarExpandedChange: (expanded: boolean) => void
  readonly onSidebarWidthChange: (width: number) => void
  readonly onThreadDetailWidthChange: (width: number) => void
}

/** Managed exact-revision Code browser with lazy directory and filename loading. */
export const CodeScreen = ({
  active,
  activeActivity,
  activities,
  codeThemes,
  codeSourceContributions = EMPTY_CODE_SOURCE_CONTRIBUTIONS,
  colorScheme,
  contextWidth,
  fileStatuses,
  historyDefinitionNavigation = Option.none(),
  lineChanges = EMPTY_LINE_CHANGES,
  repo,
  surfaceContribution,
  selectedPath,
  sidebarExpanded,
  target,
  threadDetailWidth,
  onHistoryDefinitionNavigationHandled,
  onActiveActivityChange,
  onLinkRepository,
  onNavigateToDefinition,
  onSelectedPathChange,
  onSidebarExpandedChange,
  onSidebarWidthChange,
  onThreadDetailWidthChange,
}: CodeScreenProps) => {
  const workspaces = useCodeWorkspace()
  const [workspace, setWorkspace] = useState<WorkspaceState>(WorkspaceState.loading())
  const [file, setFile] = useState<FileState>(FileState.idle())
  const [directories, setDirectories] = useState<
    HashMap.HashMap<string, readonly CodeWorkspaceEntry[]>
  >(HashMap.empty())
  const [expandedPaths, setExpandedPaths] = useState<HashSet.HashSet<RepositoryRelativePath>>(
    HashSet.empty(),
  )
  const [loadingPaths, setLoadingPaths] = useState<HashSet.HashSet<string>>(HashSet.empty())
  const [directoryOffsets, setDirectoryOffsets] = useState<HashMap.HashMap<string, number>>(
    HashMap.empty(),
  )
  const [workspaceFileStatuses, setWorkspaceFileStatuses] = useState<
    HashMap.HashMap<RepositoryRelativePath, DiffFileStatus>
  >(HashMap.empty())
  const [workspaceLineChanges, setWorkspaceLineChanges] = useState<
    HashMap.HashMap<RepositoryRelativePath, readonly CodeLineChangeRange[]>
  >(HashMap.empty())
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteItems, setPaletteItems] = useState<readonly CommandPaletteItem[]>([])
  const [paletteLoading, setPaletteLoading] = useState(false)
  const [reloadVersion, setReloadVersion] = useState(0)
  const [definitionNavigation, setDefinitionNavigation] = useState<
    Option.Option<CodeDefinitionNavigation>
  >(Option.none())
  const definitionNavigationSequence = useRef(0)
  const activeLease = useRef<Option.Option<CodeWorkspaceLease>>(Option.none())
  const directoryRequests = useRef(new WeakMap<CodeWorkspaceLease, HashSet.HashSet<string>>())
  const searchSequence = useRef(0)
  const targetIdentity = JSON.stringify(Schema.encodeSync(CodeWorkspaceTarget)(target))
  const requiresLocalCheckout = Schema.is(ProjectHeadCodeWorkspaceTarget)(target)
  const readyWorkspace = useMemo(
    () =>
      Match.valueTags(workspace, {
        loading: () => Option.none(),
        failure: () => Option.none(),
        ready: (state) => Option.some(state),
      }),
    [workspace],
  )
  const visibleFileStatuses = HashMap.union(
    workspaceFileStatuses,
    HashMap.fromIterable(fileStatuses),
  )

  const requestDirectory = async (
    lease: CodeWorkspaceLease,
    path: RepositoryRelativePath | null,
    offset = 0,
  ) => {
    const key = path ?? ""
    const requestKey = `${key}\0${offset}`
    const leaseRequests = directoryRequests.current.get(lease) ?? HashSet.empty<string>()
    if (HashSet.has(leaseRequests, requestKey)) return
    directoryRequests.current.set(lease, HashSet.add(leaseRequests, requestKey))
    setLoadingPaths((current) => HashSet.add(current, key))
    try {
      const page = await runRendererPromise(
        workspaces.listDirectory(lease.id, path, offset, DIRECTORY_PAGE_SIZE),
      )
      if (!Option.exists(activeLease.current, (currentLease) => currentLease === lease)) return
      setDirectories((current) =>
        HashMap.set(
          current,
          key,
          offset === 0
            ? page.entries
            : [...Option.getOrElse(HashMap.get(current, key), () => []), ...page.entries],
        ),
      )
      setDirectoryOffsets((current) =>
        HashMap.modifyAt(current, key, () => Option.fromNullishOr(page.nextOffset)),
      )
    } finally {
      const remainingRequests = HashSet.remove(
        directoryRequests.current.get(lease) ?? HashSet.empty(),
        requestKey,
      )
      if (HashSet.size(remainingRequests) === 0) directoryRequests.current.delete(lease)
      else directoryRequests.current.set(lease, remainingRequests)
      if (Option.exists(activeLease.current, (currentLease) => currentLease === lease)) {
        setLoadingPaths((current) => HashSet.remove(current, key))
      }
    }
  }
  const loadDirectory = (
    lease: CodeWorkspaceLease,
    path: RepositoryRelativePath | null,
    offset = 0,
  ) =>
    requestDirectory(lease, path, offset).catch((error) => {
      if (
        path === null &&
        Option.exists(activeLease.current, (currentLease) => currentLease === lease)
      ) {
        activeLease.current = Option.none()
        void runRendererPromise(workspaces.release(lease.id)).catch(() => undefined)
        setWorkspace(
          WorkspaceState.failure({
            message: formatError(error, "DiffDash could not load repository files."),
          }),
        )
      }
    })
  const loadDirectoryFromEffect = useEffectEvent(loadDirectory)
  const openWorkspace = useEffectEvent(() => runRendererPromise(workspaces.open(target)))

  useEffect(() => {
    let requestActive = true
    let lease = Option.none<CodeWorkspaceLease>()
    setWorkspace(WorkspaceState.loading())
    setDirectories(HashMap.empty())
    setExpandedPaths(HashSet.empty())
    setLoadingPaths(HashSet.empty())
    setDirectoryOffsets(HashMap.empty())
    setWorkspaceFileStatuses(HashMap.empty())
    setWorkspaceLineChanges(HashMap.empty())
    setFile(FileState.idle())
    if (requiresLocalCheckout && repo.localPath === null) {
      setWorkspace(
        WorkspaceState.failure({
          message: "Link a checkout to browse code at the project's current HEAD.",
        }),
      )
      return
    }
    const open = async () => {
      try {
        const openedLease = await openWorkspace()
        lease = Option.some(openedLease)
        if (!requestActive) {
          await runRendererPromise(workspaces.release(openedLease.id)).catch(() => undefined)
          return
        }
        activeLease.current = Option.some(openedLease)
        setWorkspace(WorkspaceState.ready({ lease: openedLease }))
        if (requiresLocalCheckout) {
          void runRendererPromise(workspaces.changes(openedLease.id))
            .then((result) => {
              if (
                Option.exists(activeLease.current, (currentLease) => currentLease === openedLease)
              ) {
                setWorkspaceFileStatuses(
                  HashMap.fromIterable(
                    result.changes
                      .filter((change) => change.status !== "deleted")
                      .map((change) => [change.path, change.status] as const),
                  ),
                )
              }
              return undefined
            })
            .catch(() => undefined)
        }
        await loadDirectoryFromEffect(openedLease, null)
      } catch (error) {
        if (requestActive)
          setWorkspace(
            WorkspaceState.failure({
              message: formatError(error, "DiffDash could not prepare the Code workspace."),
            }),
          )
      }
    }
    void open()
    return () => {
      requestActive = false
      Option.match(lease, {
        onNone: () => undefined,
        onSome: (openedLease) => {
          if (!Option.exists(activeLease.current, (currentLease) => currentLease === openedLease))
            return
          activeLease.current = Option.none()
          void runRendererPromise(workspaces.release(openedLease.id)).catch(() => undefined)
        },
      })
    }
  }, [reloadVersion, repo.localPath, requiresLocalCheckout, targetIdentity, workspaces])

  useEffect(() => {
    if (Option.isNone(readyWorkspace)) return
    const ready = readyWorkspace.value
    const leaseId = ready.lease.id
    const heartbeat = window.setInterval(() => {
      void runRendererPromise(workspaces.heartbeat(leaseId)).catch((error) => {
        if (!Option.exists(activeLease.current, (currentLease) => currentLease === ready.lease))
          return
        activeLease.current = Option.none()
        void runRendererPromise(workspaces.release(leaseId)).catch(() => undefined)
        setWorkspace(
          WorkspaceState.failure({
            message: formatError(error, "The Code workspace lease expired."),
          }),
        )
      })
    }, HEARTBEAT_INTERVAL_MS)
    return () => window.clearInterval(heartbeat)
  }, [readyWorkspace, workspaces])

  useEffect(() => {
    if (Option.isNone(readyWorkspace) || selectedPath === null) {
      if (selectedPath === null) setFile(FileState.idle())
      return
    }
    const ready = readyWorkspace.value
    let requestActive = true
    setFile(FileState.loading({ path: selectedPath }))
    setWorkspaceLineChanges(HashMap.empty())
    void runRendererPromise(workspaces.readFile(ready.lease.id, selectedPath))
      .then((result) => {
        if (requestActive) {
          setFile(
            CodeWorkspaceFileReadResult.match(result, {
              content: (content): FileState =>
                FileState.ready({
                  path: content.path,
                  content: content.content,
                }),
              rejected: (rejected): FileState =>
                FileState.failure({
                  path: rejected.path,
                  message: readRejectionMessage(rejected.reason),
                }),
            }),
          )
        }
        return undefined
      })
      .catch((error) => {
        if (requestActive)
          setFile(
            FileState.failure({
              path: selectedPath,
              message: formatError(error, "DiffDash could not read this file."),
            }),
          )
      })
    if (requiresLocalCheckout) {
      void runRendererPromise(workspaces.lineChanges(ready.lease.id, selectedPath))
        .then((result) => {
          if (requestActive) {
            setWorkspaceLineChanges(HashMap.make([selectedPath, result.changes]))
          }
          return undefined
        })
        .catch(() => undefined)
    }
    return () => {
      requestActive = false
    }
  }, [readyWorkspace, requiresLocalCheckout, selectedPath, workspaces])

  useEffect(() => {
    if (Option.isNone(readyWorkspace) || selectedPath === null) return
    const ready = readyWorkspace.value
    const ancestors = selectedPath.split("/").slice(0, -1)
    if (ancestors.length === 0) return
    const paths = ancestors.map((_, index) =>
      RepositoryRelativePath.make(ancestors.slice(0, index + 1).join("/")),
    )
    setExpandedPaths((current) => HashSet.union(current, HashSet.fromIterable(paths)))
    for (const path of paths) {
      if (!HashMap.has(directories, path)) void loadDirectoryFromEffect(ready.lease, path)
    }
  }, [directories, readyWorkspace, selectedPath])

  useEffect(() => {
    if (!active) {
      setPaletteOpen(false)
      return undefined
    }
    return undefined
  }, [active])
  useKeyboardShortcut("navigation.goAnywhere", () => setPaletteOpen(true), {
    enabled: active,
    priority: 10,
  })
  useKeyboardShortcut("code.reload", () => setReloadVersion((value) => value + 1), {
    enabled: active && activeActivity === surfaceContribution.defaultActivityId,
  })

  const searchPage = (query: string, offset: number, append: boolean) => {
    if (Option.isNone(readyWorkspace)) return
    const ready = readyWorkspace.value
    const sequence = searchSequence.current + 1
    searchSequence.current = sequence
    const leaseId = ready.lease.id
    const lease = ready.lease
    setPaletteLoading(true)
    void runRendererPromise(workspaces.search(leaseId, query, offset, SEARCH_LIMIT))
      .then(({ paths, nextOffset }) => {
        if (
          searchSequence.current !== sequence ||
          !Option.exists(activeLease.current, (currentLease) => currentLease === lease)
        )
          return
        const items: CommandPaletteItem[] = paths.map((path) => ({
          id: path,
          title: path.split("/").at(-1) ?? path,
          subtitle: path,
          keywords: path,
          onSelect: () => {
            setDefinitionNavigation(Option.none())
            onSelectedPathChange(path)
            setPaletteOpen(false)
          },
        }))
        Option.match(Option.fromNullishOr(nextOffset), {
          onNone: () => undefined,
          onSome: (next) => {
            items.push({
              id: `load-more:${next}`,
              title: "Load more results",
              subtitle: `Continue after ${next} matches`,
              keywords: query,
              keepOpen: true,
              onSelect: () => searchPage(query, next, true),
            })
          },
        })
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

  const requestDefinitions = (
    lease: CodeWorkspaceLease,
    path: RepositoryRelativePath,
    position: LanguagePosition,
    signal: AbortSignal,
  ) => runRendererPromise(workspaces.definitions(lease.id, path, position), signal)

  const requestReferences = (
    lease: CodeWorkspaceLease,
    path: RepositoryRelativePath,
    position: LanguagePosition,
    signal: AbortSignal,
  ) => runRendererPromise(workspaces.references(lease.id, path, position), signal)

  const loadDefinitionSource = async (
    lease: CodeWorkspaceLease,
    path: RepositoryRelativePath,
    signal: AbortSignal,
  ): Promise<Option.Option<string>> => {
    if (signal.aborted) return Option.none()
    const result = await runRendererPromise(workspaces.readFile(lease.id, path), signal)
    if (
      signal.aborted ||
      !Option.exists(activeLease.current, (currentLease) => currentLease === lease)
    )
      return Option.none()
    return CodeWorkspaceFileReadResult.match(result, {
      content: ({ content }) => Option.some(content),
      rejected: () => Option.none(),
    })
  }

  const navigateToDefinition = (destination: LanguageNavigationDestination) => {
    if (onNavigateToDefinition !== undefined) {
      onNavigateToDefinition(destination)
      return
    }
    const location = destination.location
    const id = definitionNavigationSequence.current + 1
    definitionNavigationSequence.current = id
    setDefinitionNavigation(
      Option.some({
        id,
        path: location.target.path,
        range: location.targetSelectionRange,
      }),
    )
    onSelectedPathChange(location.target.path)
  }

  const toggleDirectory = (path: RepositoryRelativePath) => {
    if (Option.isNone(readyWorkspace)) return
    const ready = readyWorkspace.value
    const isExpanded = HashSet.has(expandedPaths, path)
    setExpandedPaths((current) =>
      isExpanded ? HashSet.remove(current, path) : HashSet.add(current, path),
    )
    if (!isExpanded && !HashMap.has(directories, path)) void loadDirectory(ready.lease, path)
  }

  const codeTreeContext = Option.isSome(readyWorkspace) ? (
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
          fileStatuses={visibleFileStatuses}
          loadingPaths={loadingPaths}
          nextOffsets={directoryOffsets}
          selectedPath={selectedPath}
          onOpenFile={(path) => {
            setDefinitionNavigation(Option.none())
            onSelectedPathChange(path)
          }}
          onLoadMore={(path) => {
            Option.match(HashMap.get(directoryOffsets, path ?? ""), {
              onNone: () => undefined,
              onSome: (offset) => void loadDirectory(readyWorkspace.value.lease, path, offset),
            })
          }}
          onToggleDirectory={toggleDirectory}
        />
      </div>
    </div>
  ) : (
    <div className="p-3 text-xs text-muted-foreground">Preparing repository files...</div>
  )
  const activeActivityContribution = activities.find((activity) => activity.id === activeActivity)
  const ContextPane = activeActivityContribution?.slots?.contextPane?.component
  const workspaceRevision = Option.match(readyWorkspace, {
    onNone: () => null,
    onSome: (ready) => ready.lease.revision,
  })
  const paneHost = {
    contextOpen: sidebarExpanded,
    detailOpen: false,
    contextActions: null,
    openContext: () => onSidebarExpandedChange(true),
    openDetail: () => undefined,
    closeContext: () => onSidebarExpandedChange(false),
    closeDetail: () => undefined,
    showMain: () => onSidebarExpandedChange(false),
  }
  const activityPaneProps = {
    location: { surface: "code" as const, projectId: repo.id },
    paneHost,
  }
  const context =
    ContextPane === undefined ? (
      <ProjectWorkspaceStatePanel
        title="Activity unavailable"
        description="This activity does not provide a pane for Code."
        tone="warning"
      />
    ) : (
      <ContextPane
        key={activeActivityContribution?.ownerRegistrationToken.reactKey}
        {...activityPaneProps}
      />
    )

  const codeMain = Match.valueTags(workspace, {
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
    ready: (workspaceState) =>
      Match.valueTags(file, {
        ready: (ready) => (
          <CodeFileViewer
            key={`${ready.path}:${workspaceState.lease.revision}`}
            codeThemes={codeThemes}
            colorScheme={colorScheme}
            contributions={codeSourceContributions}
            contents={ready.content}
            lineChanges={Option.getOrElse(
              Option.orElse(HashMap.get(lineChanges, ready.path), () =>
                HashMap.get(workspaceLineChanges, ready.path),
              ),
              () => [],
            )}
            path={ready.path}
            projectId={repo.id}
            revision={workspaceState.lease.revision}
            gitRevision={workspaceState.lease.gitRevision}
            definitionNavigation={Option.filter(
              Option.orElse(historyDefinitionNavigation, () => definitionNavigation),
              (navigation) => navigation.path === ready.path,
            ).pipe(Option.map(({ id, range }) => ({ id, range })))}
            onDefinitionNavigationHandled={(id) => {
              onHistoryDefinitionNavigationHandled?.(id)
              setDefinitionNavigation((current) =>
                Option.filter(current, (navigation) => navigation.id !== id),
              )
            }}
            onLoadDefinitionSource={(path, signal) =>
              loadDefinitionSource(workspaceState.lease, path, signal)
            }
            onNavigateToDefinition={navigateToDefinition}
            onRequestDefinitions={(position, signal) =>
              requestDefinitions(workspaceState.lease, ready.path, position, signal)
            }
            onRequestReferences={(position, signal) =>
              requestReferences(workspaceState.lease, ready.path, position, signal)
            }
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
  const main = resolveProjectActivityMainPane({
    activeActivityId: activeActivity,
    activities,
    activityPaneProps,
    baseMain: codeMain,
    surface: surfaceContribution,
  })

  if (!active) return null

  return (
    <>
      <CodeSurfaceCapabilityProvider
        capability={{ workspaceRevision, selectedPath, selectPath: onSelectedPathChange }}
      >
        <CodeActivityPaneProvider contextPane={codeTreeContext} mainPane={codeMain}>
          <ProjectWorkspaceFrame
            activeActivity={activeActivity}
            activities={activities}
            context={context}
            contextWidth={contextWidth}
            main={main}
            sidebarExpanded={sidebarExpanded}
            threadDetailWidth={threadDetailWidth}
            onActiveActivityChange={onActiveActivityChange}
            onSidebarExpandedChange={onSidebarExpandedChange}
            onSidebarWidthChange={onSidebarWidthChange}
            onThreadDetailWidthChange={onThreadDetailWidthChange}
          />
        </CodeActivityPaneProvider>
      </CodeSurfaceCapabilityProvider>
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
