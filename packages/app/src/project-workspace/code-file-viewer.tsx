import type { CodeThemePreferences } from "@diffdash/domain/ai-settings"
import type { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { useEffect, useMemo, useRef } from "react"

import {
  CodeView,
  type CodeViewFileItem,
  createDiffsWorker,
  WorkerPoolContextProvider,
  type WorkerPoolOptions,
  useWorkerPool,
} from "@/review/pierre"
import type { ColorScheme } from "@/settings/theme"

const CODE_VIEW_WORKER_POOL_OPTIONS = {
  poolSize: 1,
  totalASTLRUCacheSize: 20,
  workerFactory: createDiffsWorker,
} satisfies WorkerPoolOptions

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
      <CodeView
        className="h-full min-h-0 bg-diff-canvas"
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
          `,
        }}
      />
    </WorkerPoolContextProvider>
  )
}

const CodeViewThemeSync = ({ codeThemes }: { readonly codeThemes: CodeThemePreferences }) => {
  const workerPool = useWorkerPool()

  useEffect(() => {
    if (workerPool === undefined) return
    void workerPool.setRenderOptions({ theme: codeThemes }).catch(() => {})
  }, [codeThemes, workerPool])

  return null
}
