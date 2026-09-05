import { ReviewSnapshotFileInventory } from "@diffdash/domain/review-context"
import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { createRoot } from "react-dom/client"
import { expect, it } from "vitest"
import { ReviewFileTree } from "./review-file-tree"

it.each([
  null,
  "file-099.ts",
])("keeps tree scrolling stable during inventory growth with selection %s", async (selectedPath) => {
  const files = parseUnifiedDiff(
    Array.from(
      { length: 200 },
      (_, index) =>
        `diff --git a/file-${String(index).padStart(3, "0")}.ts b/file-${String(index).padStart(3, "0")}.ts\nnew file mode 100644\n--- /dev/null\n+++ b/file-${String(index).padStart(3, "0")}.ts\n@@ -0,0 +1 @@\n+content\n`,
    ).join(""),
  ).files.map((file) => ReviewSnapshotFileInventory.make({ ...file, hunkCount: file.hunks.length }))
  const container = document.createElement("div")
  container.style.height = "300px"
  document.body.append(container)
  const root = createRoot(container)
  const frames = async () => {
    for (let index = 0; index < 4; index += 1)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
  try {
    root.render(
      <ReviewFileTree
        files={files.slice(0, 100)}
        selectedPath={selectedPath}
        onSelectPath={() => undefined}
      />,
    )
    await expect
      .poll(() =>
        container
          .querySelector("file-tree-container")
          ?.shadowRoot?.querySelector("[data-file-tree-virtualized-scroll]"),
      )
      .toBeTruthy()
    await frames()
    const scroll = container
      .querySelector("file-tree-container")
      ?.shadowRoot?.querySelector<HTMLElement>("[data-file-tree-virtualized-scroll]")
    if (!scroll) throw new Error("Missing tree scroller")
    for (const top of [0, 260]) {
      scroll.scrollTop = top
      await frames()
      root.render(
        <ReviewFileTree
          files={files.slice(0, top === 0 ? 150 : 200)}
          selectedPath={selectedPath}
          onSelectPath={() => undefined}
        />,
      )
      await frames()
      expect(scroll.scrollTop).toBe(top)
    }
  } finally {
    root.unmount()
    container.remove()
  }
})

it("does not re-read a large inventory when only the selected file changes", async () => {
  const patch = Array.from(
    { length: 2000 },
    (_, index) =>
      `diff --git a/file-${index}.ts b/file-${index}.ts\nnew file mode 100644\n--- /dev/null\n+++ b/file-${index}.ts\n@@ -0,0 +1 @@\n+content\n`,
  ).join("")
  let pathReads = 0
  const files = parseUnifiedDiff(patch).files.map((file) => ({
    ...ReviewSnapshotFileInventory.make({ ...file, hunkCount: file.hunks.length }),
    get path() {
      pathReads += 1
      return file.path
    },
  }))
  const container = document.createElement("div")
  container.style.height = "600px"
  document.body.append(container)
  const root = createRoot(container)
  try {
    root.render(
      <ReviewFileTree files={files} selectedPath="file-0.ts" onSelectPath={() => undefined} />,
    )
    await expect
      .poll(() =>
        container
          .querySelector("[data-selected-review-path]")
          ?.getAttribute("data-selected-review-path"),
      )
      .toBe("file-0.ts")
    expect(pathReads).toBeGreaterThan(0)
    pathReads = 0
    root.render(
      <ReviewFileTree files={files} selectedPath="file-1999.ts" onSelectPath={() => undefined} />,
    )
    await expect
      .poll(() =>
        container
          .querySelector("[data-selected-review-path]")
          ?.getAttribute("data-selected-review-path"),
      )
      .toBe("file-1999.ts")
    expect(pathReads).toBe(0)
  } finally {
    root.unmount()
    container.remove()
  }
})
