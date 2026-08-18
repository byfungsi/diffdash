import type {
  DiffLineAnnotation,
  FileDiffMetadata,
  FileDiffOptions,
  PostRenderPhase,
  RenderRange,
  SelectionSide,
  VirtualFileMetrics,
} from "./pierre"
import { type DiffVirtualizer, PierreRangeFileDiff, VirtualizedFileDiff } from "./pierre"
import type { ReviewCacheResource } from "./review-global-virtualizer"
import { ReviewRendererCaches, ReviewShellPool } from "./review-global-virtualizer"

/** Exact identity required before loaded or highlighted range output may publish. */
export type PierreRangeIdentity = {
  readonly projectId: string
  readonly processEpoch: string
  readonly snapshotGeneration: string
  readonly sessionEpoch: string
  readonly rangeKey: string
  readonly requestId: string
  readonly width: number
  readonly mode: "unified" | "split"
}

/** One bounded range translated to Pierre's public rendering contracts. */
export type PierreLoadedRange<Annotation> = {
  readonly identity: PierreRangeIdentity
  readonly fileDiff: FileDiffMetadata
  readonly renderRange: RenderRange
  readonly annotations: readonly DiffLineAnnotation<Annotation>[]
  readonly resources: readonly ReviewCacheResource[]
}

/** Deferred syntax result whose resources contain only newly acquired syntax owners. */
export type PierreHighlightedRange<Annotation> = PierreLoadedRange<Annotation>

/** Cancellable plain-first request consumed by the loaded-range adapter. */
export type PierreRangeRequest<Annotation> = {
  readonly identity: PierreRangeIdentity
  readonly estimatedHeight: number
  readonly load: (signal: AbortSignal) => Promise<PierreLoadedRange<Annotation>>
  readonly highlight?: (
    plain: PierreLoadedRange<Annotation>,
    signal: AbortSignal,
  ) => Promise<PierreHighlightedRange<Annotation>>
}

/** A mounted range published from a pooled Pierre shell. */
export type PierreRangePublication<Annotation> = {
  readonly phase: "plain" | "highlighted"
  readonly range: PierreLoadedRange<Annotation>
  readonly container: HTMLElement
  readonly renderer: PierreLoadedRangeRenderer<Annotation>
}

/** Optional production virtualization dependencies shared by every pooled range shell. */
export type PierreRangeVirtualization = {
  readonly virtualizer: DiffVirtualizer
  readonly metrics: Partial<VirtualFileMetrics>
  readonly workerManager?: ConstructorParameters<typeof VirtualizedFileDiff>[3]
}

/** Accounted host resources created by the adapter rather than the range loader. */
export type PierreShellResourceBytes = {
  readonly domContainer: number
  readonly observer: number
  readonly measurement: number
}

/** Event boundary used to connect the feature-local adapter to an outer virtualizer. */
export type PierreLoadedRangeAdapterCallbacks<Annotation> = {
  readonly onPrimeShell: (identity: PierreRangeIdentity, estimatedHeight: number) => void
  readonly onPublish: (publication: PierreRangePublication<Annotation>) => void
  readonly onHeightChange: (identity: PierreRangeIdentity, delta: number, height: number) => void
}

/** One reusable Pierre host. Acquire and release it only through its shell pool. */
export type PierreRangeShell<Annotation> = {
  readonly container: HTMLElement
  readonly renderer: PierreLoadedRangeRenderer<Annotation>
}

/** Public-Pierre-API renderer for one already-loaded bounded range. */
export class PierreLoadedRangeRenderer<Annotation> {
  private instance: PierreRangeFileDiff<Annotation> | VirtualizedFileDiff<Annotation> | null = null
  private virtualizedInstance: VirtualizedFileDiff<Annotation> | null = null
  private observer: ResizeObserver | null = null
  private lastHeight = 0
  private onHeightDelta: ((delta: number, height: number) => void) | null = null

