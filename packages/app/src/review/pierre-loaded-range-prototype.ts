import type {
  DiffLineAnnotation,
  FileDiffMetadata,
  FileDiffOptions,
  PostRenderPhase,
  RenderRange,
  SelectionSide,
} from "@pierre/diffs"
import { PierreRangeFileDiff } from "./pierre"

/** Identity required before asynchronous range or syntax output may be published. */
export type PierreRangeIdentity = {
  readonly projectId: string
  readonly processEpoch: string
  readonly snapshotGeneration: string
  readonly sessionEpoch: string
  readonly requestId: string
  readonly width: number
  readonly mode: "unified" | "split"
}

/** Heavy owners that must be released together when a loaded range is evicted. */
export type PierreRangeOwnerKind =
  | "text"
  | "highlight"
  | "ast-output"
  | "dom-container"
  | "annotation"
  | "observer"
  | "measurement"
  | "reservation"
  | "worker"

/** One independently accounted resource held by a loaded range. */
export type PierreRangeOwner = {
  readonly kind: PierreRangeOwnerKind
  readonly bytes: number
  readonly release: () => void
}

/** Plain range payload followed by an optional identity-equivalent syntax payload. */
export type PierreLoadedRange<Annotation> = {
  readonly identity: PierreRangeIdentity
  readonly semanticKey: string
  readonly fileDiff: FileDiffMetadata
  readonly renderRange: RenderRange
  readonly annotations: readonly DiffLineAnnotation<Annotation>[]
  readonly owners: readonly PierreRangeOwner[]
}

/** State published by the latest-wins partial-range coordinator. */
export type PierreRangePublication<Annotation> = {
  readonly phase: "plain" | "highlighted"
  readonly range: PierreLoadedRange<Annotation>
}

/** Request contract for cancellable range loading and deferred syntax. */
export type PierreRangeRequest<Annotation> = {
  readonly identity: PierreRangeIdentity
  readonly estimatedHeight: number
  readonly load: (signal: AbortSignal) => Promise<PierreLoadedRange<Annotation>>
  readonly highlight?: (
    plain: PierreLoadedRange<Annotation>,
    signal: AbortSignal,
  ) => Promise<PierreLoadedRange<Annotation>>
}

/** Releases all owners exactly once and reports their accounted bytes. */
export class PierreRangeOwnership {
  readonly bytes: number
  private released = false

  constructor(private readonly owners: readonly PierreRangeOwner[]) {
    this.bytes = owners.reduce((total, owner) => total + owner.bytes, 0)
  }

  /** Releases every range owner, continuing even if one cleanup fails. */
  release(): void {
    if (this.released) return
    this.released = true
    const failedOwnerKinds: PierreRangeOwnerKind[] = []
    for (const owner of this.owners) {
      try {
        owner.release()
      } catch {
        failedOwnerKinds.push(owner.kind)
      }
    }
    if (failedOwnerKinds.length > 0) {
      throw new AggregateError(
        failedOwnerKinds.map((kind) => new Error(`Could not release Pierre ${kind} owner`)),
        "Could not release Pierre range",
      )
    }
  }
}

/** Byte-bounded LRU for coordinated range ownership. */
export class PierreRangeOwnershipCache {
  private readonly entries = new Map<string, PierreRangeOwnership>()
  private retainedBytes = 0

  constructor(private readonly byteBudget: number) {
    if (!Number.isSafeInteger(byteBudget) || byteBudget < 0) {
      throw new RangeError("Pierre ownership byte budget must be a non-negative safe integer")
    }
  }

  /** Inserts one range and evicts least-recent owners until the budget is met. */
  set(key: string, ownership: PierreRangeOwnership): void {
    this.delete(key)
    this.entries.set(key, ownership)
    this.retainedBytes += ownership.bytes
    while (this.retainedBytes > this.byteBudget) {
      const oldest = this.entries.entries().next().value
      if (oldest === undefined) break
      const [oldestKey] = oldest
      this.delete(oldestKey)
    }
  }

  /** Marks an existing range as most recently used. */
  touch(key: string): void {
    const ownership = this.entries.get(key)
    if (ownership === undefined) return
    this.entries.delete(key)
    this.entries.set(key, ownership)
  }

