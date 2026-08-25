import { Result } from "effect"
import { useEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  makeTrustedExtensionRegistry,
  type TrustedBuiltInExtension,
  TrustedExtensionContributionId,
  TrustedExtensionId,
} from "./extension-registry"
import {
  TrustedExtensionRegistryProvider,
  useTrustedExtensionRegistry,
} from "./extension-registry-context"
import { TrustedTitlebarActions } from "./trusted-titlebar-actions"

let root: Root | null = null

afterEach(() => {
  root?.unmount()
  root = null
  document.body.replaceChildren()
})

describe("TrustedTitlebarActions", () => {
  it("disposes and remounts an action across same-tick registration turnover", async () => {
    const mounted = vi.fn<() => void>()
    const unmounted = vi.fn<() => void>()
    const extensionId = TrustedExtensionId.make("example.titlebar.turnover")
    const Action = () => {
      useEffect(() => {
        mounted()
        return unmounted
      }, [])
      return <button type="button">Turnover action</button>
    }
    const extension: TrustedBuiltInExtension = {
      id: extensionId,
      titlebarActions: [
        {
          id: TrustedExtensionContributionId.make("example.titlebar.turnover.action"),
          order: 100,
          component: Action,
        },
      ],
    }
    const registry = Result.getOrThrow(makeTrustedExtensionRegistry([extension]))
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    root.render(
      <TrustedExtensionRegistryProvider extensions={[]} registry={registry}>
        <Harness />
      </TrustedExtensionRegistryProvider>,
    )

    await vi.waitFor(() => expect(mounted).toHaveBeenCalledOnce())
    expect(registry.unregister(extensionId)).toBe(true)
    Result.getOrThrow(registry.register(extension))

    await vi.waitFor(() => {
      expect(unmounted).toHaveBeenCalledOnce()
      expect(mounted).toHaveBeenCalledTimes(2)
    })
  })
})

const Harness = () => {
  const { titlebarActions } = useTrustedExtensionRegistry()
  return <TrustedTitlebarActions actions={titlebarActions} projectId={null} />
}
