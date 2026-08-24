import { DEFAULT_CODE_THEME_PREFERENCES } from "@diffdash/domain/ai-settings"
import { ProjectHeadCodeWorkspaceTarget } from "@diffdash/domain/code-workspace"
import { makeHostedRepositoryLocator, HostedRepositorySource } from "@diffdash/domain/git-provider"
import {
  LanguagePosition,
  LanguageRange,
  RepositoryLanguageLocation,
  RepositoryLanguageLocationLink,
  RepositoryLanguageLocationResult,
} from "@diffdash/domain/language"
import { HashMap, Option } from "effect"
import {
  LocalCheckoutFileContent,
  LocalCheckoutFileList,
} from "@diffdash/domain/local-checkout-file"
import { LinkedCheckout, Repo, RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { Suspense, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { page } from "vitest/browser"

import { installDiffDashApi } from "@/test/app-browser-support"
import { FloatingPaneWorkspace } from "@/shared/ui/floating-pane"
import { isMacPlatform } from "@/shell/keyboard-shortcut-platform"

import { CodeScreen } from "./code-screen"

const repo = Repo.make({
  createdAt: "2026-08-22T00:00:00Z",
  id: ReviewProjectId.make("code-screen-definitions-test"),
  isFavorite: true,
  lastOpenedAt: null,
  lastSyncedAt: null,
  source: HostedRepositorySource.make({
    locator: makeHostedRepositoryLocator("github", "fungsi", "diffdash"),
  }),
  checkout: LinkedCheckout.make({
    remoteUrl: "https://github.com/fungsi/diffdash",
    path: RepositoryCheckoutPath.make("/workspace/diffdash"),
  }),
  updatedAt: "2026-08-22T00:00:00Z",
})

let root: Root | null = null
const runtimeFallback = <div>Loading runtime</div>

afterEach(() => {
  root?.unmount()
  root = null
  document.body.replaceChildren()
})

describe("CodeScreen definitions", () => {
  it("routes definition and reference modifier-clicks through Core", async () => {
    const sourcePath = RepositoryRelativePath.make("src/source.ts")
    const targetPath = RepositoryRelativePath.make("src/target.ts")
    const targetPosition = new LanguagePosition({ line: 1, character: 13 })
    const targetRange = new LanguageRange({ start: targetPosition, end: targetPosition })
    const target = new RepositoryLanguageLocationLink({
      originSelectionRange: Option.none(),
      target: new RepositoryLanguageLocation({ path: targetPath, range: targetRange }),
      targetSelectionRange: targetRange,
    })
    const calls = installDiffDashApi({
      repositories: [repo],
      listLocalCheckoutFiles: async () =>
        LocalCheckoutFileList.make({ paths: [sourcePath, targetPath] }),
      readLocalCheckoutFile: async (_projectId, path) =>
        LocalCheckoutFileContent.make({
          path,
          content:
            path === sourcePath
              ? "export const greeting = target\n"
              : "const first = 1\nexport const target = first\n",
        }),
      codeWorkspaceDefinitions: async () =>
        new RepositoryLanguageLocationResult({ locations: [target], truncated: false }),
      codeWorkspaceReferences: async () =>
        new RepositoryLanguageLocationResult({ locations: [target], truncated: false }),
    })
    const selectedPathChanges = vi.fn<(path: RepositoryRelativePath | null) => void>()
    const container = document.createElement("div")
    container.style.height = "640px"
    container.style.width = "1024px"
    document.body.append(container)
    root = createRoot(container)
    const Harness = () => {
      const [selectedPath, setSelectedPath] = useState<RepositoryRelativePath | null>(sourcePath)
      return (
        <CodeScreen
          active
          codeThemes={DEFAULT_CODE_THEME_PREFERENCES}
          colorScheme="light"
          contextWidth={280}
          fileStatuses={HashMap.empty()}
          repo={repo}
          selectedPath={selectedPath}
          sidebarExpanded
          target={ProjectHeadCodeWorkspaceTarget.make({ projectId: repo.id })}
          threadDetailWidth={320}
          onActiveRibbonChange={() => undefined}
          onLinkRepository={() => undefined}
          onSelectedPathChange={(path) => {
            selectedPathChanges(path)
            setSelectedPath(path)
          }}
          onSidebarExpandedChange={() => undefined}
          onSidebarWidthChange={() => undefined}
          onThreadDetailWidthChange={() => undefined}
        />
      )
    }
    root.render(
      <Suspense fallback={runtimeFallback}>
        <FloatingPaneWorkspace className="h-full w-full">
          <Harness />
        </FloatingPaneWorkspace>
      </Suspense>,
    )

    const token = await vi.waitFor(() => {
      const tokens = document
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelectorAll<HTMLElement>("[data-char]")
      const match = [...(tokens ?? [])].find((candidate) => candidate.textContent === "target")
      expect(match).toBeDefined()
      return match
    })
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    token?.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        composed: true,
        button: 0,
        ctrlKey: true,
        metaKey: true,
      }),
    )

    await vi.waitFor(() => {
      expect(calls.codeWorkspaceDefinitions).toHaveBeenCalledOnce()
      expect(selectedPathChanges).toHaveBeenCalledWith(targetPath)
      expect(calls.readLocalCheckoutFile).toHaveBeenCalledWith(repo.id, targetPath)
      const targetTokens = document
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelectorAll<HTMLElement>("[data-char]")
      expect([...(targetTokens ?? [])].some((candidate) => candidate.textContent === "first")).toBe(
        true,
      )
    })
    const targetScrollRoot = document.querySelector<HTMLElement>("[data-code-file-scroll]")
    targetScrollRoot?.focus()
    targetScrollRoot?.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }),
    )
    targetScrollRoot?.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }),
    )
    await vi.waitFor(() => {
      expect(
        document
          .querySelector("diffs-container")
          ?.shadowRoot?.querySelector('[data-line-index="2"][data-selected-line]'),
      ).not.toBeNull()
    })
    expect(calls.codeWorkspaceDefinitions.mock.calls[0]?.[0]).toMatchObject({ path: sourcePath })
    await vi.waitFor(() => {
      const tokens = document
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelectorAll<HTMLElement>("[data-char]")
      const match = [...(tokens ?? [])].find((candidate) => candidate.textContent === "target")
      expect(match).toBeDefined()
      return match
    })
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    await page
      .getByText("target", { exact: true })
      .click({ modifiers: [isMacPlatform() ? "Meta" : "Control", "Shift"] })

    await vi.waitFor(() => {
      expect(calls.codeWorkspaceReferences).toHaveBeenCalled()
      expect(
        document.querySelector('[role="dialog"][aria-label="Peek References, 1 result"]'),
      ).not.toBeNull()
    })
    expect(calls.codeWorkspaceReferences.mock.calls[0]?.[0]).toMatchObject({ path: targetPath })
  })
})
