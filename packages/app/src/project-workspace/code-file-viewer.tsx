import type { CodeThemePreferences } from "@diffdash/domain/ai-settings"
import type { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ChevronDown, ChevronUp, Search, X } from "lucide-react"
import { type KeyboardEvent, useEffect, useEffectEvent, useMemo, useRef, useState } from "react"

import {
  CodeView,
  type CodeViewFileItem,
  type CodeViewHandle,
  createDiffsWorker,
  WorkerPoolContextProvider,
  type WorkerPoolOptions,
  useWorkerPool,
} from "@/review/pierre"
import { isTextNode } from "@/shared/dom"
import { Button } from "@/shared/ui/button"
import { Input } from "@/shared/ui/input"
import type { ColorScheme } from "@/settings/theme"

const CODE_VIEW_WORKER_POOL_OPTIONS = {
  poolSize: 1,
  totalASTLRUCacheSize: 20,
  workerFactory: createDiffsWorker,
} satisfies WorkerPoolOptions

const CODE_SEARCH_MATCH_HIGHLIGHT = "diffdash-code-search-match"
const CODE_SEARCH_ACTIVE_HIGHLIGHT = "diffdash-code-search-active"

type CodeSearchMatch = {
  readonly end: number
  readonly lineNumber: number
  readonly start: number
}

