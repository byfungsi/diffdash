import type { CodeThemePreferences } from "@diffdash/domain/ai-settings"
import type { RepositoryLanguageLocationLink } from "@diffdash/domain/language"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { Option, Schema } from "effect"
import { ArrowRight, ChevronDown, ChevronUp, FileCode2, X } from "lucide-react"
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react"

import {
  CodeView,
  type CodeViewFileItem,
  type CodeViewHandle,
  type PierreFile,
  type PierreFileDiff,
} from "@/review/pierre"
import { Button } from "@/shared/ui/button"
import { AnchoredFloatingPane } from "@/shared/ui/floating-pane"
import {
  LanguageNavigationPeekContent,
  type LanguageNavigationPeekState,
} from "@/source-surface/language-navigation-capability"
import { cn } from "@/shared/utils"
import type { ColorScheme } from "@/settings/theme"
import { keyboardShortcutLabel, useKeyboardShortcut } from "@/shell/keyboard-shortcuts"
import { formatError } from "@/shared/errors"
import { useSourceSurfaceRuntime } from "@/source-surface/source-surface-runtime"
import { useSourceSurfaceSelection } from "@/source-surface/source-surface-selection"

const DefinitionSourceState = Schema.TaggedUnion({
  idle: {},
  loading: { path: RepositoryRelativePath },
  ready: { path: RepositoryRelativePath, content: Schema.String },
  unavailable: { path: RepositoryRelativePath },
  failed: { path: RepositoryRelativePath, message: Schema.String },
})

type DefinitionSourceState = typeof DefinitionSourceState.Type

/** VS Code-style definition results tree and source preview. */
export const CodeDefinitionPeek = ({
  codeThemes,
  colorScheme,
  state,
  onClose,
  onLoadSource,
  onNavigate,
}: {
  readonly codeThemes: CodeThemePreferences
  readonly colorScheme: ColorScheme
  readonly state: LanguageNavigationPeekState
  readonly onClose: () => void
  readonly onLoadSource: (
    path: RepositoryRelativePath,
    signal: AbortSignal,
  ) => Promise<Option.Option<string>>
  readonly onNavigate: (location: RepositoryLanguageLocationLink) => void
}) =>
  LanguageNavigationPeekContent.match(state.content, {
    failure: ({ kind, message }) => (
      <AnchoredFloatingPane
        anchor={state.anchor}
        ariaLabel={`Peek ${PEEK_KIND_LABELS[kind].title} unavailable`}
        className="h-32 w-[min(32rem,calc(100vw-1rem))] border-link bg-diff-canvas"
        onClose={onClose}
      >
        <div className="flex min-h-0 flex-1 items-center justify-between gap-3 p-3 text-xs text-muted-foreground">
          <span>{message}</span>
          <Button
            aria-label="Close unavailable Peek"
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
      </AnchoredFloatingPane>
    ),
    results: (peekContent) => (
      <CodeDefinitionPeekResults
        codeThemes={codeThemes}
        colorScheme={colorScheme}
        peekContent={peekContent}
        state={state}
        onClose={onClose}
        onLoadSource={onLoadSource}
        onNavigate={onNavigate}
      />
    ),
  })

