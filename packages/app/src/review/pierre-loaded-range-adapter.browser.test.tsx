import { getSingularPatch } from "./pierre"
import {
  createPierreRangeShellPool,
  type PierreHighlightedRange,
  type PierreLoadedRange,
  PierreLoadedRangeAdapter,
  pierreRangeCacheKey,
  type PierreRangeIdentity,
  type PierreRangePublication,
} from "./pierre-loaded-range-adapter"
import {
  type ReviewCacheKind,
  type ReviewCacheResource,
  ReviewRendererCaches,
} from "./review-global-virtualizer"
import { afterEach, describe, expect, it, vi } from "vitest"

const PATCH = `diff --git a/src/range.ts b/src/range.ts
index 1111111..2222222 100644
--- a/src/range.ts
+++ b/src/range.ts
@@ -40,4 +50,4 @@ export function range() {
-  const searchable = "old value with a deliberately long wrapping suffix"
+  const searchable = "new value with a deliberately long wrapping suffix"
   return searchable
 }
`

const cacheBudgets: Readonly<Record<ReviewCacheKind, number>> = {
  text: 100,
  "syntax-ast": 100,
  "syntax-output": 100,
  annotation: 100,
  observer: 100,
  measurement: 100,
  reservation: 100,
  worker: 100,
  "dom-container": 100,
  prefetch: 100,
  pin: 100,
}

const originalResizeObserver = Object.getOwnPropertyDescriptor(window, "ResizeObserver")
const resizeObservers = new Set<TestResizeObserver>()

afterEach(() => {
  resizeObservers.clear()
  document.body.replaceChildren()
  CSS.highlights.clear()
  if (originalResizeObserver === undefined) {
    Reflect.deleteProperty(window, "ResizeObserver")
  } else {
    Object.defineProperty(window, "ResizeObserver", originalResizeObserver)
  }
})