/** Read-only Pierre CodeView for one file from the active checkout. */
export const CodeFileViewer = ({
  codeThemes,
  colorScheme,
  contents,
  path,
}: {
  readonly codeThemes: CodeThemePreferences
  readonly colorScheme: ColorScheme
  readonly contents: string
  readonly path: RepositoryRelativePath
}) => {
  const codeViewRef = useRef<CodeViewHandle<undefined>>(null)
  const scrollRootRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [activeMatchIndex, setActiveMatchIndex] = useState(0)
  const versionRef = useRef({ contents, path, version: 0 })
  if (versionRef.current.contents !== contents || versionRef.current.path !== path) {
    versionRef.current = { contents, path, version: versionRef.current.version + 1 }
  }
  const version = versionRef.current.version
  const item = useMemo(() => {
    return {
      id: path,
      type: "file",
      file: { contents, name: path },
      version,
    } satisfies CodeViewFileItem
  }, [contents, path, version])
  const items = useMemo(() => [item], [item])
  const searchMatches = useMemo(
    () => findCodeSearchMatches(contents, searchQuery),
    [contents, searchQuery],
  )
  const normalizedActiveMatchIndex = Math.min(
    activeMatchIndex,
    Math.max(0, searchMatches.length - 1),
  )
  const activeMatch = searchMatches[normalizedActiveMatchIndex]
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
    codeViewRef.current?.clearSelectedLines()
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

  useEffect(() => {
    const scrollRoot = scrollRootRef.current
    if (scrollRoot !== null) scrollRoot.dataset.codeFileScroll = ""
  }, [])

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
        moveSearchFromEffect(event.shiftKey ? -1 : 1)
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
    if (activeMatch === undefined) {
      codeViewRef.current?.clearSelectedLines()
      return
    }
    codeViewRef.current?.setSelectedLines({
      id: path,
      range: { start: activeMatch.lineNumber, end: activeMatch.lineNumber },
    })
    codeViewRef.current?.scrollTo({
      type: "line",
      id: path,
      lineNumber: activeMatch.lineNumber,
      align: "center",
      behavior: "instant",
    })
  }, [activeMatch, path])

  useEffect(() => {
    const root = scrollRootRef.current
    if (root === null || searchMatches.length === 0 || !supportsCustomHighlights()) return undefined
    let frame: number | null = null
    let observer: MutationObserver | null = null
    let matchHighlight: Highlight | null = null
    let activeHighlight: Highlight | null = null
    let retries = 8

    const clearHighlights = () => {
      if (CSS.highlights.get(CODE_SEARCH_MATCH_HIGHLIGHT) === matchHighlight) {
        CSS.highlights.delete(CODE_SEARCH_MATCH_HIGHLIGHT)
      }
      if (CSS.highlights.get(CODE_SEARCH_ACTIVE_HIGHLIGHT) === activeHighlight) {
        CSS.highlights.delete(CODE_SEARCH_ACTIVE_HIGHLIGHT)
      }
    }
    const rebuild = () => {
      frame = null
      const host = root.querySelector("diffs-container")
      const shadowRoot = host?.shadowRoot
      if (shadowRoot === null || shadowRoot === undefined) {
        if (retries > 0) {
          retries -= 1
          frame = window.requestAnimationFrame(rebuild)
        }
        return
      }
      if (observer === null) {
        observer = new MutationObserver(rebuild)
        observer.observe(shadowRoot, { characterData: true, childList: true, subtree: true })
      }
      clearHighlights()
      const matches: StaticRange[] = []
      const active: StaticRange[] = []
      searchMatches.forEach((match, index) => {
        const row = shadowRoot.querySelector<HTMLElement>(
          `[data-content] > [data-line][data-line-index="${match.lineNumber - 1}"]`,
        )
        if (row === null) return
        const range = createStaticTextRange(row, match.start, match.end)
        if (range === null) return
        if (index === normalizedActiveMatchIndex) active.push(range)
        else matches.push(range)
      })
      matchHighlight = matches.length === 0 ? null : new Highlight(...matches)
      activeHighlight = active.length === 0 ? null : new Highlight(...active)
      if (matchHighlight !== null) {
        CSS.highlights.set(CODE_SEARCH_MATCH_HIGHLIGHT, matchHighlight)
      }
      if (activeHighlight !== null) {
        activeHighlight.priority = 1
        CSS.highlights.set(CODE_SEARCH_ACTIVE_HIGHLIGHT, activeHighlight)
      }
    }
    frame = window.requestAnimationFrame(rebuild)
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      observer?.disconnect()
      clearHighlights()
    }
  }, [normalizedActiveMatchIndex, searchMatches])

  return (
    <WorkerPoolContextProvider
      highlighterOptions={{
        lineDiffType: "word",
        maxLineDiffLength: 1_000,
        theme: codeThemes,
        tokenizeMaxLineLength: 2_000,
      }}
      poolOptions={CODE_VIEW_WORKER_POOL_OPTIONS}
    >
      <CodeViewThemeSync codeThemes={codeThemes} />
      <div className="flex h-full min-h-0 flex-col bg-diff-canvas">
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
        <CodeView
          ref={codeViewRef}
          containerRef={scrollRootRef}
          className="h-0 min-h-0 flex-1 overflow-auto bg-diff-canvas"
          items={items}
          options={{
            disableFileHeader: false,
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
          `,
          }}
        />
      </div>
    </WorkerPoolContextProvider>
  )
}

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

const findCodeSearchMatches = (contents: string, query: string): readonly CodeSearchMatch[] => {
  if (query.length === 0) return []
  const needle = query.toLocaleLowerCase()
  const matches: CodeSearchMatch[] = []
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

const createStaticTextRange = (
  row: HTMLElement,
  startOffset: number,
  endOffset: number,
): StaticRange | null => {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  let offset = 0
  let start: { readonly node: Text; readonly offset: number } | null = null
  while (node !== null) {
    if (isTextNode(node)) {
      const nextOffset = offset + node.data.length
      if (start === null && startOffset <= nextOffset) {
        start = { node, offset: startOffset - offset }
      }
      if (start !== null && endOffset <= nextOffset) {
        return new StaticRange({
          startContainer: start.node,
          startOffset: start.offset,
          endContainer: node,
          endOffset: endOffset - offset,
        })
      }
      offset = nextOffset
    }
    node = walker.nextNode()
  }
  return null
}

const supportsCustomHighlights = () =>
  globalThis.CSS !== undefined &&
  "highlights" in globalThis.CSS &&
  globalThis.Highlight !== undefined &&
  globalThis.StaticRange !== undefined

const CodeViewThemeSync = ({ codeThemes }: { readonly codeThemes: CodeThemePreferences }) => {
  const workerPool = useWorkerPool()

  useEffect(() => {
    if (workerPool === undefined) return
    void workerPool.setRenderOptions({ theme: codeThemes }).catch(() => {})
  }, [codeThemes, workerPool])

  return null
}
