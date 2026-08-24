import type { CodeThemePreferences } from "@diffdash/domain/ai-settings"
import type { CodeLineChangeRange } from "@diffdash/domain/code-line-change"
import {
  LanguagePosition,
  type LanguageRange,
  type RepositoryLanguageLocationResult,
} from "@diffdash/domain/language"
import type { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import type { GitCommitSha } from "@diffdash/domain/repository-comparison"
import type { ReviewRevision } from "@diffdash/domain/review-identity"
import type { ReviewProjectId } from "@diffdash/domain/review-identity"
import { Effect, Option } from "effect"
import { ChevronDown, ChevronUp, Search, X } from "lucide-react"
import { type KeyboardEvent, useEffect, useEffectEvent, useMemo, useRef, useState } from "react"

import {
  CodeView,
  type CodeViewFileItem,
  type CodeViewHandle,
  createDiffsWorker,
  type LineAnnotation,
  type PierreFile,
  type PierreFileDiff,
  useStableCallback,
  WorkerPoolContextProvider,
  type WorkerPoolOptions,
  useWorkerPool,
} from "@/review/pierre"
import type {
  CodeSourceContribution,
  OwnedExtensionContribution,
} from "@/extensions/extension-registry"
import { isHTMLElement } from "@/shared/dom"
import { Button } from "@/shared/ui/button"
import { Input } from "@/shared/ui/input"
import type { ColorScheme } from "@/settings/theme"
import {
  type CodeSourceHostAnnotation,
  useCodeSourceContributionHost,
} from "@/source-surface/code-source-contribution-host"
import { useLineChangeCapability } from "@/source-surface/line-change-capability"
import {
  type CodeSearchHighlightMatch,
  useCodeSearchHighlightCapability,
} from "@/source-surface/code-search-highlight-capability"
import {
  isLanguageNavigationInteraction,
  type LanguageNavigationDestination,
  useLanguageNavigationCapability,
} from "@/source-surface/language-navigation-capability"
import {
  SourceSurfaceContributionId,
  type SourceSurfaceInteractionRoute,
  useSourceSurfaceHost,
  useSourceSurfaceRuntime,
} from "@/source-surface/source-surface-runtime"
import { useSourceSurfaceSelection } from "@/source-surface/source-surface-selection"

import { CodeDefinitionPeek } from "./code-definition-peek"

const CODE_VIEW_WORKER_POOL_OPTIONS = {
  poolSize: 1,
  totalASTLRUCacheSize: 20,
  workerFactory: createDiffsWorker,
} satisfies WorkerPoolOptions

const CODE_COMMENTS_CAPABILITY_ID = SourceSurfaceContributionId.make(
  "diffdash.host.code-source-contributions",
)

type CodeSurfaceInstance =
  | PierreFile<CodeSourceHostAnnotation>
  | PierreFileDiff<CodeSourceHostAnnotation>

/** Read-only Pierre CodeView for one file from the active checkout. */
export const CodeFileViewer = ({
  codeThemes,
  colorScheme,
  contents,
  contributions = EMPTY_CODE_SOURCE_CONTRIBUTIONS,
  gitRevision = Option.none(),
  path,
  projectId,
  revision,
  onLoadDefinitionSource,
  onNavigateToDefinition,
  onRequestDefinitions,
  onRequestReferences,
  definitionNavigation = Option.none(),
  lineChanges = EMPTY_LINE_CHANGES,
  onDefinitionNavigationHandled,
}: {
  readonly codeThemes: CodeThemePreferences
  readonly colorScheme: ColorScheme
  readonly contents: string
  readonly contributions?: readonly OwnedExtensionContribution<CodeSourceContribution>[]
  readonly gitRevision?: Option.Option<GitCommitSha>
  readonly path: RepositoryRelativePath
  readonly projectId: ReviewProjectId
  readonly revision: ReviewRevision
  readonly onLoadDefinitionSource?: (
    path: RepositoryRelativePath,
    signal: AbortSignal,
  ) => Promise<Option.Option<string>>
  readonly onNavigateToDefinition?: (destination: LanguageNavigationDestination) => void
  readonly onRequestDefinitions?: (
    position: LanguagePosition,
    signal: AbortSignal,
  ) => Promise<RepositoryLanguageLocationResult>
  readonly onRequestReferences?: (
    position: LanguagePosition,
    signal: AbortSignal,
  ) => Promise<RepositoryLanguageLocationResult>
  readonly definitionNavigation?: Option.Option<{
    readonly id: number
    readonly range: LanguageRange
  }>
  readonly lineChanges?: readonly CodeLineChangeRange[]
  readonly onDefinitionNavigationHandled?: (id: number) => void
}) => {
  const codeViewRef = useRef<CodeViewHandle<CodeSourceHostAnnotation>>(null)
  const scrollRootRef = useRef<HTMLDivElement>(null)
  const surfaceRuntime = useSourceSurfaceRuntime<CodeSurfaceInstance>()
  const publishSurfaceRender = useMemo(
    () => surfaceRuntime.createRenderPublisher(path),
    [path, surfaceRuntime],
  )
  useSourceSurfaceHost(surfaceRuntime, scrollRootRef)
  useLineChangeCapability(surfaceRuntime, lineChanges)
  const codeSource = useMemo(
    () => ({ projectId, workspaceRevision: revision, gitRevision, path }),
    [gitRevision, path, projectId, revision],
  )
  const codeSourceHost = useCodeSourceContributionHost(contributions, codeSource)
  const surfaceSelection = useSourceSurfaceSelection(surfaceRuntime, codeViewRef)
  const languageNavigation = useLanguageNavigationCapability({
    navigate: Option.fromNullishOr(onNavigateToDefinition),
    providers: {
      definitions: Option.fromNullishOr(onRequestDefinitions),
      references: Option.fromNullishOr(onRequestReferences),
    },
    rootRef: scrollRootRef,
    runtime: surfaceRuntime,
    surfaceId: path,
  })
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [activeMatchIndex, setActiveMatchIndex] = useState(0)
  const versionRef = useRef({ contents, path, generation: codeSourceHost.generation, version: 0 })
  if (
    versionRef.current.contents !== contents ||
    versionRef.current.path !== path ||
    versionRef.current.generation !== codeSourceHost.generation
  ) {
    versionRef.current = {
      contents,
      path,
      generation: codeSourceHost.generation,
      version: versionRef.current.version + 1,
    }
  }
  const version = versionRef.current.version
  const annotations: readonly LineAnnotation<CodeSourceHostAnnotation>[] =
    codeSourceHost.annotations
  const item = useMemo(() => {
    return {
      id: path,
      type: "file",
      file: { contents, name: path },
      annotations: [...annotations],
      version,
    } satisfies CodeViewFileItem<CodeSourceHostAnnotation>
  }, [annotations, contents, path, version])
  const items = useMemo(() => [item], [item])
  const searchMatches = useMemo(
    () => findCodeSearchMatches(contents, searchQuery),
    [contents, searchQuery],
  )
  const normalizedActiveMatchIndex = Math.min(
    activeMatchIndex,
    Math.max(0, searchMatches.length - 1),
  )
  const activeMatch = Option.fromNullishOr(searchMatches[normalizedActiveMatchIndex])
  useCodeSearchHighlightCapability(surfaceRuntime, searchMatches, activeMatch)
  const focusSearch = () => {
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    })
  }
  const openSearch = () => {
    setSearchOpen(true)
    focusSearch()
  }
  const closeSearch = () => {
    setSearchOpen(false)
    surfaceSelection.release("diffdash.builtin.code-search")
  }
  const moveSearch = (direction: -1 | 1) => {
    if (searchMatches.length === 0) return
    setActiveMatchIndex(
      (index) => (index + direction + searchMatches.length) % searchMatches.length,
    )
  }
  const openSearchFromEffect = useEffectEvent(openSearch)
  const closeSearchFromEffect = useEffectEvent(closeSearch)
  const moveSearchFromEffect = useEffectEvent(moveSearch)
  const handleCommentLineClick = useStableCallback<SourceSurfaceInteractionRoute["handle"]>(
    ({ event, lineNumber }) => {
      if (isLanguageNavigationInteraction(event) || isInteractiveSurfaceControl(event)) return false
      return codeSourceHost.activateLine(lineNumber, contents.split("\n")[lineNumber - 1] ?? "")
    },
  )

  useEffect(() => {
    return Effect.runSync(
      surfaceRuntime.registerInteractionRoute({
        id: CODE_COMMENTS_CAPABILITY_ID,
        phase: "lineAction",
        handle: handleCommentLineClick,
      }),
    )
  }, [handleCommentLineClick, surfaceRuntime])

  useEffect(() => {
    const scrollRoot = scrollRootRef.current
    if (scrollRoot === null) return undefined
    scrollRoot.dataset.codeFileScroll = ""
    scrollRoot.tabIndex = 0
    scrollRoot.setAttribute("role", "region")
    scrollRoot.setAttribute(
      "aria-label",
      `Source code for ${path}. Use arrow keys to select a line and Enter to activate a line action.`,
    )
    const lineCount = Math.max(1, contents.split("\n").length)
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.target !== scrollRoot || !["ArrowUp", "ArrowDown", "Enter"].includes(event.key)) {
        return
      }
      const selected = codeViewRef.current?.getSelectedLines()
      const currentLine = selected?.range.start ?? 1
      if (event.key === "Enter") {
        event.preventDefault()
        codeSourceHost.activateLine(currentLine, contents.split("\n")[currentLine - 1] ?? "")
        return
      }
      event.preventDefault()
      let direction = -1
      if (event.key === "ArrowDown") direction = 1
      const lineNumber = Math.min(lineCount, Math.max(1, currentLine + direction))
      surfaceSelection.publish(
        "diffdash.builtin.keyboard-navigation",
        { id: path, range: { start: lineNumber, end: lineNumber } },
        "passiveSelection",
      )
      codeViewRef.current?.scrollTo({
        type: "line",
        id: path,
        lineNumber,
        align: "center",
        behavior: "instant",
      })
    }
    scrollRoot.addEventListener("keydown", onKeyDown)
    return () => {
      scrollRoot.removeEventListener("keydown", onKeyDown)
      surfaceSelection.release("diffdash.builtin.keyboard-navigation")
    }
  }, [codeSourceHost, contents, path, surfaceSelection])

  useEffect(() => {
    const handleSearchShortcut = (event: globalThis.KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if ((event.metaKey || event.ctrlKey) && !event.altKey && key === "f") {
        event.preventDefault()
        event.stopPropagation()
        openSearchFromEffect()
        return
      }
      if (searchOpen && (event.metaKey || event.ctrlKey) && !event.altKey && key === "g") {
        event.preventDefault()
        event.stopPropagation()
        if (event.shiftKey) moveSearchFromEffect(-1)
        else moveSearchFromEffect(1)
        return
      }
      if (searchOpen && key === "escape") {
        event.preventDefault()
        event.stopPropagation()
        closeSearchFromEffect()
      }
    }
    window.addEventListener("keydown", handleSearchShortcut, true)
    return () => window.removeEventListener("keydown", handleSearchShortcut, true)
  }, [searchOpen])

  useEffect(() => {
    return Option.match(activeMatch, {
      onNone: () => {
        surfaceSelection.release("diffdash.builtin.code-search")
        return undefined
      },
      onSome: (match) => {
        surfaceSelection.publish(
          "diffdash.builtin.code-search",
          { id: path, range: { start: match.lineNumber, end: match.lineNumber } },
          "searchResult",
        )
        codeViewRef.current?.scrollTo({
          type: "line",
          id: path,
          lineNumber: match.lineNumber,
          align: "center",
          behavior: "instant",
        })
        return () => surfaceSelection.release("diffdash.builtin.code-search")
      },
    })
  }, [activeMatch, path, surfaceSelection])

  useEffect(() => {
    return Option.match(definitionNavigation, {
      onNone: () => {
        surfaceSelection.release("diffdash.builtin.definition-navigation")
        return undefined
      },
      onSome: (navigation) => {
        const start = navigation.range.start.line + 1
        const end = navigation.range.end.line + 1
        surfaceSelection.publish(
          "diffdash.builtin.definition-navigation",
          { id: path, range: { start, end } },
          "navigationTarget",
        )
        codeViewRef.current?.scrollTo({
          type: "line",
          id: path,
          lineNumber: start,
          align: "center",
          behavior: "instant",
        })
        onDefinitionNavigationHandled?.(navigation.id)
        return () => surfaceSelection.release("diffdash.builtin.definition-navigation")
      },
    })
  }, [definitionNavigation, onDefinitionNavigationHandled, path, surfaceSelection])

  return (
    <WorkerPoolContextProvider
      highlighterOptions={{
        lineDiffType: "word",
        maxLineDiffLength: 1_000,
        theme: codeThemes,
        tokenizeMaxLineLength: 2_000,
        useTokenTransformer: true,
      }}
      poolOptions={CODE_VIEW_WORKER_POOL_OPTIONS}
    >
      <CodeViewThemeSync codeThemes={codeThemes} />
      {codeSourceHost.mounts}
      <div className="relative flex h-full min-h-0 flex-col bg-diff-canvas">
        {searchOpen ? (
          <CodeSearchToolbar
            activeIndex={normalizedActiveMatchIndex}
            inputRef={searchInputRef}
            matchCount={searchMatches.length}
            query={searchQuery}
            onClose={closeSearch}
            onNext={() => moveSearch(1)}
            onPrevious={() => moveSearch(-1)}
            onQueryChange={(query) => {
              setSearchQuery(query)
              setActiveMatchIndex(0)
            }}
          />
        ) : null}
        <CodeView<CodeSourceHostAnnotation>
          ref={codeViewRef}
          containerRef={scrollRootRef}
          className="h-0 min-h-0 flex-1 overflow-auto bg-diff-canvas"
          items={items}
          options={{
            disableFileHeader: false,
            onTokenEnter: languageNavigation.onTokenEnter,
            onTokenLeave: languageNavigation.onTokenLeave,
            lineHoverHighlight: "line",
            overflow: "scroll",
            stickyHeaders: true,
            theme: codeThemes,
            themeType: colorScheme,
            tokenizeMaxLineLength: 2_000,
            unsafeCSS: `
            :host {
              --diffs-bg: var(--diff-canvas);
              --diffs-fg-number-override: var(--muted-foreground);
              --diffs-bg-context-override: var(--diff-canvas);
              --diffs-bg-context-gutter-override: var(--diff-gutter);
              --diffs-bg-buffer-override: var(--diff-canvas);
              --diffs-bg-hover-override: var(--diff-hover);
              --diffs-line-height: 20px;
            }
            [data-line], [data-content], [data-gutter], [data-column-number] {
              line-height: 20px !important;
              min-height: 20px !important;
            }
            ::highlight(diffdash-code-search-match) {
              background-color: var(--review-search-match);
              color: inherit;
            }
            ::highlight(diffdash-code-search-active) {
              background-color: var(--review-search-active);
              color: var(--review-search-active-foreground);
            }
            [data-diffdash-definition-link] {
              color: var(--link) !important;
              cursor: pointer;
              text-decoration: underline;
            }
            [data-column-number][data-code-line-change="added"] {
              background-image: linear-gradient(var(--review-success-text), var(--review-success-text));
              background-position: right top;
              background-repeat: no-repeat;
              background-size: 3px 100%;
            }
            [data-column-number][data-code-line-change="modified"] {
              background-image: repeating-linear-gradient(
                -45deg,
                var(--review-modified-text) 0 1px,
                transparent 1px 3px
              );
              background-position: right top;
              background-repeat: no-repeat;
              background-size: 3px 100%;
            }
            [data-column-number][data-code-line-change="deleted"] {
              background-image: linear-gradient(
                to bottom right,
                transparent 48%,
                var(--review-danger-text) 50%
              );
              background-position: right top;
              background-repeat: no-repeat;
              background-size: 5px 5px;
            }
          `,
            onPostRender: publishSurfaceRender,
          }}
          renderAnnotation={(annotation) =>
            codeSourceHost.renderAnnotation(annotation.metadata.contributionKey)
          }
        />
        {Option.match(
          Option.product(Option.fromNullishOr(onLoadDefinitionSource), languageNavigation.peek),
          {
            onNone: () => null,
            onSome: ([loadSource, peek]) => (
              <CodeDefinitionPeek
                key={peek.id}
                codeThemes={codeThemes}
                colorScheme={colorScheme}
                state={peek}
                onClose={languageNavigation.closePeek}
                onLoadSource={loadSource}
                onNavigate={(location) => {
                  languageNavigation.closePeek()
                  Option.map(Option.fromNullishOr(onNavigateToDefinition), (navigate) =>
                    navigate({ location, origin: peek.origin }),
                  )
                }}
              />
            ),
          },
        )}
      </div>
    </WorkerPoolContextProvider>
  )
}

