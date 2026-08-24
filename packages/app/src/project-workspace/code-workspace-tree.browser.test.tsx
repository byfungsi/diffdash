import { CodeWorkspaceEntry } from "@diffdash/domain/code-workspace"
import type { DiffFileStatus } from "@diffdash/domain/diff"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { HashMap, HashSet } from "effect"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, assert, describe, expect, it, vi } from "vitest"

import { CodeWorkspaceTree } from "./code-workspace-tree"

let root: Root | null = null

afterEach(() => {
  root?.unmount()
  root = null
  document.body.replaceChildren()
})

describe("CodeWorkspaceTree", () => {
  it("renders file-type icons and review change markers", () => {
    const sourcePath = RepositoryRelativePath.make("src")
    const addedDirectoryPath = RepositoryRelativePath.make("new")
    const addedFilePath = RepositoryRelativePath.make("new/added.ts")
    const typeScriptPath = RepositoryRelativePath.make("src/source.ts")
    const reactPath = RepositoryRelativePath.make("src/view.tsx")
    const statuses = HashMap.fromIterable<RepositoryRelativePath, DiffFileStatus>([
      [addedFilePath, "added"],
      [typeScriptPath, "added"],
      [reactPath, "modified"],
    ])
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)

    flushSync(() => {
      root?.render(
        <CodeWorkspaceTree
          entries={HashMap.fromIterable([
            [
              "",
              [
                CodeWorkspaceEntry.make({ path: addedDirectoryPath, kind: "directory" }),
                CodeWorkspaceEntry.make({ path: sourcePath, kind: "directory" }),
              ],
            ],
            [addedDirectoryPath, [CodeWorkspaceEntry.make({ path: addedFilePath, kind: "file" })]],
            [
              sourcePath,
              [
                CodeWorkspaceEntry.make({ path: typeScriptPath, kind: "file" }),
                CodeWorkspaceEntry.make({ path: reactPath, kind: "file" }),
              ],
            ],
          ])}
          expandedPaths={HashSet.make(addedDirectoryPath, sourcePath)}
          fileStatuses={statuses}
          loadingPaths={HashSet.empty()}
          nextOffsets={HashMap.make(["", null])}
          selectedPath={null}
          onLoadMore={() => undefined}
          onOpenFile={() => undefined}
          onToggleDirectory={() => undefined}
        />,
      )
    })

    const typeScriptRow = container.querySelector(`[data-item-path="${typeScriptPath}"]`)
    const reactRow = container.querySelector(`[data-item-path="${reactPath}"]`)
    const sourceRow = container.querySelector(`[data-item-path="${sourcePath}"]`)
    const addedDirectoryRow = container.querySelector(`[data-item-path="${addedDirectoryPath}"]`)
    const sourceLabel = sourceRow?.querySelector("span.flex-1")
    const addedDirectoryLabel = addedDirectoryRow?.querySelector("span.flex-1")
    const typeScriptLabel = typeScriptRow?.querySelector("span.flex-1")
    const reactLabel = reactRow?.querySelector("span.flex-1")
    assert(sourceLabel !== null && sourceLabel !== undefined)
    assert(addedDirectoryLabel !== null && addedDirectoryLabel !== undefined)
    assert(typeScriptLabel !== null && typeScriptLabel !== undefined)
    assert(reactLabel !== null && reactLabel !== undefined)
    expect(typeScriptRow?.querySelector("svg")?.dataset.iconToken).toBe("typescript")
    expect(reactRow?.querySelector("svg")?.dataset.iconToken).toBe("react")
    expect(typeScriptRow?.querySelector('[aria-label="Added"]')?.textContent).toBe("A")
    expect(reactRow?.querySelector('[aria-label="Modified"]')?.textContent).toBe("M")
    expect(sourceRow?.getAttribute("data-item-status")).toBe("modified")
    expect(addedDirectoryRow?.getAttribute("data-item-status")).toBe("added")
    expect(sourceLabel.classList).toContain("text-review-modified-text")
    expect(addedDirectoryLabel.classList).toContain("text-review-success-text")
    expect(typeScriptLabel.classList).toContain("text-review-success-text")
    expect(reactLabel.classList).toContain("text-review-modified-text")
    expect(container.querySelector("#file-tree-builtin-typescript")).not.toBeNull()
    expect(container.querySelector("#file-tree-builtin-react")).not.toBeNull()
  })

  it("disables load-more activation while the directory is loading", () => {
    const onLoadMore = vi.fn<(path: RepositoryRelativePath | null) => void>()
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)

    flushSync(() => {
      root?.render(
        <CodeWorkspaceTree
          entries={HashMap.make(["", []])}
          expandedPaths={HashSet.empty()}
          fileStatuses={HashMap.empty()}
          loadingPaths={HashSet.make("")}
          nextOffsets={HashMap.make(["", 500])}
          selectedPath={null}
          onLoadMore={onLoadMore}
          onOpenFile={() => undefined}
          onToggleDirectory={() => undefined}
        />,
      )
    })

    const loadMore = container.querySelector<HTMLButtonElement>("button")
    expect(loadMore?.textContent).toBe("Loading...")
    expect(loadMore?.disabled).toBe(true)
    loadMore?.click()
    expect(onLoadMore).not.toHaveBeenCalled()
  })
})
