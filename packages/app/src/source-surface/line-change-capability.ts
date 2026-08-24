import type { CodeLineChangeRange } from "@diffdash/domain/code-line-change"
import { Effect, Option } from "effect"
import { useEffect, useRef } from "react"

import {
  decodePierreNonNegativeInteger,
  SourceSurfaceContributionId,
  type SourceSurfaceRuntime,
} from "./source-surface-runtime"

const LINE_CHANGE_CAPABILITY_ID = SourceSurfaceContributionId.make(
  "diffdash.builtin.scm-line-changes",
)

/** Reconciles Git line-change decorations without changing Pierre render options. */
export const useLineChangeCapability = <Instance>(
  runtime: SourceSurfaceRuntime<Instance>,
  changes: readonly CodeLineChangeRange[],
): void => {
  const changesRef = useRef(changes)
  changesRef.current = changes

  useEffect(
    () =>
      Effect.runSync(
        runtime.registerRenderObserver(LINE_CHANGE_CAPABILITY_ID, ({ host, phase }) => {
          if (phase !== "unmount") decorateChangedCodeLines(host, changesRef.current)
        }),
      ),
    [runtime],
  )

  useEffect(() => {
    runtime.forEachRenderedHost((host) => decorateChangedCodeLines(host, changes))
  }, [changes, runtime])
}

const decorateChangedCodeLines = (
  host: HTMLElement,
  changes: readonly CodeLineChangeRange[],
): void => {
  const root = host.shadowRoot
  if (root === null) return
  const gutters = root.querySelectorAll<HTMLElement>("[data-column-number][data-line-index]")
  for (const gutter of gutters) {
    const lineIndex = decodePierreNonNegativeInteger(gutter.dataset.lineIndex)
    if (Option.isNone(lineIndex)) continue
    const lineNumber = lineIndex.value + 1
    const change = Option.fromNullishOr(
      changes.find(
        (candidate) => lineNumber >= candidate.startLine && lineNumber <= candidate.endLine,
      ),
    )
    Option.match(change, {
      onNone: () => delete gutter.dataset.codeLineChange,
      onSome: ({ kind }) => {
        gutter.dataset.codeLineChange = kind
      },
    })
  }
}