const EMPTY_LINE_CHANGES: readonly CodeLineChangeRange[] = []
const EMPTY_CODE_SOURCE_CONTRIBUTIONS: readonly OwnedExtensionContribution<CodeSourceContribution>[] =
  []

const isInteractiveSurfaceControl = (event: MouseEvent): boolean =>
  event
    .composedPath()
    .some(
      (candidate) =>
        isHTMLElement(candidate) &&
        candidate.matches("a, button, input, select, textarea, [role=button]"),
    )

const CodeSearchToolbar = ({
  activeIndex,
  inputRef,
  matchCount,
  query,
  onClose,
  onNext,
  onPrevious,
  onQueryChange,
}: {
  readonly activeIndex: number
  readonly inputRef: React.RefObject<HTMLInputElement | null>
  readonly matchCount: number
  readonly query: string
  readonly onClose: () => void
  readonly onNext: () => void
  readonly onPrevious: () => void
  readonly onQueryChange: (query: string) => void
}) => {
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === "Enter") {
      event.preventDefault()
      if (event.shiftKey) onPrevious()
      else onNext()
    }
  }
  return (
    <div className="shrink-0 border-b px-5 py-2">
      <search
        aria-label="Search current file"
        className="bg-card ml-auto flex h-8 w-full max-w-md items-center gap-1 rounded-lg border px-1 shadow-xs"
      >
        <Search className="text-muted-foreground ml-1 size-3.5" aria-hidden="true" />
        <Input
          ref={inputRef}
          aria-label="Search current file"
          className="h-7 flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
          placeholder="Search file"
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />
        <span className="text-caption text-muted-foreground min-w-14 px-1 text-right font-mono tabular-nums">
          {query.length === 0 || matchCount === 0 ? "0 / 0" : `${activeIndex + 1} / ${matchCount}`}
        </span>
        <Button size="icon-xs" variant="ghost" aria-label="Previous match" onClick={onPrevious}>
          <ChevronUp />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Next match" onClick={onNext}>
          <ChevronDown />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Close search" onClick={onClose}>
          <X />
        </Button>
      </search>
    </div>
  )
}

const findCodeSearchMatches = (
  contents: string,
  query: string,
): readonly CodeSearchHighlightMatch[] => {
  if (query.length === 0) return []
  const needle = query.toLocaleLowerCase()
  const matches: CodeSearchHighlightMatch[] = []
  contents.split("\n").forEach((line, lineIndex) => {
    const haystack = line.toLocaleLowerCase()
    let start = haystack.indexOf(needle)
    while (start !== -1) {
      matches.push({ start, end: start + query.length, lineNumber: lineIndex + 1 })
      start = haystack.indexOf(needle, start + query.length)
    }
  })
  return matches
}

const CodeViewThemeSync = ({ codeThemes }: { readonly codeThemes: CodeThemePreferences }) => {
  const workerPool = useWorkerPool()

  useEffect(() => {
    if (workerPool === undefined) return
    void workerPool.setRenderOptions({ theme: codeThemes }).catch(() => {})
  }, [codeThemes, workerPool])

  return null
}