  constructor(
    readonly container: HTMLElement,
    private readonly virtualization?: PierreRangeVirtualization,
  ) {}

  /** Renders plain text synchronously and starts measured-height feedback. */
  renderPlain(
    range: PierreLoadedRange<Annotation>,
    options: FileDiffOptions<Annotation>,
    onHeightDelta: (delta: number, height: number) => void,
  ): PierreRangeFileDiff<Annotation> | VirtualizedFileDiff<Annotation> {
    this.reset()
    this.onHeightDelta = onHeightDelta
    const resolvedOptions = {
      ...options,
      diffStyle: range.identity.mode,
      tokenizeMaxLength: 0,
      onPostRender: this.postRender(options.onPostRender),
    }
    const virtualizedInstance =
      this.virtualization === undefined
        ? null
        : new VirtualizedFileDiff<Annotation>(
            resolvedOptions,
            this.virtualization.virtualizer,
            this.virtualization.metrics,
            this.virtualization.workerManager,
          )
    const instance = virtualizedInstance ?? new PierreRangeFileDiff<Annotation>(resolvedOptions)
    this.instance = instance
    this.virtualizedInstance = virtualizedInstance
    instance.render(
      virtualizedInstance === null
        ? {
            fileContainer: this.container,
            fileDiff: range.fileDiff,
            lineAnnotations: [...range.annotations],
            renderRange: range.renderRange,
          }
        : {
            fileContainer: this.container,
            fileDiff: range.fileDiff,
            lineAnnotations: [...range.annotations],
          },
    )
    this.observeHeight()
    return instance
  }

  /** Primes and paints syntax on the current shell only while its lease remains current. */
  async renderHighlighted(
    range: PierreHighlightedRange<Annotation>,
    options: FileDiffOptions<Annotation>,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    const instance = this.instance
    if (instance === null || !isCurrent()) return false
    instance.setOptions({
      ...options,
      diffStyle: range.identity.mode,
      onPostRender: this.postRender(options.onPostRender),
    })
    await instance.primeHighlightCache(range.fileDiff)
    if (instance !== this.instance || !isCurrent()) return false
    instance.render(
      this.virtualizedInstance === null
        ? {
            fileDiff: range.fileDiff,
            lineAnnotations: [...range.annotations],
            renderRange: range.renderRange,
          }
        : {
            fileDiff: range.fileDiff,
            lineAnnotations: [...range.annotations],
          },
    )
    return true
  }

  /** Resolves source coordinates through Pierre's documented semantic lookup. */
  getLineIndex(lineNumber: number, side: SelectionSide): readonly number[] | undefined {
    return this.instance?.getLineIndex(lineNumber, side)
  }

  /** Returns the live virtualized instance when this shell participates in viewport navigation. */
  getVirtualizedInstance(): VirtualizedFileDiff<Annotation> | null {
    return this.virtualizedInstance
  }

  /** Activates a virtualized shell after its pooled container enters the live scroll surface. */
  activateVirtualized(): void {
    const instance = this.virtualizedInstance
    if (instance === null) return
    instance.setVisibility(true)
  }

  /** Disconnects measured-height observation without otherwise changing the shell. */
  releaseObserver(): void {
    this.observer?.disconnect()
    this.observer = null
  }

  /** Stops measurement publication and drops the previous-height baseline. */
  releaseMeasurement(): void {
    this.onHeightDelta = null
    this.lastHeight = 0
  }

  /** Removes Pierre state and all host residue before pooling or destruction. */
  reset(): void {
    this.releaseObserver()
    this.releaseMeasurement()
    this.instance?.cleanUp()
    this.instance = null
    this.virtualizedInstance = null
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
    if (delta !== 0) this.onHeightDelta?.(delta, height)
  }

  private postRender(
    callback: FileDiffOptions<Annotation>["onPostRender"],
  ): NonNullable<FileDiffOptions<Annotation>["onPostRender"]> {
    return (node, instance, phase: PostRenderPhase) => {
      callback?.(node, instance, phase)
      queueMicrotask(() => {
        if (instance === this.instance) this.reportHeight()
      })
    }
  }
}