describe("PierreLoadedRangeAdapter", () => {
  it.each([
    "unified",
    "split",
  ] as const)("interacts with bounded %s syntax, wrapping, search, and thread annotations", async (mode) => {
    installResizeObserver()
    const phases: string[] = []
    const heights: [number, number][] = []
    const pools = createPierreRangeShellPool<string>(1)
    const caches = new ReviewRendererCaches(cacheBudgets)
    const syntax = deferred<PierreHighlightedRange<string>>()
    const publications: PierreRangePublication<string>[] = []
    let threadActivations = 0
    let measuredHeight = 80
    const requestIdentity = makeIdentity(mode, `request-${mode}`, "range-40-50")
    const adapter = new PierreLoadedRangeAdapter(
      caches,
      pools,
      { domContainer: 5, observer: 1, measurement: 2 },
      () => ({
        disableFileHeader: true,
        overflow: "wrap",
        renderAnnotation: (annotation) => {
          const button = document.createElement("button")
          button.textContent = `Open thread ${annotation.lineNumber}`
          button.addEventListener("click", () => {
            threadActivations += 1
          })
          return button
        },
        onPostRender: (_node, _instance, phase) => {
          phases.push(`pierre:${phase}`)
        },
      }),
      {
        onPrimeShell: (_identity, estimatedHeight) => phases.push(`prime:${estimatedHeight}`),
        onPublish: (publication) => {
          phases.push(publication.phase)
          publications.push(publication)
          publication.container.getBoundingClientRect = () =>
            new DOMRect(0, 0, requestIdentity.width, measuredHeight)
          if (!publication.container.isConnected) document.body.append(publication.container)
        },
        onHeightChange: (_identity, delta, height) => heights.push([delta, height]),
      },
    )

    adapter.request({
      identity: requestIdentity,
      estimatedHeight: 640,
      load: async () => makeRange(requestIdentity, plainResources()),
      highlight: async () => syntax.promise,
    })

    await vi.waitFor(() => expect(phases).toContain("plain"))
    const plainPublication = publications[0]
    if (plainPublication === undefined) throw new Error("Expected a published Pierre range")
    const { container, renderer } = plainPublication
    expect(phases[0]).toBe("prime:640")
    expect(phases).not.toContain("highlighted")
    expect(renderedText(container)).toContain("old value")
    expect(renderedText(container)).toContain("new value")
    expect(container.textContent).toContain("Open thread 50")
    expect(findHostTextRange(container, "new value")?.toString()).toBe("new value")
    const button = findElementAcrossShadowRoots(container, "button")
    expect(button).not.toBeNull()
    button?.click()
    expect(threadActivations).toBe(1)

    const oldCoordinate = renderer.getLineIndex(40, "deletions")
    const newCoordinate = renderer.getLineIndex(50, "additions")
    syntax.resolve(makeRange(requestIdentity, syntaxResources()))
    await vi.waitFor(() => expect(phases).toContain("highlighted"))
    expect(renderedText(container)).toContain("new value")
    expect(findHostTextRange(container, "new value")?.toString()).toBe("new value")
    expect(renderer.getLineIndex(40, "deletions")).toEqual(oldCoordinate)
    expect(renderer.getLineIndex(50, "additions")).toEqual(newCoordinate)

    measuredHeight = 132
    for (const observer of resizeObservers) observer.emit()
    await vi.waitFor(() => expect(heights).toContainEqual([52, 132]))
    adapter.dispose()
    expect(pools.size).toBe(1)
  })

  it("rejects stale reversal and deferred syntax output, then releases every owner on eviction", async () => {
    const releases: string[] = []
    const phases: string[] = []
    const firstLoad = deferred<PierreLoadedRange<string>>()
    const firstSyntax = deferred<PierreHighlightedRange<string>>()
    const secondLoad = deferred<PierreLoadedRange<string>>()
    const caches = new ReviewRendererCaches(cacheBudgets)
    const pools = createPierreRangeShellPool<string>(1)
    const firstIdentity = makeIdentity("unified", "forward", "range-forward")
    const secondIdentity = makeIdentity("unified", "reverse", "range-reverse")
    const signals: AbortSignal[] = []
    const adapter = new PierreLoadedRangeAdapter(
      caches,
      pools,
      { domContainer: 5, observer: 1, measurement: 2 },
      () => ({ disableFileHeader: true }),
      {
        onPrimeShell: (identity) => phases.push(`prime:${identity.requestId}`),
        onPublish: ({ phase, range, container }) => {
          phases.push(`${phase}:${range.identity.requestId}`)
          if (!container.isConnected) document.body.append(container)
        },
        onHeightChange: () => undefined,
      },
    )

    adapter.request({
      identity: firstIdentity,
      estimatedHeight: 100,
      load: (signal) => {
        signals.push(signal)
        return firstLoad.promise
      },
      highlight: async () => firstSyntax.promise,
    })
    adapter.request({
      identity: secondIdentity,
      estimatedHeight: 200,
      load: () => secondLoad.promise,
      highlight: async () => makeRange(secondIdentity, syntaxResources(releases)),
    })
    expect(signals[0]?.aborted).toBe(true)
    firstLoad.resolve(makeRange(firstIdentity, [resource("text", "stale-text", releases)]))
    await vi.waitFor(() => expect(releases).toContain("stale-text"))
    expect(phases).not.toContain("plain:forward")

    secondLoad.resolve(makeRange(secondIdentity, allPlainResources(releases)))
    await vi.waitFor(() => expect(phases).toContain("plain:reverse"))
    await vi.waitFor(() => expect(phases).toContain("highlighted:reverse"))
    firstSyntax.resolve(makeRange(firstIdentity, syntaxResources(releases)))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(phases).not.toContain("highlighted:forward")

    caches.delete(pierreRangeCacheKey(secondIdentity))
    expect(releases).toEqual(
      expect.arrayContaining([
        "text",
        "syntax-ast",
        "syntax-output",
        "annotation",
        "reservation",
        "worker",
      ]),
    )
    for (const kind of Object.keys(cacheBudgets) as ReviewCacheKind[]) {
      expect(caches.bytes(kind)).toBe(0)
    }
    expect(pools.size).toBe(1)
    adapter.dispose()
  })

  it("cancels syntax after plain publication when direction reverses", async () => {
    const phases: string[] = []
    const firstSyntax = deferred<PierreHighlightedRange<string>>()
    const secondLoad = deferred<PierreLoadedRange<string>>()
    const firstIdentity = makeIdentity("unified", "first", "range-first")
    const secondIdentity = makeIdentity("unified", "second", "range-second")
    const syntaxSignals: AbortSignal[] = []
    const adapter = new PierreLoadedRangeAdapter(
      new ReviewRendererCaches(cacheBudgets),
      createPierreRangeShellPool<string>(1),
      { domContainer: 5, observer: 1, measurement: 2 },
      () => ({ disableFileHeader: true }),
      {
        onPrimeShell: () => undefined,
        onPublish: ({ phase, range, container }) => {
          phases.push(`${phase}:${range.identity.requestId}`)
          if (!container.isConnected) document.body.append(container)
        },
        onHeightChange: () => undefined,
      },
    )
    adapter.request({
      identity: firstIdentity,
      estimatedHeight: 100,
      load: async () => makeRange(firstIdentity, plainResources()),
      highlight: async (_plain, signal) => {
        syntaxSignals.push(signal)
        return firstSyntax.promise
      },
    })
    await vi.waitFor(() => expect(phases).toContain("plain:first"))
    adapter.request({
      identity: secondIdentity,
      estimatedHeight: 100,
      load: async () => secondLoad.promise,
    })
    expect(syntaxSignals[0]?.aborted).toBe(true)
    firstSyntax.resolve(makeRange(firstIdentity, syntaxResources()))
    secondLoad.resolve(makeRange(secondIdentity, plainResources()))
    await vi.waitFor(() => expect(phases).toContain("plain:second"))
    expect(phases).not.toContain("highlighted:first")
    adapter.dispose()
  })

  it("replaces a repeated exact identity without evicting the new shell", async () => {
    const identity = makeIdentity("unified", "repeat", "range-repeat")
    const caches = new ReviewRendererCaches(cacheBudgets)
    const publications: PierreRangePublication<string>[] = []
    const adapter = new PierreLoadedRangeAdapter(
      caches,
      createPierreRangeShellPool<string>(1),
      { domContainer: 5, observer: 1, measurement: 2 },
      () => ({ disableFileHeader: true }),
      {
        onPrimeShell: () => undefined,
        onPublish: (publication) => {
          publications.push(publication)
          document.body.append(publication.container)
        },
        onHeightChange: () => undefined,
      },
    )
    const request = () =>
      adapter.request({
        identity,
        estimatedHeight: 100,
        load: async () => makeRange(identity, plainResources()),
      })

    request()
    await vi.waitFor(() => expect(publications).toHaveLength(1))
    request()
    await vi.waitFor(() => expect(publications).toHaveLength(2))
    const replacement = publications[1]
    if (replacement === undefined) throw new Error("Expected a replacement publication")
    expect(renderedText(replacement.container)).toContain("new value")
    expect(caches.bytes("dom-container")).toBe(5)
    adapter.dispose()
  })
})

