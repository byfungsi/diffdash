import { createElement, type ReactNode } from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Button } from "@/shared/ui/button"
import { ProjectWorkspaceStatePanel } from "@/shared/ui/project-workspace-state-panel"

let root: Root | null = null

afterEach(() => {
  root?.unmount()
  root = null
  document.body.replaceChildren()
})

describe("ProjectWorkspaceStatePanel", () => {
  it("announces loading politely and renders progress and actions", () => {
    const onCancel = vi.fn<() => void>()
    const action = createElement(
      Button,
      { type: "button", variant: "outline", size: "sm", onClick: onCancel },
      "Cancel",
    )
    render(
      <ProjectWorkspaceStatePanel
        announcement="loading"
        title="Loading files"
        description="Preparing the changed-file inventory."
        tone="neutral"
        progress={{ label: "Files loaded", max: 12, value: 4 }}
        actions={action}
      />,
    )

    const panel = document.querySelector<HTMLElement>('[data-slot="project-workspace-state-panel"]')
    const status = panel?.querySelector("output")
    const progress = panel?.querySelector<HTMLProgressElement>("progress")
    expect(panel?.getAttribute("aria-busy")).toBe("true")
    expect(status?.getAttribute("aria-live")).toBe("polite")
    expect(status?.textContent).toContain("Loading files")
    expect(progress?.getAttribute("aria-label")).toBe("Files loaded")
    expect(progress?.max).toBe(12)
    expect(progress?.value).toBe(4)

    panel?.querySelector<HTMLButtonElement>("button")?.click()
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it("supports alert semantics for failure and invalid states", () => {
    render(
      <ProjectWorkspaceStatePanel
        announcement="alert"
        title="Files could not be loaded"
        description="The selected review is invalid."
        tone="danger"
      />,
    )

    const alert = document.querySelector<HTMLElement>('[role="alert"]')
    expect(alert?.dataset.tone).toBe("danger")
    expect(alert?.textContent).toContain("Files could not be loaded")
    expect(alert?.textContent).toContain("The selected review is invalid.")
    expect(alert?.getAttribute("aria-busy")).toBeNull()
  })
})

const render = (node: ReactNode) => {
  const element = document.createElement("div")
  document.body.append(element)
  root = createRoot(element)
  flushSync(() => root?.render(node))
}