/** Creates a bounded pool whose reset contract removes all Pierre and host state. */
export const createPierreRangeShellPool = <Annotation>(
  maximum: number,
  virtualization?: PierreRangeVirtualization,
): ReviewShellPool<PierreRangeShell<Annotation>> =>
  new ReviewShellPool<PierreRangeShell<Annotation>>(maximum, {
    create: (): PierreRangeShell<Annotation> => {
      const container = document.createElement("diffs-container")
      return {
        container,
        renderer: new PierreLoadedRangeRenderer<Annotation>(container, virtualization),
      }
    },
    reset: (shell) => shell.renderer.reset(),
    destroy: (shell) => {
      shell.renderer.reset()
      shell.container.remove()
    },
  })

type ActiveRange<Annotation> = {
  readonly cacheKey: string
  readonly identity: PierreRangeIdentity
  readonly shell: PierreRangeShell<Annotation>
  active: boolean
}

/** Coordinates cancellable loading, pooled rendering, and whole-range cache ownership. */
export class PierreLoadedRangeAdapter<Annotation> {
  private operation = 0
  private rangeAbort: AbortController | null = null
  private highlightAbort: AbortController | null = null
  private current: ActiveRange<Annotation> | null = null

  constructor(
    private readonly caches: ReviewRendererCaches,
    private readonly shells: ReviewShellPool<PierreRangeShell<Annotation>>,
    private readonly shellResourceBytes: PierreShellResourceBytes,
    private readonly options: (identity: PierreRangeIdentity) => FileDiffOptions<Annotation>,
    private readonly callbacks: PierreLoadedRangeAdapterCallbacks<Annotation>,
  ) {
    validateShellResourceBytes(shellResourceBytes)
  }

  /** Primes target geometry, then publishes plain text and matching deferred syntax. */
  request(request: PierreRangeRequest<Annotation>): void {
    this.cancelPending()
    const operation = ++this.operation
    const rangeAbort = new AbortController()
    this.rangeAbort = rangeAbort
    this.callbacks.onPrimeShell(request.identity, request.estimatedHeight)

    void request
      .load(rangeAbort.signal)
      .then(
        (plain) => this.publishPlain(operation, request, rangeAbort, plain),
        () => undefined,
      )
      .catch(() => undefined)
  }

  /** Aborts pending range and syntax work while retaining the currently visible shell. */
  cancelPending(): void {
    this.operation += 1
    this.rangeAbort?.abort()
    this.highlightAbort?.abort()
    this.rangeAbort = null
    this.highlightAbort = null
  }

  /** Cancels pending work and evicts this adapter's visible range. */
  dispose(): void {
    this.cancelPending()
    const current = this.current
    this.current = null
    if (current !== null) this.caches.delete(current.cacheKey)
  }

