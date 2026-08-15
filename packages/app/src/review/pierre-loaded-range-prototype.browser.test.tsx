import { getSingularPatch } from "./pierre"
import {
  type PierreLoadedRange,
  PierreLoadedRangeRenderer,
  type PierreRangeIdentity,
} from "./pierre-loaded-range-prototype"
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

const originalResizeObserver = Object.getOwnPropertyDescriptor(window, "ResizeObserver")
let emitResize: (() => void) | null = null

afterEach(() => {
  emitResize = null
  document.body.replaceChildren()
  if (originalResizeObserver === undefined) {
    Reflect.deleteProperty(window, "ResizeObserver")
  } else {
    Object.defineProperty(window, "ResizeObserver", originalResizeObserver)
  }
})

describe("PierreLoadedRangeRenderer", () => {
  it.each(["unified", "split"] as const)(
    "renders bounded %s coordinates with search text and a thread annotation",
    async (mode) => {
      const container = document.createElement("div")
      document.body.append(container)
      const renderer = new PierreLoadedRangeRenderer(container, () => undefined)
      const renderedPhases: string[] = []
      const range = makeRange(mode)

      renderer.renderPlain(range, {
        diffStyle: mode,
        disableFileHeader: true,
        overflow: "wrap",
        onPostRender: (_node, _instance, phase) => renderedPhases.push(phase),
        renderAnnotation: (annotation) => {
          const element = document.createElement("aside")
          if (typeof annotation.metadata === "string") {
            element.dataset.prototypeThread = annotation.metadata
          }
          element.textContent = `Thread on new line ${annotation.lineNumber}`
          return element
        },
      })

      await vi.waitFor(() => expect(renderedText(container)).toContain("new value"))
      expect(renderedText(container)).toContain("old value")
      expect(container.textContent).toContain("Thread on new line 50")
      expect(container.querySelector('[data-prototype-thread="thread-50"]')).not.toBeNull()
      expect(renderer.getLineIndex(40, "deletions")).toBeDefined()
      expect(renderer.getLineIndex(50, "additions")).toBeDefined()
      expect(renderedPhases).toContain("mount")
      const oldCoordinate = renderer.getLineIndex(40, "deletions")
      const newCoordinate = renderer.getLineIndex(50, "additions")

      const searchRange = findTextRange(container.shadowRoot ?? container, "new value")
      expect(searchRange?.toString()).toBe("new value")

      await renderer.renderHighlighted(range, {
        diffStyle: mode,
        disableFileHeader: true,
        overflow: "wrap",
        renderAnnotation: (annotation) => {
          const element = document.createElement("aside")
          element.textContent = `Thread on new line ${annotation.lineNumber}`
          return element
        },
      })
      expect(renderer.getLineIndex(40, "deletions")).toEqual(oldCoordinate)
      expect(renderer.getLineIndex(50, "additions")).toEqual(newCoordinate)
      expect(renderedText(container)).toContain("new value")

      renderer.reset()
    },
  )

  it("reports wrapping height deltas and resets a pooled container", async () => {
    installResizeObserver()
    const container = document.createElement("div")
    let height = 80
    container.getBoundingClientRect = () => new DOMRect(0, 0, 320, height)
    container.dataset.staleOwner = "old-range"
    container.style.height = "80px"
    document.body.append(container)
    const mutableDeltas: [number, number][] = []
    const renderer = new PierreLoadedRangeRenderer(container, (delta, nextHeight) => {
      mutableDeltas.push([delta, nextHeight])
    })

    renderer.renderPlain(makeRange("unified"), {
      disableFileHeader: true,
      overflow: "wrap",
    })
    height = 132
    emitResize?.()
    await vi.waitFor(() => expect(mutableDeltas).toContainEqual([52, 132]))

    renderer.reset()
    expect(container.childElementCount).toBe(0)
    expect(container.hasAttribute("data-stale-owner")).toBe(false)
    expect(container.hasAttribute("style")).toBe(false)
  })
})

const makeRange = (mode: PierreRangeIdentity["mode"]): PierreLoadedRange<string> => {
  const fileDiff = { ...getSingularPatch(PATCH), cacheKey: `partial-range:${mode}` }
  return {
    identity: {
      projectId: "project",
      processEpoch: "process",
      snapshotGeneration: "snapshot",
      sessionEpoch: "session",
      requestId: `request-${mode}`,
      width: mode === "split" ? 1_000 : 600,
      mode,
    },
    semanticKey: "src/range.ts:hunk-40-50",
    fileDiff,
    renderRange: {
      startingLine: 0,
      totalLines: mode === "split" ? fileDiff.splitLineCount : fileDiff.unifiedLineCount,
      bufferBefore: 0,
      bufferAfter: 0,
    },
    annotations: [{ side: "additions", lineNumber: 50, metadata: "thread-50" }],
    owners: [],
  }
}

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

const renderedText = (container: HTMLElement) =>
  `${container.textContent ?? ""}${container.shadowRoot?.textContent ?? ""}`

class TestResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    emitResize = () => callback([], this)
  }

  disconnect(): void {}
  observe(_target: Element): void {}
  unobserve(_target: Element): void {}
}

const installResizeObserver = () => {
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  })
}