const CodeDefinitionPeekResults = ({
  codeThemes,
  colorScheme,
  peekContent,
  state,
  onClose,
  onLoadSource,
  onNavigate,
}: {
  readonly codeThemes: CodeThemePreferences
  readonly colorScheme: ColorScheme
  readonly peekContent: typeof LanguageNavigationPeekContent.cases.results.Type
  readonly state: LanguageNavigationPeekState
  readonly onClose: () => void
  readonly onLoadSource: (
    path: RepositoryRelativePath,
    signal: AbortSignal,
  ) => Promise<Option.Option<string>>
  readonly onNavigate: (location: RepositoryLanguageLocationLink) => void
}) => {
  const locations = peekContent.result.locations
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [sourceState, setSourceState] = useState<DefinitionSourceState>(() =>
    DefinitionSourceState.cases.idle.make({}),
  )
  const selected = Option.orElse(Option.fromNullishOr(locations[selectedIndex]), () =>
    Option.fromNullishOr(locations[0]),
  )
  const paneRef = useRef<HTMLDivElement>(null)
  const selectRelative = (offset: number) => {
    setSelectedIndex((current) => (current + offset + locations.length) % locations.length)
  }
  const navigateSelected = () => {
    Option.map(selected, onNavigate)
  }
  const navigateFromEffect = useEffectEvent(navigateSelected)
  const selectRelativeFromEffect = useEffectEvent(selectRelative)

  useKeyboardShortcut("code.peek.goTo", navigateSelected, {
    enabled: Option.isSome(selected),
    priority: 100,
  })
  useKeyboardShortcut("code.peek.next", () => selectRelative(1), {
    enabled: locations.length > 0,
    priority: 100,
  })
  useKeyboardShortcut("code.peek.previous", () => selectRelative(-1), {
    enabled: locations.length > 0,
    priority: 100,
  })

  useEffect(() => {
    const selectedForLoad = Option.orElse(Option.fromNullishOr(locations[selectedIndex]), () =>
      Option.fromNullishOr(locations[0]),
    )
    if (Option.isNone(selectedForLoad)) return undefined
    const path = selectedForLoad.value.target.path
    const controller = new AbortController()
    setSourceState(DefinitionSourceState.cases.loading.make({ path }))
    void onLoadSource(path, controller.signal)
      .then((content) => {
        if (!controller.signal.aborted) {
          setSourceState(
            Option.match(content, {
              onNone: () => DefinitionSourceState.cases.unavailable.make({ path }),
              onSome: (source) => DefinitionSourceState.cases.ready.make({ content: source, path }),
            }),
          )
        }
        return undefined
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setSourceState(
            DefinitionSourceState.cases.failed.make({
              path,
              message: formatError(error, "Definition preview could not be loaded."),
            }),
          )
        }
      })
    return () => {
      controller.abort()
    }
  }, [locations, onLoadSource, selectedIndex])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.key === "ArrowDown" || event.key === "ArrowUp") &&
        paneRef.current?.contains(document.activeElement)
      ) {
        event.preventDefault()
        if (event.key === "ArrowDown") selectRelativeFromEffect(1)
        else selectRelativeFromEffect(-1)
      } else if (event.key === "Enter" && paneRef.current?.contains(document.activeElement)) {
        event.preventDefault()
        navigateFromEffect()
      }
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [])

  if (Option.isNone(selected)) return null
  const selectedLocation = selected.value
  const labels = PEEK_KIND_LABELS[peekContent.kind]
  let resultNoun = "results"
  if (locations.length === 1) resultNoun = "result"
  const resultCountLabel = `${locations.length} ${resultNoun}`

  return (
    <AnchoredFloatingPane
      anchor={state.anchor}
      ariaLabel={`Peek ${labels.title}, ${resultCountLabel}`}
      className="h-72 min-h-52 w-[min(56rem,calc(100vw-1rem))] border-link bg-diff-canvas"
      onClose={onClose}
    >
      <div ref={paneRef} className="flex min-h-0 flex-1 flex-col" tabIndex={-1}>
        <header className="flex h-9 shrink-0 items-center gap-2 border-b border-link bg-card px-2">
          <FileCode2 className="size-3.5 text-link" aria-hidden="true" />
          <strong className="min-w-0 flex-1 truncate text-xs font-medium">
            {selectedLocation.target.path}
          </strong>
          <span className="text-caption text-muted-foreground">
            {labels.title} ({locations.length})
          </span>
          <Button
            aria-label={`Previous ${labels.singular}`}
            size="icon-xs"
            variant="ghost"
            onClick={() => selectRelative(-1)}
          >
            <ChevronUp />
          </Button>
          <Button
            aria-label={`Next ${labels.singular}`}
            size="icon-xs"
            variant="ghost"
            onClick={() => selectRelative(1)}
          >
            <ChevronDown />
          </Button>
          <Button
            aria-label={`Go to selected ${labels.singular}`}
            size="xs"
            title={`Go to (${keyboardShortcutLabel("code.peek.goTo")})`}
            variant="link"
            onClick={navigateSelected}
          >
            Go to
            <ArrowRight />
          </Button>
          <Button
            aria-label={`Close Peek ${labels.title}`}
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
          >
            <X />
          </Button>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(13rem,36%)_1fr]">
          <ul aria-label={`${labels.title} results`} className="overflow-auto border-r bg-card/70">
            {locations.map((location, index) => {
              const line = location.targetSelectionRange.start.line + 1
              const column = location.targetSelectionRange.start.character + 1
              return (
                <li key={`${location.target.path}:${line}:${column}`}>
                  <button
                    aria-current={index === selectedIndex ? "true" : undefined}
                    className={cn(
                      "flex w-full items-start gap-2 border-b px-2 py-2 text-left text-xs outline-none",
                      index === selectedIndex && "bg-accent text-accent-foreground",
                      index !== selectedIndex && "hover:bg-muted",
                    )}
                    type="button"
                    onClick={() => setSelectedIndex(index)}
                    onDoubleClick={() => onNavigate(location)}
                  >
                    <FileCode2
                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {fileName(location.target.path)}
                      </span>
                      <span className="text-caption text-muted-foreground block truncate font-mono">
                        {location.target.path}:{line}:{column}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          <div
            aria-label={`Preview of ${selectedLocation.target.path}`}
            className="min-w-0 overflow-hidden bg-diff-canvas"
          >
            <DefinitionPreviewContent
              codeThemes={codeThemes}
              colorScheme={colorScheme}
              selected={selectedLocation}
              sourceState={sourceState}
            />
          </div>
        </div>
      </div>
    </AnchoredFloatingPane>
  )
}

const DefinitionPreviewContent = ({
  codeThemes,
  colorScheme,
  selected,
  sourceState,
}: {
  readonly codeThemes: CodeThemePreferences
  readonly colorScheme: ColorScheme
  readonly selected: RepositoryLanguageLocationLink
  readonly sourceState: DefinitionSourceState
}) =>
  DefinitionSourceState.match(sourceState, {
    idle: () => <DefinitionPreviewStatus message="Loading preview..." />,
    loading: () => <DefinitionPreviewStatus message="Loading preview..." />,
    unavailable: () => <DefinitionPreviewStatus message="Preview unavailable" />,
    failed: ({ message }) => <DefinitionPreviewStatus message={message} />,
    ready: ({ content, path }) => {
      if (path !== selected.target.path) {
        return <DefinitionPreviewStatus message="Loading preview..." />
      }
      return (
        <DefinitionPreview
          key={`${selected.target.path}:${selected.targetSelectionRange.start.line}`}
          codeThemes={codeThemes}
          colorScheme={colorScheme}
          path={selected.target.path}
          selectedLine={selected.targetSelectionRange.start.line + 1}
          source={content}
        />
      )
    },
  })

const DefinitionPreviewStatus = ({ message }: { readonly message: string }) => (
  <div className="flex h-full items-center justify-center text-muted-foreground">{message}</div>
)

const DefinitionPreview = ({
  codeThemes,
  colorScheme,
  path,
  selectedLine,
  source,
}: {
  readonly codeThemes: CodeThemePreferences
  readonly colorScheme: ColorScheme
  readonly path: RepositoryRelativePath
  readonly selectedLine: number
  readonly source: string
}) => {
  const codeViewRef = useRef<CodeViewHandle<undefined>>(null)
  const surfaceRuntime = useSourceSurfaceRuntime<PierreFile | PierreFileDiff>()
  const surfaceSelection = useSourceSurfaceSelection(surfaceRuntime, codeViewRef)
  const publishSurfaceRender = useMemo(
    () => surfaceRuntime.createRenderPublisher(path),
    [path, surfaceRuntime],
  )
  const item = useMemo(
    () =>
      ({
        id: path,
        type: "file",
        file: { contents: source, name: path },
        version: 1,
      }) satisfies CodeViewFileItem,
    [path, source],
  )
  const items = useMemo(() => [item], [item])

  useEffect(() => {
    surfaceSelection.publish(
      "diffdash.builtin.definition-preview",
      { id: path, range: { start: selectedLine, end: selectedLine } },
      "navigationTarget",
    )
    return () => surfaceSelection.release("diffdash.builtin.definition-preview")
  }, [path, selectedLine, surfaceSelection])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      codeViewRef.current?.scrollTo({
        type: "line",
        id: path,
        lineNumber: selectedLine,
        align: "center",
        behavior: "instant",
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [path, selectedLine])

  return (
    <CodeView
      ref={codeViewRef}
      className="h-full overflow-auto bg-diff-canvas"
      items={items}
      options={{
        disableFileHeader: true,
        onPostRender: publishSurfaceRender,
        overflow: "scroll",
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
            --diffs-bg-selection-override: var(--diff-selection);
            --diffs-bg-selection-number-override: var(--diff-selection);
            --diffs-line-height: 20px;
          }
          [data-line], [data-content], [data-gutter], [data-column-number] {
            line-height: 20px !important;
            min-height: 20px !important;
          }
        `,
      }}
    />
  )
}

const fileName = (path: RepositoryRelativePath): string => path.split("/").at(-1) ?? path

const PEEK_KIND_LABELS = {
  definitions: { singular: "definition", title: "Definitions" },
  references: { singular: "reference", title: "References" },
} satisfies Readonly<
  Record<
    LanguageNavigationPeekContent["kind"],
    { readonly singular: string; readonly title: string }
  >
>
