import type { CodeThemePreferences } from "@diffdash/domain/ai-settings"
import {
  LocalCheckoutFileListResult,
  LocalCheckoutFileReadResult,
  type LocalCheckoutFileListRejectionReason,
  type LocalCheckoutFileReadRejectionReason,
} from "@diffdash/domain/local-checkout-file"
import type { ProjectWorkspaceRibbon } from "@diffdash/domain/project-workspace"
import { RepositoryCheckout, type Repo } from "@diffdash/domain/repository"
import type { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { Data, Effect, Option } from "effect"
import { FolderGit2, RefreshCw } from "lucide-react"
import { useDeferredValue, useEffect, useMemo, useState } from "react"

import { runRendererPromise, useLocalCheckoutFiles } from "@/platform/renderer-runtime"
import { formatError } from "@/shared/errors"
import { Button } from "@/shared/ui/button"
import { EmptyState } from "@/shared/ui/empty-state"
import { Input } from "@/shared/ui/input"
import { ProjectWorkspaceStatePanel } from "@/shared/ui/project-workspace-state-panel"
import type { ColorScheme } from "@/settings/theme"

import { CodeFileViewer } from "./code-file-viewer"
import { ProjectWorkspaceFrame } from "./project-workspace-frame"
import { RepositoryFileTree } from "./repository-file-tree"

type RepositoryFilesState = Data.TaggedEnum<{
  readonly unavailable: {}
  readonly loading: {}
  readonly ready: { readonly paths: readonly RepositoryRelativePath[] }
  readonly rejected: { readonly reason: LocalCheckoutFileListRejectionReason }
  readonly failure: { readonly message: string }
}>
const RepositoryFilesState = Data.taggedEnum<RepositoryFilesState>()

type RepositoryFileState = Data.TaggedEnum<{
  readonly idle: {}
  readonly loading: { readonly path: RepositoryRelativePath }
  readonly content: { readonly path: RepositoryRelativePath; readonly content: string }
  readonly rejected: {
    readonly path: RepositoryRelativePath
    readonly reason: LocalCheckoutFileReadRejectionReason
  }
  readonly failure: { readonly path: RepositoryRelativePath; readonly message: string }
}>
const RepositoryFileState = Data.taggedEnum<RepositoryFileState>()

type CodeMainPanelState = Data.TaggedEnum<{
  readonly loading: { readonly title: string; readonly description: string }
  readonly retry: {
    readonly title: string
    readonly description: string
    readonly onRetry: () => void
  }
}>
const CodeMainPanelState = Data.taggedEnum<CodeMainPanelState>()

const LIST_REJECTION_MESSAGES: Readonly<Record<LocalCheckoutFileListRejectionReason, string>> = {
  checkoutUnavailable: "The linked checkout is no longer available on this machine.",
  gitUnavailable: "Git could not enumerate files in this checkout.",
  invalidPath: "The checkout contains a path that DiffDash cannot safely browse.",
  limitExceeded: "This checkout contains too many files to display safely.",
  repositoryNotFound: "This project is no longer available.",
  repositoryUnavailable: "DiffDash could not load this project.",
}

const READ_REJECTION_MESSAGES: Readonly<Record<LocalCheckoutFileReadRejectionReason, string>> = {
  binary: "Binary files are not supported by the Code viewer.",
  checkoutUnavailable: "The linked checkout is no longer available on this machine.",
  invalidUtf8: "This file is not valid UTF-8 text.",
  ioFailure: "DiffDash could not read this file.",
  missing: "This file no longer exists in the checkout.",
  notRegularFile: "This path is not a regular file.",
  oversized: "This file is too large to display safely.",
  repositoryNotFound: "This project is no longer available.",
  repositoryUnavailable: "DiffDash could not load this project.",
  unsafeSymlink: "DiffDash will not open a symbolic link outside the checkout.",
}

/** Project-scoped checkout browser rendered independently from review selection. */
export const CodeScreen = ({
  codeThemes,
  colorScheme,
  contextWidth,
  repo,
  sidebarExpanded,
  threadDetailWidth,
  onActiveRibbonChange,
  onLinkRepository,
  onSidebarExpandedChange,
  onSidebarWidthChange,
  onThreadDetailWidthChange,
}: {
  readonly codeThemes: CodeThemePreferences
  readonly colorScheme: ColorScheme
  readonly contextWidth: number
  readonly repo: Repo
  readonly sidebarExpanded: boolean
  readonly threadDetailWidth: number
  readonly onActiveRibbonChange: (ribbon: ProjectWorkspaceRibbon) => void
  readonly onLinkRepository: () => Promise<boolean>
  readonly onSidebarExpandedChange: (expanded: boolean) => void
  readonly onSidebarWidthChange: (width: number) => void
  readonly onThreadDetailWidthChange: (width: number) => void
}) => {
  const checkoutFiles = useLocalCheckoutFiles()
  const checkoutPath = useMemo(
    () =>
      RepositoryCheckout.match(repo.checkout, {
        RemoteOnly: Option.none,
        LinkedCheckout: ({ path }) => Option.some(path),
      }),
    [repo.checkout],
  )
  const [filesState, setFilesState] = useState<RepositoryFilesState>(() =>
    Option.match(checkoutPath, {
      onNone: RepositoryFilesState.unavailable,
      onSome: () => RepositoryFilesState.loading(),
    }),
  )
  const [fileState, setFileState] = useState<RepositoryFileState>(() => RepositoryFileState.idle())
  const [selectedPath, setSelectedPath] = useState<Option.Option<RepositoryRelativePath>>(
    Option.none,
  )
  const [filter, setFilter] = useState("")
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [linking, setLinking] = useState(false)
  const [linkError, setLinkError] = useState<Option.Option<string>>(Option.none)
  const deferredFilter = useDeferredValue(filter.trim().toLocaleLowerCase())

  useEffect(
    () =>
      Option.match(checkoutPath, {
        onNone: () => {
          setFilesState(RepositoryFilesState.unavailable())
          setSelectedPath(Option.none())
          setFileState(RepositoryFileState.idle())
        },
        onSome: () => {
          let current = true
          setFilesState(RepositoryFilesState.loading())
          const load = checkoutFiles
            .list(repo.id)
            .pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  if (!current) return
                  LocalCheckoutFileListResult.match(result, {
                    files: (files) => {
                      setFilesState(RepositoryFilesState.ready({ paths: files.paths }))
                      setSelectedPath((path) =>
                        Option.filter(path, (selected) => files.paths.includes(selected)).pipe(
                          Option.orElse(() => Option.fromNullishOr(files.paths[0])),
                        ),
                      )
                    },
                    rejected: (rejection) => {
                      setFilesState(RepositoryFilesState.rejected({ reason: rejection.reason }))
                      setSelectedPath(Option.none())
                    },
                  })
                }),
              ),
            )
            .pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  if (!current) return
                  setFilesState(
                    RepositoryFilesState.failure({
                      message: formatError(error, "Could not list files"),
                    }),
                  )
                  setSelectedPath(Option.none())
                }),
              ),
            )
          void runRendererPromise(load)
          return () => {
            current = false
          }
        },
      }),
    [checkoutFiles, refreshVersion, repo.id, checkoutPath],
  )

  useEffect(
    () =>
      Option.match(selectedPath, {
        onNone: () => setFileState(RepositoryFileState.idle()),
        onSome: (path) => {
          let current = true
          setFileState(RepositoryFileState.loading({ path }))
          const load = checkoutFiles
            .read(repo.id, path)
            .pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  if (!current) return
                  LocalCheckoutFileReadResult.match(result, {
                    content: (file) =>
                      setFileState(
                        RepositoryFileState.content({ path: file.path, content: file.content }),
                      ),
                    rejected: (rejection) =>
                      setFileState(
                        RepositoryFileState.rejected({
                          path: rejection.path,
                          reason: rejection.reason,
                        }),
                      ),
                  })
                }),
              ),
            )
            .pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  if (!current) return
                  setFileState(
                    RepositoryFileState.failure({
                      path,
                      message: formatError(error, "Could not read file"),
                    }),
                  )
                }),
              ),
            )
          void runRendererPromise(load)
          return () => {
            current = false
          }
        },
      }),
    [checkoutFiles, refreshVersion, repo.id, selectedPath],
  )

  const paths = RepositoryFilesState.$match(filesState, {
    ready: ({ paths: readyPaths }) => readyPaths,
    unavailable: () => [],
    loading: () => [],
    rejected: () => [],
    failure: () => [],
  })
  const visiblePaths =
    deferredFilter.length === 0
      ? paths
      : paths.filter((path) => path.toLocaleLowerCase().includes(deferredFilter))
  const filesLoading = RepositoryFilesState.$match(filesState, {
    loading: () => true,
    unavailable: () => false,
    ready: () => false,
    rejected: () => false,
    failure: () => false,
  })
  const refresh = () => setRefreshVersion((version) => version + 1)
  const linkRepository = () => {
    if (linking) return
    setLinking(true)
    setLinkError(Option.none())
    const link = Effect.tryPromise({
      try: onLinkRepository,
      catch: (error) => formatError(error, "Could not link checkout"),
    })
      .pipe(Effect.tap(() => Effect.sync(() => setLinking(false))))
      .pipe(
        Effect.catch((message) =>
          Effect.sync(() => {
            setLinkError(Option.some(message))
            setLinking(false)
          }),
        ),
      )
    void runRendererPromise(link)
  }
  const context = Option.match(checkoutPath, {
    onNone: () => (
      <div className="flex min-h-0 flex-1 items-center p-3 text-xs text-review-sidebar-muted">
        Link a local checkout to browse repository files.
      </div>
    ),
    onSome: () => (
      <>
        <div className="border-review-sidebar-divider border-b p-3">
          <Input
            value={filter}
            aria-label="Filter repository files"
            placeholder="Filter files"
            onChange={(event) => setFilter(event.currentTarget.value)}
          />
        </div>
        <div className="min-h-0 flex-1">
          {visiblePaths.length > 0 ? (
            <RepositoryFileTree
              paths={visiblePaths}
              selectedPath={selectedPath}
              onSelectPath={(path) => setSelectedPath(Option.some(path))}
            />
          ) : (
            <CodeSidebarState state={filesState} filtered={paths.length > 0} />
          )}
        </div>
      </>
    ),
  })
  const main = Option.match(checkoutPath, {
    onNone: () => (
      <CodeCheckoutLinkState error={linkError} linking={linking} onLink={linkRepository} />
    ),
    onSome: () => (
      <CodeMainState
        codeThemes={codeThemes}
        colorScheme={colorScheme}
        fileState={fileState}
        filesState={filesState}
        onRetry={refresh}
      />
    ),
  })

  return (
    <ProjectWorkspaceFrame
      activeRibbon="code"
      context={
        <aside className="bg-review-sidebar text-review-sidebar-fg flex h-full min-h-0 flex-col">
          <header className="border-review-sidebar-divider flex h-9 shrink-0 items-center gap-2 border-b px-3">
            <h2 className="text-caption min-w-0 flex-1 truncate font-semibold tracking-wide uppercase">
              Code
            </h2>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Refresh repository files"
              title="Refresh repository files"
              disabled={Option.isNone(checkoutPath) || filesLoading}
              onClick={refresh}
            >
              <RefreshCw className={filesLoading ? "size-3 animate-spin" : "size-3"} />
            </Button>
          </header>
          {context}
        </aside>
      }
      contextWidth={contextWidth}
      main={main}
      sidebarExpanded={sidebarExpanded}
      threadDetailWidth={threadDetailWidth}
      onActiveRibbonChange={onActiveRibbonChange}
      onSidebarExpandedChange={onSidebarExpandedChange}
      onSidebarWidthChange={onSidebarWidthChange}
      onThreadDetailWidthChange={onThreadDetailWidthChange}
    />
  )
}

