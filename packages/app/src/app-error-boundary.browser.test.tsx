import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AppErrorBoundary } from "./app-error-boundary"

let root: Root | null = null

afterEach(() => {
  root?.unmount()
  root = null
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe("AppErrorBoundary", () => {
  it("shows render errors and reloads DiffDash", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const onReload = vi.fn<() => void>()
    render(
      <AppErrorBoundary onReload={onReload}>
        <ThrowingView />
      </AppErrorBoundary>,
    )

    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain("Renderer exploded")
    })
    buttonNamed("Reload DiffDash").click()
    expect(onReload).toHaveBeenCalledOnce()
  })

  it("shows otherwise-unhandled IPC promise failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    render(
      <AppErrorBoundary onReload={() => undefined}>
        <p>Application ready</p>
      </AppErrorBoundary>,
    )
    await vi.waitFor(() => expect(document.body.textContent).toContain("Application ready"))

    window.dispatchEvent(
      new PromiseRejectionEvent("unhandledrejection", {
        promise: Promise.resolve(),
        reason: new Error("reviewThreads:runAgent failed: IPC unavailable"),
      }),
    )

    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "reviewThreads:runAgent failed: IPC unavailable",
      )
    })
  })
})

const ThrowingView = () => {
  throw new Error("Renderer exploded")
}

const render = (node: React.ReactNode) => {
  const element = document.createElement("div")
  document.body.append(element)
  root = createRoot(element)
  root.render(node)
}

const buttonNamed = (name: string) => {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === name,
  )
  if (button === undefined) throw new Error(`Button not found: ${name}`)
  return button
}