const makeIdentity = (
  mode: PierreRangeIdentity["mode"],
  requestId: string,
  rangeKey: string,
): PierreRangeIdentity => ({
  projectId: "project",
  processEpoch: "process",
  snapshotGeneration: "generation",
  sessionEpoch: "session",
  rangeKey,
  requestId,
  width: mode === "split" ? 1_000 : 600,
  mode,
})

const makeRange = (
  identity: PierreRangeIdentity,
  resources: readonly ReviewCacheResource[],
): PierreLoadedRange<string> => {
  const fileDiff = { ...getSingularPatch(PATCH), cacheKey: identity.rangeKey }
  return {
    identity,
    fileDiff,
    renderRange: {
      startingLine: 0,
      totalLines: identity.mode === "split" ? fileDiff.splitLineCount : fileDiff.unifiedLineCount,
      bufferBefore: 0,
      bufferAfter: 0,
    },
    annotations: [{ side: "additions", lineNumber: 50, metadata: "thread-50" }],
    resources,
  }
}

const plainResources = (): readonly ReviewCacheResource[] => [
  { kind: "text", bytes: 10, release: () => undefined },
  { kind: "annotation", bytes: 2, release: () => undefined },
]

const syntaxResources = (releases: string[] = []): readonly ReviewCacheResource[] => [
  resource("syntax-ast", "syntax-ast", releases),
  resource("syntax-output", "syntax-output", releases),
]

const allPlainResources = (releases: string[]): readonly ReviewCacheResource[] => [
  resource("text", "text", releases),
  resource("annotation", "annotation", releases),
  resource("reservation", "reservation", releases),
  resource("worker", "worker", releases),
]

const resource = (
  kind: ReviewCacheKind,
  label: string,
  releases: string[],
): ReviewCacheResource => ({
  kind,
  bytes: 1,
  release: () => releases.push(label),
})

const deferred = <Value,>() => {
  let completePromise: ((value: Value) => void) | undefined
  const promise = new Promise<Value>((complete) => {
    completePromise = complete
  })
  return { promise, resolve: (value: Value) => completePromise?.(value) }
}

const findHostTextRange = (host: HTMLElement, needle: string): Range | null =>
  (host.shadowRoot === null ? null : findTextRange(host.shadowRoot, needle)) ??
  findTextRange(host, needle)

const findTextRange = (root: Node, needle: string): Range | null => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let combined = ""
  let node = walker.nextNode()
  while (node !== null) {
    if (node instanceof Text) {
      nodes.push(node)
      combined += node.data
    }
    node = walker.nextNode()
  }
  const matchStart = combined.indexOf(needle)
  if (matchStart < 0) return null
  const matchEnd = matchStart + needle.length
  let offset = 0
  let start: readonly [Text, number] | null = null
  for (const text of nodes) {
    const nextOffset = offset + text.data.length
    if (start === null && matchStart <= nextOffset) start = [text, matchStart - offset]
    if (start !== null && matchEnd <= nextOffset) {
      const range = document.createRange()
      range.setStart(start[0], start[1])
      range.setEnd(text, matchEnd - offset)
      return range
    }
    offset = nextOffset
  }
  return null
}

const findElementAcrossShadowRoots = (host: HTMLElement, selector: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(selector) ??
  host.shadowRoot?.querySelector<HTMLElement>(selector) ??
  null

const renderedText = (container: HTMLElement): string =>
  `${container.textContent ?? ""}${container.shadowRoot?.textContent ?? ""}`

class TestResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.add(this)
  }

  disconnect(): void {
    resizeObservers.delete(this)
  }

  observe(_target: Element): void {}
  unobserve(_target: Element): void {}

  emit(): void {
    this.callback([], this)
  }
}

const installResizeObserver = (): void => {
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  })
}
