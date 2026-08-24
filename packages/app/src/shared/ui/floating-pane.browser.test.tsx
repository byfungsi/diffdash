import { Option } from "effect"
import { type ReactNode, useState } from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import "../../styles.css"
import { AnchoredFloatingPane, FloatingPane, FloatingPaneWorkspace } from "./floating-pane"

let root = Option.none<Root>()

afterEach(() => {
  Option.match(root, { onNone: () => undefined, onSome: (activeRoot) => activeRoot.unmount() })
  root = Option.none()
  document.body.replaceChildren()
})

describe("FloatingPane", () => {
  it("keeps multiple non-modal panes stacked and independently closable", async () => {
    render(<MovablePaneHarness />, { height: 560, width: 800 })

    const panes = await vi.waitFor(() => {
      const candidates = [...document.querySelectorAll<HTMLDialogElement>("dialog")]
      expect(candidates).toHaveLength(2)
      return candidates
    })
    const firstPane = required(panes[0], () => document.createElement("dialog"))
    const secondPane = required(panes[1], () => document.createElement("dialog"))
    expect(secondPane.hasAttribute("data-floating-pane-active")).toBe(true)

    firstPane.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }))
    await vi.waitFor(() => expect(firstPane.hasAttribute("data-floating-pane-active")).toBe(true))

    firstPane.focus()
    firstPane.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }))
    await vi.waitFor(() => {
      expect(document.body.contains(firstPane)).toBe(false)
      expect(document.querySelectorAll("dialog")).toHaveLength(1)
      expect(document.activeElement).toBe(secondPane)
    })
  })

  it("moves, resizes, and clamps a pane within its workspace", async () => {
    const container = render(
      <FloatingPaneWorkspace className="h-full w-full">
        <FloatingPane
          title="Geometry pane"
          defaultPosition={{ x: 40, y: 36 }}
          defaultSize={{ width: 300, height: 220 }}
          onClose={() => undefined}
        >
          Geometry content
        </FloatingPane>
      </FloatingPaneWorkspace>,
      { height: 420, width: 640 },
    )

    const pane = await vi.waitFor(() => {
      const candidate = required(document.querySelector<HTMLDialogElement>("dialog"), () =>
        document.createElement("dialog"),
      )
      expect(candidate.getBoundingClientRect().width).toBeCloseTo(300, 0)
      return candidate
    })
    const workspace = required(
      document.querySelector<HTMLElement>("[data-floating-pane-workspace]"),
      () => document.createElement("div"),
    )
    const dragHandle = required(
      pane.querySelector<HTMLElement>("[data-floating-pane-drag-handle]"),
      () => document.createElement("button"),
    )
    const resizeHandle = required(
      pane.querySelector<HTMLButtonElement>("[data-floating-pane-resize-handle]"),
      () => document.createElement("button"),
    )

    installPointerCaptureStub(dragHandle)
    dispatchPointer(dragHandle, "pointerdown", { clientX: 60, clientY: 50, pointerId: 2 })
    dispatchPointer(dragHandle, "pointermove", { clientX: 1_000, clientY: 1_000, pointerId: 2 })
    dispatchPointer(dragHandle, "pointerup", { clientX: 1_000, clientY: 1_000, pointerId: 2 })
    await vi.waitFor(() => {
      const paneRect = pane.getBoundingClientRect()
      const workspaceRect = workspace.getBoundingClientRect()
      expect(paneRect.right).toBeLessThanOrEqual(workspaceRect.right - 7)
      expect(paneRect.bottom).toBeLessThanOrEqual(workspaceRect.bottom - 7)
    })

    installPointerCaptureStub(resizeHandle)
    dispatchPointer(resizeHandle, "pointerdown", { clientX: 0, clientY: 0, pointerId: 3 })
    dispatchPointer(resizeHandle, "pointermove", { clientX: -1_000, clientY: -1_000, pointerId: 3 })
    dispatchPointer(resizeHandle, "pointerup", { clientX: -1_000, clientY: -1_000, pointerId: 3 })
    await vi.waitFor(() => {
      expect(pane.getBoundingClientRect().width).toBeCloseTo(240, 0)
      expect(pane.getBoundingClientRect().height).toBeCloseTo(120, 0)
    })

    container.style.height = "180px"
    container.style.width = "260px"
    await vi.waitFor(() => {
      const paneRect = pane.getBoundingClientRect()
      const workspaceRect = workspace.getBoundingClientRect()
      expect(paneRect.right).toBeLessThanOrEqual(workspaceRect.right - 7)
      expect(paneRect.bottom).toBeLessThanOrEqual(workspaceRect.bottom - 7)
    })
  })

  it("portals an anchored pane, constrains it to bounds, and dismisses outside", async () => {
    render(<AnchoredPaneHarness />, { height: 420, width: 640 })

    const pane = await vi.waitFor(() => {
      const candidate = required(
        document.querySelector<HTMLElement>("[data-floating-pane-anchor]"),
        () => document.createElement("div"),
      )
      expect(candidate.getBoundingClientRect().height).toBeGreaterThan(0)
      return candidate
    })
    const host = required(document.querySelector<HTMLElement>("[data-floating-pane-host]"), () =>
      document.createElement("div"),
    )
    expect(host.contains(pane)).toBe(true)
    expect(pane.dataset.side).toMatch(/^(top|bottom)$/)
    expect(pane.style.maxHeight).toContain("available-height")

    const underlying = required(
      document.querySelector<HTMLButtonElement>("[data-outside-action]"),
      () => document.createElement("button"),
    )
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    underlying.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }))
    underlying.click()
    await vi.waitFor(() => expect(document.body.contains(pane)).toBe(false))
  })

  it("reports a missing floating pane workspace", () => {
    render(
      <FloatingPane title="Detached pane" onClose={() => undefined}>
        Detached content
      </FloatingPane>,
      { height: 240, width: 320 },
    )

    const error = document.querySelector<HTMLElement>("[data-floating-pane-composition-error]")
    expect(error?.getAttribute("role")).toBe("alert")
    expect(error?.textContent).toContain("requires a FloatingPaneWorkspace")
  })
})