  private publishPlain(
    operation: number,
    request: PierreRangeRequest<Annotation>,
    rangeAbort: AbortController,
    plain: PierreLoadedRange<Annotation>,
  ): void {
    if (!this.isCurrent(operation, request.identity, plain.identity) || rangeAbort.signal.aborted) {
      releaseResources(plain.resources)
      return
    }
    this.rangeAbort = null
    const previous = this.current
    const shell = this.shells.acquire()
    const cacheKey = pierreRangeCacheKey(plain.identity)
    const active: ActiveRange<Annotation> = {
      cacheKey,
      identity: plain.identity,
      shell,
      active: true,
    }
    try {
      shell.renderer.renderPlain(plain, this.options(plain.identity), (delta, height) => {
        if (active.active && this.isCurrent(operation, request.identity, active.identity)) {
          this.callbacks.onHeightChange(active.identity, delta, height)
        }
      })
      this.caches.put(cacheKey, [
        ...plain.resources,
        {
          kind: "observer",
          bytes: this.shellResourceBytes.observer,
          release: () => shell.renderer.releaseObserver(),
        },
        {
          kind: "measurement",
          bytes: this.shellResourceBytes.measurement,
          release: () => shell.renderer.releaseMeasurement(),
        },
        {
          kind: "dom-container",
          bytes: this.shellResourceBytes.domContainer,
          release: () => {
            if (!active.active) return
            active.active = false
            this.shells.release(shell)
          },
        },
      ])
    } catch {
      if (active.active) {
        active.active = false
        try {
          releaseResources(plain.resources)
        } finally {
          this.shells.release(shell)
        }
      }
      return
    }
    if (!active.active || !this.isCurrent(operation, request.identity, plain.identity)) return
    this.current = active
    this.callbacks.onPublish({ phase: "plain", range: plain, ...shell })
    shell.renderer.activateVirtualized()
    if (previous !== null && previous.cacheKey !== active.cacheKey) {
      this.caches.delete(previous.cacheKey)
    }
    if (request.highlight === undefined || !active.active) return

    const highlightAbort = new AbortController()
    this.highlightAbort = highlightAbort
    void request
      .highlight(plain, highlightAbort.signal)
      .then(
        (highlighted) =>
          this.publishHighlighted(operation, request, active, highlightAbort, highlighted),
        () => undefined,
      )
      .catch(() => undefined)
  }

  private async publishHighlighted(
    operation: number,
    request: PierreRangeRequest<Annotation>,
    active: ActiveRange<Annotation>,
    highlightAbort: AbortController,
    highlighted: PierreHighlightedRange<Annotation>,
  ): Promise<void> {
    const isCurrent = () =>
      active.active &&
      this.current === active &&
      !highlightAbort.signal.aborted &&
      this.isCurrent(operation, request.identity, highlighted.identity)
    if (!isCurrent()) {
      releaseResources(highlighted.resources)
      return
    }
    this.highlightAbort = null
    this.caches.add(active.cacheKey, highlighted.resources)
    if (!isCurrent()) return
    const rendered = await active.shell.renderer.renderHighlighted(
      highlighted,
      this.options(highlighted.identity),
      isCurrent,
    )
    if (!rendered || !isCurrent()) return
    this.callbacks.onPublish({ phase: "highlighted", range: highlighted, ...active.shell })
  }

  private isCurrent(
    operation: number,
    requested: PierreRangeIdentity,
    delivered: PierreRangeIdentity,
  ): boolean {
    return operation === this.operation && samePierreRangeIdentity(requested, delivered)
  }
}

/** Exact identity comparison, including the bounded semantic range. */
export const samePierreRangeIdentity = (
  left: PierreRangeIdentity,
  right: PierreRangeIdentity,
): boolean =>
  left.projectId === right.projectId &&
  left.processEpoch === right.processEpoch &&
  left.snapshotGeneration === right.snapshotGeneration &&
  left.sessionEpoch === right.sessionEpoch &&
  left.rangeKey === right.rangeKey &&
  left.requestId === right.requestId &&
  left.width === right.width &&
  left.mode === right.mode

/** Stable cache key for one exact loaded-range request identity. */
export const pierreRangeCacheKey = (identity: PierreRangeIdentity): string =>
  JSON.stringify([
    identity.projectId,
    identity.processEpoch,
    identity.snapshotGeneration,
    identity.sessionEpoch,
    identity.rangeKey,
    identity.requestId,
    identity.width,
    identity.mode,
  ])

const validateShellResourceBytes = (bytes: PierreShellResourceBytes): void => {
  for (const value of [bytes.domContainer, bytes.observer, bytes.measurement]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("Pierre shell bytes must be non-negative safe integers")
    }
  }
}

const releaseResources = (resources: readonly ReviewCacheResource[]): void => {
  const failures: Error[] = []
  for (const resource of resources) {
    try {
      resource.release()
    } catch (error) {
      failures.push(new Error(`Could not release ${resource.kind}`, { cause: error }))
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Could not release Pierre range")
}
