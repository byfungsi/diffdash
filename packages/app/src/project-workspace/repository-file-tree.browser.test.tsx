import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { Option } from "effect"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RepositoryFileTree } from "./repository-file-tree"

const paths = [
  RepositoryRelativePath.make("README.md"),
  RepositoryRelativePath.make("packages/app/src/app.tsx"),
] as const

let root: Root | null = null

afterEach(() => {
  root?.unmount()
  root = null
  document.body.replaceChildren()
})

describe("RepositoryFileTree", () => {
  it("renders repository paths and reports a selected file", async () => {
    const onSelectPath = vi.fn<(path: RepositoryRelativePath) => void>()
    const container = document.createElement("div")
    container.style.height = "320px"
    container.style.width = "320px"
    document.body.append(container)
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        <RepositoryFileTree
          paths={paths}
          selectedPath={Option.some(paths[0])}
          onSelectPath={onSelectPath}
        />,
      )
    })

    const treeRoot = await vi.waitFor(() => {
      const shadowRoot = document.querySelector("file-tree-container")?.shadowRoot
      expect(
        shadowRoot?.querySelector(`[data-item-path="${paths[0]}"][data-item-selected]`),
      ).not.toBeNull()
      expect(shadowRoot?.querySelector(`[data-item-path="${paths[1]}"]`)).not.toBeNull()
      return shadowRoot
    })
    expect(onSelectPath).not.toHaveBeenCalled()

    treeRoot?.querySelector<HTMLElement>('[data-item-path="packages"]')?.click()
    expect(
      treeRoot?.querySelector(`[data-item-path="${paths[0]}"][data-item-selected]`),
    ).not.toBeNull()
    expect(onSelectPath).not.toHaveBeenCalled()

    treeRoot?.querySelector<HTMLElement>(`[data-item-path="${paths[1]}"]`)?.click()
    expect(onSelectPath).toHaveBeenCalledWith(paths[1])
  })
})
