import { createRoot, type Root } from "react-dom/client"
import { legacyBridgeTransportError } from "@diffdash/protocol/testing"
import { transportError } from "@diffdash/protocol/transport-error"
import { afterEach, describe, expect, it, vi } from "vitest"
import { page } from "vitest/browser"

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
    await page.getByRole("button", { name: "Reload DiffDash", exact: true }).click()
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

  it("shows the public message instead of a bridged transport envelope", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    render(
      <AppErrorBoundary onReload={() => undefined}>
        <p>Application ready</p>
      </AppErrorBoundary>,
    )
    await vi.waitFor(() => expect(document.body.textContent).toContain("Application ready"))
    const bridged = legacyBridgeTransportError(
      transportError("AgentProviderExitError", "Provider claude stopped safely."),
    )

    window.dispatchEvent(
      new PromiseRejectionEvent("unhandledrejection", {
        promise: Promise.resolve(),
        reason: { message: bridged.message },
      }),
    )

    await vi.waitFor(() => {
      const text = document.querySelector('[role="alert"]')?.textContent
      expect(text).toContain("Provider claude stopped safely.")
      expect(text).not.toContain("DIFFDASH_TRANSPORT_ERROR_V1")
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
