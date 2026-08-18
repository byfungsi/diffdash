import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { ReviewSnapshotFileInventory } from "@diffdash/domain/review-context"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ReviewFileTree } from "./review-file-tree"

const STATUS_COLORS = {
  added: "rgb(91, 200, 120)",
  deleted: "rgb(220, 92, 105)",
  modified: "rgb(215, 181, 92)",
  renamed: "rgb(79, 190, 184)",
} as const

const STATUS_LABELS = {
  added: "A",
  deleted: "D",
  modified: "M",
  renamed: "R",
} as const

const STATUS_PATHS = {
  added: "src/added.ts",
  deleted: "src/deleted.ts",
  modified: "src/modified.ts",
  renamed: "src/renamed.ts",
} as const

const ICON_COLORS = {
  react: "rgb(78, 187, 214)",
  test: "rgb(220, 92, 105)",
  typescript: "rgb(76, 139, 206)",
} as const

const ICON_PATHS = {
  falsePositiveSpec: "src/special/helper.ts",
  falsePositiveTest: "src/contest/helper.ts",
  namedSpec: "src/widget.SPEC.ts",
  namedTest: "src/widget.test.tsx",
  nestedDunderTests: "src/__tests__/helper.ts",
  nestedSpecs: "src/specs/contract.ts",
  rootSpec: "spec/unit.ts",
  rootTest: "test/root.ts",
  rootTests: "tests/integration.ts",
  sourceReact: "src/source.tsx",
  sourceTypeScript: "src/source.ts",
} as const

const inventoryFromUnifiedDiff = (patch: string) =>
  parseUnifiedDiff(patch).files.map((file) =>
    ReviewSnapshotFileInventory.make({
      fileId: file.fileId,
      patchHash: file.patchHash,
      reviewKey: file.reviewKey,
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      visibility: file.visibility,
      additions: file.additions,
      deletions: file.deletions,
      hunkCount: file.hunks.length,
    }),
  )

const files = inventoryFromUnifiedDiff(`diff --git a/src/added.ts b/src/added.ts
new file mode 100644
--- /dev/null
+++ b/src/added.ts
@@ -0,0 +1 @@
+export const added = true
diff --git a/src/deleted.ts b/src/deleted.ts
deleted file mode 100644
--- a/src/deleted.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const deleted = true
diff --git a/src/modified.ts b/src/modified.ts
--- a/src/modified.ts
+++ b/src/modified.ts
@@ -1 +1 @@
-export const modified = false
+export const modified = true
diff --git a/src/old-name.ts b/src/renamed.ts
similarity index 100%
rename from src/old-name.ts
rename to src/renamed.ts`)

const iconFiles = inventoryFromUnifiedDiff(
  Object.values(ICON_PATHS)
    .map(
      (path) => `diff --git a/${path} b/${path}
new file mode 100644
--- /dev/null
+++ b/${path}
@@ -0,0 +1 @@
+export const fixture = true`,
    )
    .join("\n"),
)

let root: Root | null = null

afterEach(() => {
  root?.unmount()
  root = null
  document.body.replaceChildren()
  document.documentElement.style.removeProperty("--review-success-text")
  document.documentElement.style.removeProperty("--review-danger-text")
  document.documentElement.style.removeProperty("--review-modified-text")
  document.documentElement.style.removeProperty("--review-renamed-text")
  document.documentElement.style.removeProperty("--review-sidebar-fg")
  document.documentElement.style.removeProperty("--review-sidebar-muted")
  document.documentElement.style.removeProperty("--review-tree-selected")
  document.documentElement.style.removeProperty("--review-tree-selected-border")
  document.documentElement.style.removeProperty("--theme-sapphire")
  document.documentElement.style.removeProperty("--theme-sky")
})