const MovablePaneHarness = () => {
  const [paneIds, setPaneIds] = useState<readonly ("first" | "second")[]>(["first", "second"])
  return (
    <FloatingPaneWorkspace className="h-full w-full">
      {paneIds.map((paneId, index) => (
        <FloatingPane
          key={paneId}
          title={`${paneId} pane`}
          defaultPosition={{ x: 32 + index * 48, y: 28 + index * 48 }}
          onClose={() =>
            setPaneIds((current) => current.filter((candidate) => candidate !== paneId))
          }
        >
          {paneId} content
        </FloatingPane>
      ))}
    </FloatingPaneWorkspace>
  )
}

const AnchoredPaneHarness = () => {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(true)
  return (
    <FloatingPaneWorkspace className="h-full w-full">
      <button ref={setAnchor} type="button" className="absolute top-[380px] left-6">
        Anchor
      </button>
      <button type="button" data-outside-action>
        Outside action
      </button>
      {anchor === null || !open ? null : (
        <AnchoredFloatingPane
          anchor={anchor}
          ariaLabel="Anchored details"
          className="h-32 w-80"
          onClose={() => setOpen(false)}
        >
          Anchored content
        </AnchoredFloatingPane>
      )}
    </FloatingPaneWorkspace>
  )
}

const render = (
  node: ReactNode,
  dimensions: { readonly height: number; readonly width: number },
) => {
  const element = document.createElement("div")
  element.style.height = `${dimensions.height}px`
  element.style.width = `${dimensions.width}px`
  document.body.append(element)
  const activeRoot = createRoot(element)
  root = Option.some(activeRoot)
  flushSync(() => activeRoot.render(node))
  return element
}

const required = <Element,>(
  element: Element | null | undefined,
  fallback: () => Element,
): Element => Option.getOrElse(Option.fromNullishOr(element), fallback)

const installPointerCaptureStub = (element: HTMLElement) => {
  element.setPointerCapture = vi.fn<(pointerId: number) => void>()
  element.hasPointerCapture = vi.fn<(pointerId: number) => boolean>().mockReturnValue(true)
  element.releasePointerCapture = vi.fn<(pointerId: number) => void>()
}

const dispatchPointer = (
  element: HTMLElement,
  type: string,
  init: { readonly clientX: number; readonly clientY: number; readonly pointerId: number },
) =>
  element.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      button: 0,
      clientX: init.clientX,
      clientY: init.clientY,
      pointerId: init.pointerId,
    }),
  )