  /** Evicts one range and all of its owners. */
  delete(key: string): void {
    const ownership = this.entries.get(key)
    if (ownership === undefined) return
    this.entries.delete(key)
    this.retainedBytes -= ownership.bytes
    ownership.release()
  }

  /** Releases all retained ranges. */
  clear(): void {
    const keys = [...this.entries.keys()]
    for (const key of keys) this.delete(key)
  }

  /** Current bytes retained by all owners. */
  get bytes(): number {
    return this.retainedBytes
  }
}

/** Latest-wins range scheduler with plain-first publication and inverse-sticky replacement. */
export class PierrePartialRangeCoordinator<Annotation> {
  private operation = 0
  private rangeAbort: AbortController | null = null
  private highlightAbort: AbortController | null = null
  private retained: PierreRangeOwnership | null = null

  constructor(
    private readonly callbacks: {
      readonly onPrimeShell: (identity: PierreRangeIdentity, estimatedHeight: number) => void
      readonly onPublish: (publication: PierreRangePublication<Annotation>) => void
    },
  ) {}

  /** Cancels stale work, primes far-target geometry, then publishes plain and syntax in order. */
  request(request: PierreRangeRequest<Annotation>): void {
    this.cancelPending()
    const operation = ++this.operation
    const rangeAbort = new AbortController()
    this.rangeAbort = rangeAbort
    this.callbacks.onPrimeShell(request.identity, request.estimatedHeight)

    void request.load(rangeAbort.signal).then(
      (plain) => {
        if (!this.isCurrent(operation, request.identity, plain.identity) || rangeAbort.signal.aborted) {
          releaseRange(plain)
          return undefined
        }
        this.rangeAbort = null
        const ownership = new PierreRangeOwnership(plain.owners)
        const previous = this.retained
        this.retained = ownership
        this.callbacks.onPublish({ phase: "plain", range: plain })
        previous?.release()
        if (request.highlight === undefined) return undefined

        const highlightAbort = new AbortController()
        this.highlightAbort = highlightAbort
        void request.highlight(plain, highlightAbort.signal).then(
          (highlighted) => {
            if (
              !this.isCurrent(operation, request.identity, highlighted.identity) ||
              highlightAbort.signal.aborted ||
              highlighted.semanticKey !== plain.semanticKey
            ) {
                releaseRange(highlighted)
                return undefined
            }
            this.highlightAbort = null
            const highlightedOwnership = new PierreRangeOwnership(highlighted.owners)
            this.retained = highlightedOwnership
              this.callbacks.onPublish({ phase: "highlighted", range: highlighted })
              ownership.release()
              return undefined
          },
          () => undefined,
          )
          return undefined
      },
      () => undefined,
    )
  }

  /** Cancels pending work while retaining the visible range until replacement is ready. */
  cancelPending(): void {
    this.operation += 1
    this.rangeAbort?.abort()
    this.highlightAbort?.abort()
    this.rangeAbort = null
    this.highlightAbort = null
  }

  /** Cancels work and releases the currently visible range. */
  dispose(): void {
    this.cancelPending()
    this.retained?.release()
    this.retained = null
  }

  private isCurrent(
    operation: number,
    requested: PierreRangeIdentity,
    delivered: PierreRangeIdentity,
  ): boolean {
    return operation === this.operation && samePierreRangeIdentity(requested, delivered)
  }
}

/** A public-Pierre-API renderer for one already-loaded bounded range. */
export class PierreLoadedRangeRenderer<Annotation> {
  private instance: PierreRangeFileDiff<Annotation> | null = null
  private observer: ResizeObserver | null = null
  private lastHeight = 0

  constructor(
    private readonly container: HTMLElement,
    private readonly onHeightDelta: (delta: number, height: number) => void,
  ) {}

  /** Renders plain text immediately using Pierre's public render-range API. */
  renderPlain(
    range: PierreLoadedRange<Annotation>,
    options: FileDiffOptions<Annotation>,
  ): PierreRangeFileDiff<Annotation> {
    this.reset()
    const instance = new PierreRangeFileDiff<Annotation>({
      ...options,
      diffStyle: range.identity.mode,
      tokenizeMaxLength: 0,
      onPostRender: this.postRender(options.onPostRender),
    })
    instance.render({
      fileContainer: this.container,
      fileDiff: range.fileDiff,
      lineAnnotations: [...range.annotations],
      renderRange: range.renderRange,
    })
    this.instance = instance
    this.observeHeight()
    return instance
  }