const CodeSidebarState = ({
  filtered,
  state,
}: {
  readonly filtered: boolean
  readonly state: RepositoryFilesState
}) => {
  const message = RepositoryFilesState.$match(state, {
    loading: () => "Loading repository files...",
    rejected: ({ reason }) => LIST_REJECTION_MESSAGES[reason],
    failure: ({ message: failure }) => failure,
    unavailable: () => "Link a local checkout to browse repository files.",
    ready: () =>
      filtered ? "No files match this filter." : "No tracked or unignored files found.",
  })
  return <div className="p-3 text-xs text-review-sidebar-muted">{message}</div>
}

const CodeCheckoutLinkState = ({
  error,
  linking,
  onLink,
}: {
  readonly error: Option.Option<string>
  readonly linking: boolean
  readonly onLink: () => void
}) => (
  <div className="flex min-h-full flex-col">
    <section aria-label="Local repository not linked" className="bg-accent/70 border-b px-5 py-3">
      <div className="mx-auto flex max-w-review-diff items-start gap-3">
        <div className="bg-background text-primary mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border shadow-xs">
          <FolderGit2 className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold">Link a checkout to browse code</p>
          <p className="text-muted-foreground mt-0.5 text-xs leading-5">
            Choose the local folder for this project. DiffDash only reads tracked and unignored
            files.
          </p>
          {Option.match(error, {
            onNone: () => null,
            onSome: (message) => <p className="text-destructive mt-1 text-xs">{message}</p>,
          })}
        </div>
        <Button size="sm" variant="outline" disabled={linking} onClick={onLink}>
          {linking ? "Linking..." : "Link folder"}
        </Button>
      </div>
    </section>
    <EmptyState>Code becomes available after linking a local checkout.</EmptyState>
  </div>
)

