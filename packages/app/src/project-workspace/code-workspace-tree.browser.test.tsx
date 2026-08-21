import { CodeWorkspaceEntry } from "@diffdash/domain/code-workspace"
import type { DiffFileStatus } from "@diffdash/domain/diff"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"

import { CodeWorkspaceTree } from "./code-workspace-tree"

let root: Root | null = null

afterEach(() => {
  root?.unmount()
  root = null
  document.body.replaceChildren()
})

describe("CodeWorkspaceTree", () => {
  it("renders file-type icons and review change markers", () => {
    const typeScriptPath = RepositoryRelativePath.make("source.ts")
    const reactPath = RepositoryRelativePath.make("view.tsx")
    const statuses = new Map<RepositoryRelativePath, DiffFileStatus>([
      [typeScriptPath, "added"],
      [reactPath, "modified"],
    ])
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)

    flushSync(() => {
      root?.render(
        <CodeWorkspaceTree
          entries={
            new Map([
              [
                "",
                [
                  CodeWorkspaceEntry.make({ path: typeScriptPath, kind: "file" }),
                  CodeWorkspaceEntry.make({ path: reactPath, kind: "file" }),
                ],
              ],
            ])
          }
          expandedPaths={new Set()}
          fileStatuses={statuses}
          loadingPaths={new Set()}
          nextOffsets={new Map([["", null]])}
          selectedPath={null}
          onLoadMore={() => undefined}
          onOpenFile={() => undefined}
          onToggleDirectory={() => undefined}
        />,
      )
    })

    const typeScriptRow = container.querySelector(`[data-item-path="${typeScriptPath}"]`)
    const reactRow = container.querySelector(`[data-item-path="${reactPath}"]`)
    expect(typeScriptRow?.querySelector("svg")?.dataset.iconToken).toBe("typescript")
    expect(reactRow?.querySelector("svg")?.dataset.iconToken).toBe("react")
    expect(typeScriptRow?.querySelector('[aria-label="Added"]')?.textContent).toBe("A")
    expect(reactRow?.querySelector('[aria-label="Modified"]')?.textContent).toBe("M")
    expect(container.querySelector("#file-tree-builtin-typescript")).not.toBeNull()
    expect(container.querySelector("#file-tree-builtin-react")).not.toBeNull()
  })
})
