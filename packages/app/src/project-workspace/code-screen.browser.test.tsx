import { DEFAULT_CODE_THEME_PREFERENCES } from "@diffdash/domain/ai-settings"
import { ProjectHeadCodeWorkspaceTarget } from "@diffdash/domain/code-workspace"
import { makeHostedRepositoryLocator, HostedRepositorySource } from "@diffdash/domain/git-provider"
import {
  LocalCheckoutFileList,
  type LocalCheckoutFileListResult,
} from "@diffdash/domain/local-checkout-file"
import { LinkedCheckout, Repo, RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { PROJECT_WORKSPACE_CODE_ACTIVITY_ID } from "@diffdash/domain/project-workspace"
import { Suspense, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { installDiffDashApi } from "@/test/app-browser-support"
import { CORE_PROJECT_ACTIVITIES } from "@/extensions/core-workspace/core-workspace-extension"

import { CodeScreen } from "./code-screen"

const repo = Repo.make({
  createdAt: "2026-08-22T00:00:00Z",
  id: ReviewProjectId.make("code-screen-test"),
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

afterEach(() => {
  root?.unmount()
  root = null
  document.body.replaceChildren()
})

const deferred = <A,>() => {
  let resolve = (_value: A): void => undefined
  let reject = (_reason: Error): void => undefined
  const promise = new Promise<A>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = (reason) => promiseReject(reason)
  })
  return { promise, resolve, reject }
}

const nextFrame = () =>
  new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve())
  })

const runtimeFallback = <div>Loading runtime</div>

const renderCodeScreen = (initialSelectedPath: RepositoryRelativePath | null = null) => {
  const container = document.createElement("div")
  document.body.append(container)
  const mountedRoot = createRoot(container)
  root = mountedRoot
  const Harness = () => {
    const [selectedPath, setSelectedPath] = useState(initialSelectedPath)
    return (
      <CodeScreen
        active
        activeActivity={PROJECT_WORKSPACE_CODE_ACTIVITY_ID}
        activities={CORE_PROJECT_ACTIVITIES}
        codeThemes={DEFAULT_CODE_THEME_PREFERENCES}
        colorScheme="light"
        contextWidth={280}
        fileStatuses={new Map()}
        repo={repo}
        selectedPath={selectedPath}
        sidebarExpanded
        target={ProjectHeadCodeWorkspaceTarget.make({ projectId: repo.id })}
        threadDetailWidth={320}
        onActiveActivityChange={() => undefined}
        onLinkRepository={() => undefined}
        onSelectedPathChange={setSelectedPath}
        onSidebarExpandedChange={() => undefined}
        onSidebarWidthChange={() => undefined}
        onThreadDetailWidthChange={() => undefined}
      />
    )
  }
  mountedRoot.render(
    <Suspense fallback={runtimeFallback}>
      <Harness />
    </Suspense>,
  )
  return { container, mountedRoot }
}

describe("CodeScreen workspace lifecycle", () => {
  it("owns fatal release and coalesces repeated directory pages across lease changes", async () => {
    let listFiles = async (): Promise<LocalCheckoutFileListResult> =>
      Promise.reject(new Error("Directory unavailable"))
    const calls = installDiffDashApi({
      repositories: [repo],
      listLocalCheckoutFiles: () => listFiles(),
    })
    const fatalScreen = renderCodeScreen()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Code workspace unavailable")
      expect(calls.releaseCodeWorkspace).toHaveBeenCalledTimes(1)
    })

    fatalScreen.mountedRoot.unmount()
    root = null
    await nextFrame()
    expect(calls.releaseCodeWorkspace).toHaveBeenCalledTimes(1)
    document.body.replaceChildren()
    calls.listLocalCheckoutFiles.mockClear()
    calls.openCodeWorkspace.mockClear()
    calls.releaseCodeWorkspace.mockClear()

    const removedPath = RepositoryRelativePath.make("removed-directory/file.ts")
    let directoryCall = 0
    listFiles = async () => {
      directoryCall += 1
      if (directoryCall === 1) return LocalCheckoutFileList.make({ paths: [removedPath] })
      return Promise.reject(new Error("Directory no longer exists"))
    }
    const missingAncestorScreen = renderCodeScreen(removedPath)

    await vi.waitFor(() => expect(calls.listLocalCheckoutFiles).toHaveBeenCalledTimes(2))
    expect(document.body.textContent).not.toContain("Code workspace unavailable")
    expect(calls.releaseCodeWorkspace).not.toHaveBeenCalled()
    missingAncestorScreen.mountedRoot.unmount()
    root = null
    await nextFrame()
    document.body.replaceChildren()
    calls.listLocalCheckoutFiles.mockClear()
    calls.openCodeWorkspace.mockClear()
    calls.releaseCodeWorkspace.mockClear()

    const firstDirectory = deferred<LocalCheckoutFileListResult>()
    directoryCall = 0
    listFiles = async () => {
      directoryCall += 1
      if (directoryCall === 1) return firstDirectory.promise
      return LocalCheckoutFileList.make({ paths: [] })
    }
    const staleScreen = renderCodeScreen()

    const refresh = await vi.waitFor(() => {
      const button = staleScreen.container.querySelector<HTMLButtonElement>(
        'button[aria-label="Refresh repository files"]',
      )
      expect(button).not.toBeNull()
      return button
    })
    refresh?.click()
    await vi.waitFor(() => {
      expect(calls.openCodeWorkspace).toHaveBeenCalledTimes(2)
      expect(calls.listLocalCheckoutFiles).toHaveBeenCalledTimes(2)
      expect(calls.releaseCodeWorkspace).toHaveBeenCalledTimes(1)
    })

    firstDirectory.reject(new Error("Stale directory failure"))
    await firstDirectory.promise.catch(() => undefined)
    await nextFrame()
    await nextFrame()

    expect(document.body.textContent).not.toContain("Code workspace unavailable")
    expect(calls.releaseCodeWorkspace).toHaveBeenCalledTimes(1)
    staleScreen.mountedRoot.unmount()
    root = null
    await nextFrame()
    document.body.replaceChildren()
    calls.listLocalCheckoutFiles.mockClear()
    calls.openCodeWorkspace.mockClear()
    calls.releaseCodeWorkspace.mockClear()

    const paths = Array.from({ length: 501 }, (_, index) =>
      RepositoryRelativePath.make(`file-${index.toString().padStart(3, "0")}.ts`),
    )
    const files = LocalCheckoutFileList.make({ paths })
    const loadMore = deferred<void>()
    directoryCall = 0
    listFiles = async () => {
      directoryCall += 1
      if (directoryCall > 1) await loadMore.promise
      return files
    }
    const paginationScreen = renderCodeScreen()

    const loadMoreButton = await vi.waitFor(() => {
      const button = [
        ...paginationScreen.container.querySelectorAll<HTMLButtonElement>("button"),
      ].find((candidate) => candidate.textContent === "Load more...")
      expect(button).toBeDefined()
      return button
    })
    loadMoreButton?.click()
    loadMoreButton?.click()
    await vi.waitFor(() => expect(calls.listLocalCheckoutFiles).toHaveBeenCalledTimes(2))

    loadMore.resolve()
    await vi.waitFor(() => {
      expect(paginationScreen.container.textContent).not.toContain("Load more...")
    })
    expect(calls.listLocalCheckoutFiles).toHaveBeenCalledTimes(2)
  })
})