  /** Replaces plain output with identity-equivalent syntax without changing coordinates. */
  async renderHighlighted(
    range: PierreLoadedRange<Annotation>,
    options: FileDiffOptions<Annotation>,
  ): Promise<void> {
    const instance = this.instance
    if (instance === null) return
    instance.setOptions({
      ...options,
      diffStyle: range.identity.mode,
      onPostRender: this.postRender(options.onPostRender),
    })
    await instance.primeHighlightCache(range.fileDiff)
    if (instance !== this.instance) return
    instance.render({
      fileDiff: range.fileDiff,
      lineAnnotations: [...range.annotations],
      renderRange: range.renderRange,
    })
  }

  /** Resolves a semantic line through Pierre without reading its DOM internals. */
  getLineIndex(lineNumber: number, side: SelectionSide): readonly number[] | undefined {
    return this.instance?.getLineIndex(lineNumber, side)
  }

  /** Fully resets Pierre, observers, and the reusable host before pooling. */
  reset(): void {
    this.observer?.disconnect()
    this.observer = null
    this.instance?.cleanUp()
    this.instance = null
    this.lastHeight = 0
    this.container.replaceChildren()
    for (const attribute of Array.from(this.container.attributes)) {
      if (attribute.name !== "class") this.container.removeAttribute(attribute.name)
    }
    this.container.removeAttribute("style")
  }

  private observeHeight(): void {
    this.reportHeight()
    if (globalThis.ResizeObserver === undefined) return
    this.observer = new globalThis.ResizeObserver(() => this.reportHeight())
    this.observer.observe(this.container)
  }

  private reportHeight(): void {
    const height = this.container.getBoundingClientRect().height
    const delta = height - this.lastHeight
    this.lastHeight = height
    if (delta !== 0) this.onHeightDelta(delta, height)
  }

  private postRender(
    callback: FileDiffOptions<Annotation>["onPostRender"],
  ): NonNullable<FileDiffOptions<Annotation>["onPostRender"]> {
    return (node, instance, phase: PostRenderPhase) => {
      callback?.(node, instance, phase)
      queueMicrotask(() => {
        if (instance === this.instance || this.instance === null) this.reportHeight()
      })
    }
  }
}

/** Preserves a visible anchor when a measured item above it changes height. */
export const retainInverseStickyAnchor = ({
  anchorTop,
  itemTop,
  measuredDelta,
  scrollTop,
}: {
  readonly anchorTop: number
  readonly itemTop: number
  readonly measuredDelta: number
  readonly scrollTop: number
}): number => (itemTop < anchorTop ? Math.max(0, scrollTop + measuredDelta) : scrollTop)

/** Maps an unbounded logical offset into a bounded browser scroll page. */
export const rebaseLogicalScroll = (
  logicalTop: number,
  pageHeight: number,
): { readonly pageOrigin: number; readonly physicalTop: number } => {
  if (!Number.isFinite(logicalTop) || logicalTop < 0 || !Number.isFinite(pageHeight) || pageHeight <= 0) {
    throw new RangeError("Logical scroll values must be finite and non-negative")
  }
  const pageOrigin = Math.floor(logicalTop / pageHeight) * pageHeight
  return { pageOrigin, physicalTop: logicalTop - pageOrigin }
}

/** Exact latest-request identity comparison. */
export const samePierreRangeIdentity = (
  left: PierreRangeIdentity,
  right: PierreRangeIdentity,
): boolean =>
  left.projectId === right.projectId &&
  left.processEpoch === right.processEpoch &&
  left.snapshotGeneration === right.snapshotGeneration &&
  left.sessionEpoch === right.sessionEpoch &&
  left.requestId === right.requestId &&
  left.width === right.width &&
  left.mode === right.mode

const releaseRange = <Annotation>(range: PierreLoadedRange<Annotation>) =>
  new PierreRangeOwnership(range.owners).release()