describe("ReviewFileTree", () => {
  it("does not navigate when the tree applies its initial controlled selection", async () => {
    const onSelectPath = vi.fn()
    const container = document.createElement("div")
    container.style.height = "320px"
    container.style.width = "320px"
    document.body.append(container)
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        <ReviewFileTree
          files={files}
          selectedPath={STATUS_PATHS.modified}
          onSelectPath={onSelectPath}
        />,
      )
    })

    const selected = await vi.waitFor(() => {
      const row = document
        .querySelector("file-tree-container")
        ?.shadowRoot?.querySelector<HTMLElement>(
          `[data-item-path="${STATUS_PATHS.modified}"][data-item-selected]`,
        )
      expect(row).not.toBeNull()
      return row
    })
    expect(onSelectPath).not.toHaveBeenCalled()

    selected?.click()
    expect(onSelectPath).toHaveBeenCalledTimes(1)
    expect(onSelectPath).toHaveBeenCalledWith(STATUS_PATHS.modified)
  })

  it("colors file names and status labels while retaining the selected-row treatment", async () => {
    document.documentElement.style.setProperty("--review-success-text", STATUS_COLORS.added)
    document.documentElement.style.setProperty("--review-danger-text", STATUS_COLORS.deleted)
    document.documentElement.style.setProperty("--review-modified-text", STATUS_COLORS.modified)
    document.documentElement.style.setProperty("--review-renamed-text", STATUS_COLORS.renamed)
    document.documentElement.style.setProperty("--review-sidebar-fg", "rgb(210, 210, 215)")
    document.documentElement.style.setProperty("--review-sidebar-muted", "rgb(125, 125, 132)")
    document.documentElement.style.setProperty("--review-tree-selected", "rgb(46, 42, 54)")
    document.documentElement.style.setProperty("--review-tree-selected-border", "rgb(103, 91, 125)")

    const container = document.createElement("div")
    container.style.height = "320px"
    container.style.width = "320px"
    document.body.append(container)
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        <ReviewFileTree
          files={files}
          selectedPath={STATUS_PATHS.modified}
          onSelectPath={() => undefined}
        />,
      )
    })

    const treeRoot = await vi.waitFor(() => {
      const shadowRoot = document.querySelector("file-tree-container")?.shadowRoot
      expect(shadowRoot).not.toBeNull()
      expect(shadowRoot?.querySelector(`[data-item-path="${STATUS_PATHS.added}"]`)).not.toBeNull()
      return shadowRoot!
    })

    for (const status of Object.keys(STATUS_PATHS) as (keyof typeof STATUS_PATHS)[]) {
      const row = treeRoot.querySelector<HTMLElement>(
        `[data-item-path="${STATUS_PATHS[status]}"][data-item-git-status="${status}"]`,
      )
      const content = row?.querySelector<HTMLElement>(':scope > [data-item-section="content"]')
      const statusLabel = row?.querySelector<HTMLElement>('[data-item-section="git"]')
      expect(row).not.toBeNull()
      expect(content).not.toBeNull()
      expect(getComputedStyle(content!).color).toBe(STATUS_COLORS[status])
      expect(statusLabel?.textContent?.trim()).toBe(STATUS_LABELS[status])
      expect(getComputedStyle(statusLabel!).color).toBe(STATUS_COLORS[status])
    }

    const selected = treeRoot.querySelector<HTMLElement>(
      `[data-item-path="${STATUS_PATHS.modified}"][data-item-selected]`,
    )
    expect(selected).not.toBeNull()
    expect(getComputedStyle(selected!).backgroundColor).toBe("rgb(46, 42, 54)")
  })

  it("keeps language-specific source icons and colors recognized test files red", async () => {
    document.documentElement.style.setProperty("--review-danger-text", ICON_COLORS.test)
    document.documentElement.style.setProperty("--theme-sapphire", ICON_COLORS.typescript)
    document.documentElement.style.setProperty("--theme-sky", ICON_COLORS.react)

    const container = document.createElement("div")
    container.style.height = "640px"
    container.style.width = "320px"
    document.body.append(container)
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        <ReviewFileTree files={iconFiles} selectedPath={null} onSelectPath={() => undefined} />,
      )
    })

    const treeRoot = await vi.waitFor(() => {
      const shadowRoot = document.querySelector("file-tree-container")?.shadowRoot
      expect(shadowRoot).not.toBeNull()
      expect(
        shadowRoot?.querySelector(`[data-item-path="${ICON_PATHS.sourceTypeScript}"]`),
      ).not.toBeNull()
      return shadowRoot!
    })
    const iconForPath = (path: string) =>
      treeRoot.querySelector<SVGElement>(
        `[data-item-path="${path}"] > [data-item-section="icon"] > [data-icon-token]`,
      )

    const sourceTypeScriptIcon = iconForPath(ICON_PATHS.sourceTypeScript)
    const sourceReactIcon = iconForPath(ICON_PATHS.sourceReact)
    expect(sourceTypeScriptIcon?.dataset.iconToken).toBe("typescript")
    expect(getComputedStyle(sourceTypeScriptIcon!).color).toBe(ICON_COLORS.typescript)
    expect(sourceReactIcon?.dataset.iconToken).toBe("react")
    expect(getComputedStyle(sourceReactIcon!).color).toBe(ICON_COLORS.react)

    for (const path of [
      ICON_PATHS.namedSpec,
      ICON_PATHS.namedTest,
      ICON_PATHS.nestedDunderTests,
      ICON_PATHS.nestedSpecs,
      ICON_PATHS.rootSpec,
      ICON_PATHS.rootTest,
      ICON_PATHS.rootTests,
    ]) {
      const icon = iconForPath(path)
      expect(icon).not.toBeNull()
      expect(getComputedStyle(icon!).color).toBe(ICON_COLORS.test)
    }

    for (const path of [ICON_PATHS.falsePositiveSpec, ICON_PATHS.falsePositiveTest]) {
      const icon = iconForPath(path)
      expect(icon).not.toBeNull()
      expect(getComputedStyle(icon!).color).toBe(ICON_COLORS.typescript)
    }
  })
})
