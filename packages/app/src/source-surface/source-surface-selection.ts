import { Effect, HashMap, Option, Ref, Schema } from "effect"
import { useEffect, useState, type RefObject } from "react"

import { SourceSurfaceContributionId, type SourceSurfaceRuntime } from "./source-surface-runtime"

const SOURCE_SURFACE_SELECTION_ID = SourceSurfaceContributionId.make("diffdash.kernel.selection")

/** One line selection accepted by a Pierre source surface. */
export const SourceSurfaceLineSelection = Schema.Struct({
  id: Schema.String,
  range: Schema.Struct({ end: Schema.Int, start: Schema.Int }),
})

/** One line selection accepted by a Pierre source surface. */
export type SourceSurfaceLineSelection = typeof SourceSurfaceLineSelection.Type

/** Semantic precedence used when multiple capabilities request the shared selection channel. */
export const SourceSurfaceSelectionPriority = Schema.Literals([
  "passiveSelection",
  "commentDraft",
  "searchResult",
  "navigationTarget",
  "focusedInteraction",
])

/** Semantic precedence used when multiple capabilities request the shared selection channel. */
export type SourceSurfaceSelectionPriority = typeof SourceSurfaceSelectionPriority.Type

/** Owner-scoped interface for publishing and releasing source-surface selections. */
export interface SourceSurfaceSelectionCoordinator {
  readonly publish: (
    owner: string,
    selection: SourceSurfaceLineSelection,
    priority: SourceSurfaceSelectionPriority,
  ) => void
  readonly release: (owner: string) => void
}

interface SourceSurfaceSelectionSink {
  readonly clearSelectedLines: () => void
  readonly setSelectedLines: (selection: SourceSurfaceLineSelection) => void
}

interface OwnedSelection {
  readonly priority: SourceSurfaceSelectionPriority
  readonly revision: number
  readonly selection: SourceSurfaceLineSelection
}

const SELECTION_PRIORITY: Readonly<Record<SourceSurfaceSelectionPriority, number>> = {
  passiveSelection: 0,
  commentDraft: 1,
  searchResult: 2,
  navigationTarget: 3,
  focusedInteraction: 4,
}

/** Coordinates Pierre's single line-selection channel across independently owned capabilities. */
export const useSourceSurfaceSelection = <Instance>(
  runtime: SourceSurfaceRuntime<Instance>,
  sinkRef: RefObject<SourceSurfaceSelectionSink | null>,
): SourceSurfaceSelectionCoordinator => {
  const [coordinator] = useState(
    () => new SelectionCoordinator(() => Option.fromNullishOr(sinkRef.current)),
  )

  useEffect(
    () =>
      Effect.runSync(
        runtime.registerRenderObserver(SOURCE_SURFACE_SELECTION_ID, ({ phase }) => {
          if (phase !== "unmount") coordinator.reconcile()
        }),
      ),
    [coordinator, runtime],
  )
  useEffect(() => () => coordinator.dispose(), [coordinator])

  return coordinator
}

class SelectionCoordinator implements SourceSurfaceSelectionCoordinator {
  private readonly intents = Ref.makeUnsafe(HashMap.empty<string, OwnedSelection>())
  private readonly revision = Ref.makeUnsafe(0)

  constructor(private readonly getSink: () => Option.Option<SourceSurfaceSelectionSink>) {}

  readonly publish = (
    owner: string,
    selection: SourceSurfaceLineSelection,
    priority: SourceSurfaceSelectionPriority,
  ): void => {
    const revision = Ref.getUnsafe(this.revision) + 1
    Effect.runSync(
      Effect.all([
        Ref.set(this.revision, revision),
        Ref.update(this.intents, HashMap.set(owner, { priority, revision, selection })),
      ]),
    )
    this.reconcile()
  }

  readonly release = (owner: string): void => {
    if (!HashMap.has(Ref.getUnsafe(this.intents), owner)) return
    Effect.runSync(Ref.update(this.intents, HashMap.remove(owner)))
    this.reconcile()
  }

  reconcile(): void {
    const sink = this.getSink()
    if (Option.isNone(sink)) return
    let active = Option.none<OwnedSelection>()
    for (const candidate of HashMap.values(Ref.getUnsafe(this.intents))) {
      if (
        Option.isNone(active) ||
        SELECTION_PRIORITY[candidate.priority] > SELECTION_PRIORITY[active.value.priority] ||
        (candidate.priority === active.value.priority && candidate.revision > active.value.revision)
      ) {
        active = Option.some(candidate)
      }
    }
    Option.match(active, {
      onNone: sink.value.clearSelectedLines,
      onSome: ({ selection }) => sink.value.setSelectedLines(selection),
    })
  }

  dispose(): void {
    Effect.runSync(Ref.set(this.intents, HashMap.empty()))
  }
}
