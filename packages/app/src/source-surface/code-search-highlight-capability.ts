import { Effect, Option, Ref, Schema } from "effect"
import { useEffect, useState } from "react"

import { SourceSurfaceContributionId, type SourceSurfaceRuntime } from "./source-surface-runtime"
import { isTextNode } from "@/shared/dom"

const CODE_SEARCH_CAPABILITY_ID = SourceSurfaceContributionId.make(
  "diffdash.builtin.code-search-highlights",
)
const CODE_SEARCH_MATCH_HIGHLIGHT = "diffdash-code-search-match"
const CODE_SEARCH_ACTIVE_HIGHLIGHT = "diffdash-code-search-active"

interface CodeSearchOwnedHighlights {
  readonly active: readonly StaticRange[]
  readonly inactive: readonly StaticRange[]
}

interface CodeSearchHighlightOwner {
  readonly owner: string
  readonly read: () => CodeSearchOwnedHighlights
}

const codeSearchHighlightOwners = Ref.makeUnsafe<readonly CodeSearchHighlightOwner[]>([])
const codeSearchHighlightOwnerSequence = Ref.makeUnsafe(0)

interface CodeSearchObserverRegistration {
  readonly host: HTMLElement
  readonly observer: MutationObserver
}

/** One source-text range matched by in-file search. */
export const CodeSearchHighlightMatch = Schema.Struct({
  end: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  lineNumber: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  start: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
})

/** One source-text range matched by in-file search. */
export type CodeSearchHighlightMatch = typeof CodeSearchHighlightMatch.Type

/** Reconciles in-file search highlights across current and future virtualized source mounts. */
export const useCodeSearchHighlightCapability = <Instance>(
  runtime: SourceSurfaceRuntime<Instance>,
  matches: readonly CodeSearchHighlightMatch[],
  activeMatch: Option.Option<CodeSearchHighlightMatch>,
): void => {
  const [highlightOwner] = useState(
    () =>
      `code-search-highlight-${String(Effect.runSync(Ref.updateAndGet(codeSearchHighlightOwnerSequence, (sequence) => sequence + 1)))}`,
  )
  useEffect(() => {
    if (matches.length === 0 || !supportsCustomHighlights()) return undefined
    const observers = Ref.makeUnsafe<readonly CodeSearchObserverRegistration[]>([])
    let frame = Option.none<number>()
    const rebuild = () => {
      frame = Option.none()
      const inactiveRanges: StaticRange[] = []
      const activeRanges: StaticRange[] = []
      runtime.forEachRenderedHost((host) => {
        const root = host.shadowRoot
        if (root === null) return
        if (!Ref.getUnsafe(observers).some((registration) => registration.host === host)) {
          const observer = new MutationObserver(scheduleRebuild)
          observer.observe(root, { characterData: true, childList: true, subtree: true })
          Effect.runSync(Ref.update(observers, (registered) => [...registered, { host, observer }]))
        }
        matches.forEach((match) => {
          const row = root.querySelector<HTMLElement>(
            `[data-content] > [data-line][data-line-index="${String(match.lineNumber - 1)}"]`,
          )
          if (row === null) return
          Option.map(createStaticTextRange(row, match.start, match.end), (range) => {
            if (Option.contains(activeMatch, match)) activeRanges.push(range)
            else inactiveRanges.push(range)
          })
        })
      })
      const ownedHighlights: CodeSearchOwnedHighlights = {
        active: activeRanges,
        inactive: inactiveRanges,
      }
      Effect.runSync(
        Ref.update(codeSearchHighlightOwners, (owners) => [
          ...owners.filter((entry) => entry.owner !== highlightOwner),
          { owner: highlightOwner, read: () => ownedHighlights },
        ]),
      )
      reconcileCodeSearchHighlights()
    }
    function scheduleRebuild(): void {
      if (Option.isNone(frame)) frame = Option.some(window.requestAnimationFrame(rebuild))
    }

    const disposeRenderObserver = Effect.runSync(
      runtime.registerRenderObserver(CODE_SEARCH_CAPABILITY_ID, ({ host, phase }) => {
        if (phase === "unmount") {
          Option.map(
            Option.fromNullishOr(
              Ref.getUnsafe(observers).find((registration) => registration.host === host),
            ),
            ({ observer }) => observer.disconnect(),
          )
          Effect.runSync(
            Ref.update(observers, (registered) =>
              registered.filter((registration) => registration.host !== host),
            ),
          )
        }
        scheduleRebuild()
      }),
    )
    scheduleRebuild()
    return () => {
      disposeRenderObserver()
      Option.map(frame, (frameId) => window.cancelAnimationFrame(frameId))
      for (const { observer } of Ref.getUnsafe(observers)) observer.disconnect()
      Effect.runSync(
        Ref.update(codeSearchHighlightOwners, (owners) =>
          owners.filter((entry) => entry.owner !== highlightOwner),
        ),
      )
      reconcileCodeSearchHighlights()
    }
  }, [activeMatch, highlightOwner, matches, runtime])
}

const reconcileCodeSearchHighlights = (): void => {
  const inactiveRanges: StaticRange[] = []
  const activeRanges: StaticRange[] = []
  for (const { read } of Ref.getUnsafe(codeSearchHighlightOwners)) {
    const { active, inactive } = read()
    inactiveRanges.push(...inactive)
    activeRanges.push(...active)
  }
  if (inactiveRanges.length === 0) CSS.highlights.delete(CODE_SEARCH_MATCH_HIGHLIGHT)
  else CSS.highlights.set(CODE_SEARCH_MATCH_HIGHLIGHT, new Highlight(...inactiveRanges))
  if (activeRanges.length === 0) {
    CSS.highlights.delete(CODE_SEARCH_ACTIVE_HIGHLIGHT)
  } else {
    const activeHighlight = new Highlight(...activeRanges)
    activeHighlight.priority = 1
    CSS.highlights.set(CODE_SEARCH_ACTIVE_HIGHLIGHT, activeHighlight)
  }
}

const createStaticTextRange = (
  row: HTMLElement,
  startOffset: number,
  endOffset: number,
): Option.Option<StaticRange> => {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  let offset = 0
  let start = Option.none<{ readonly node: Text; readonly offset: number }>()
  while (node !== null) {
    if (isTextNode(node)) {
      const nextOffset = offset + node.data.length
      if (Option.isNone(start) && startOffset <= nextOffset) {
        start = Option.some({ node, offset: startOffset - offset })
      }
      if (Option.isSome(start) && endOffset <= nextOffset) {
        return Option.some(
          new StaticRange({
            startContainer: start.value.node,
            startOffset: start.value.offset,
            endContainer: node,
            endOffset: endOffset - offset,
          }),
        )
      }
      offset = nextOffset
    }
    node = walker.nextNode()
  }
  return Option.none()
}

const supportsCustomHighlights = () =>
  globalThis.CSS !== undefined &&
  "highlights" in globalThis.CSS &&
  globalThis.Highlight !== undefined &&
  globalThis.StaticRange !== undefined
