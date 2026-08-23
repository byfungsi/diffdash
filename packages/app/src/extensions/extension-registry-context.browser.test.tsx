import { StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  TrustedExtensionRegistryProvider,
  useTrustedExtensionRegistry,
} from "./extension-registry-context"
import { trustedBuiltInExtensions } from "./trusted-built-in-extensions"

let root: Root | null = null

afterEach(() => {
  root?.unmount()
  root = null
  document.body.replaceChildren()
})

const ActivityList = () => {
  const registry = useTrustedExtensionRegistry()
  return (
    <output>
      {registry.projectActivities
        .map((activity) => `${activity.label}:${activity.ownerExtensionId}`)
        .join(",")}
    </output>
  )
}

describe("TrustedExtensionRegistryProvider", () => {
  it("provides one synchronous built-in snapshot through Strict Mode remounts", async () => {
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    root.render(
      <StrictMode>
        <TrustedExtensionRegistryProvider extensions={trustedBuiltInExtensions}>
          <ActivityList />
        </TrustedExtensionRegistryProvider>
      </StrictMode>,
    )

    await vi.waitFor(() => {
      expect(container.textContent).toBe("Comments:diffdash.builtin.review-comments")
    })
  })
})