const CodeMainState = ({
  codeThemes,
  colorScheme,
  fileState,
  filesState,
  onRetry,
}: {
  readonly codeThemes: CodeThemePreferences
  readonly colorScheme: ColorScheme
  readonly fileState: RepositoryFileState
  readonly filesState: RepositoryFilesState
  readonly onRetry: () => void
}) =>
  RepositoryFileState.$match(fileState, {
    content: (file) => (
      <CodeFileViewer
        codeThemes={codeThemes}
        colorScheme={colorScheme}
        contents={file.content}
        path={file.path}
      />
    ),
    loading: (file) =>
      renderCodeMainPanel(
        CodeMainPanelState.loading({ title: "Opening file", description: file.path }),
      ),
    rejected: (file) =>
      renderCodeMainPanel(
        CodeMainPanelState.retry({
          title: "File unavailable",
          description: READ_REJECTION_MESSAGES[file.reason],
          onRetry,
        }),
      ),
    failure: (file) =>
      renderCodeMainPanel(
        CodeMainPanelState.retry({
          title: "File unavailable",
          description: file.message,
          onRetry,
        }),
      ),
    idle: () =>
      RepositoryFilesState.$match(filesState, {
        loading: () =>
          renderCodeMainPanel(
            CodeMainPanelState.loading({
              title: "Loading code",
              description: "Reading repository files.",
            }),
          ),
        rejected: (files) =>
          renderCodeMainPanel(
            CodeMainPanelState.retry({
              title: "Code unavailable",
              description: LIST_REJECTION_MESSAGES[files.reason],
              onRetry,
            }),
          ),
        failure: (files) =>
          renderCodeMainPanel(
            CodeMainPanelState.retry({
              title: "Code unavailable",
              description: files.message,
              onRetry,
            }),
          ),
        unavailable: () =>
          renderCodeMainPanel(
            CodeMainPanelState.retry({
              title: "Code unavailable",
              description: "Link a local checkout to browse repository files.",
              onRetry,
            }),
          ),
        ready: () =>
          renderCodeMainPanel(
            CodeMainPanelState.retry({
              title: "No file selected",
              description: "Select a repository file to view its contents.",
              onRetry,
            }),
          ),
      }),
  })

const renderCodeMainPanel = (state: CodeMainPanelState) => (
  <section className="mx-auto flex min-h-full max-w-3xl flex-col justify-center px-6 py-10">
    {CodeMainPanelState.$match(state, {
      loading: ({ title, description }) => (
        <ProjectWorkspaceStatePanel
          announcement="loading"
          description={description}
          progress={{ label: title }}
          title={title}
          tone="neutral"
        />
      ),
      retry: ({ title, description, onRetry }) => (
        <ProjectWorkspaceStatePanel
          actions={
            <Button size="sm" variant="outline" onClick={onRetry}>
              Refresh
            </Button>
          }
          description={description}
          title={title}
          tone="neutral"
        />
      ),
    })}
  </section>
)
