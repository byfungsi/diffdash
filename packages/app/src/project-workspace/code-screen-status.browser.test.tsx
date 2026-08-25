import { DEFAULT_CODE_THEME_PREFERENCES } from "@diffdash/domain/ai-settings"
import {
  CodeWorkspaceChangesResult,
  CodeWorkspaceFileChange,
  ProjectHeadCodeWorkspaceTarget,
} from "@diffdash/domain/code-workspace"
import { makeHostedRepositoryLocator, HostedRepositorySource } from "@diffdash/domain/git-provider"
import { LocalCheckoutFileList } from "@diffdash/domain/local-checkout-file"
import { LinkedCheckout, Repo, RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { HashMap } from "effect"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { Suspense } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { installDiffDashApi } from "@/test/app-browser-support"
import {
  CODE_PROJECT_ACTIVITY,
  CODE_PROJECT_SURFACE,
  PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
} from "@/extensions/code/code-extension"

import { CodeScreen } from "@/extensions/code/code-screen"
import {
  TrustedExtensionId,
  TrustedExtensionRegistrationToken,
} from "@/extensions/extension-registry"

const ownerExtensionId = TrustedExtensionId.make("diffdash.test.code-status")
const ownerRegistrationToken = new TrustedExtensionRegistrationToken()
const ownedActivity = { ...CODE_PROJECT_ACTIVITY, ownerExtensionId, ownerRegistrationToken }
const ownedSurface = { ...CODE_PROJECT_SURFACE, ownerExtensionId, ownerRegistrationToken }

const repo = Repo.make({
  createdAt: "2026-08-22T00:00:00Z",
  id: ReviewProjectId.make("code-screen-status-test"),
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

describe("CodeScreen working-tree status", () => {
  it("colors changed files and every ancestor folder", async () => {
    const modifiedPath = RepositoryRelativePath.make("packages/agent-provider/package.json")
    const addedPath = RepositoryRelativePath.make("docs/new-guide.md")
    installDiffDashApi({
      repositories: [repo],
      listLocalCheckoutFiles: async () =>
        LocalCheckoutFileList.make({ paths: [modifiedPath, addedPath] }),
      codeWorkspaceChanges: async () =>
        CodeWorkspaceChangesResult.make({
          changes: [
            CodeWorkspaceFileChange.make({ path: modifiedPath, status: "modified" }),
            CodeWorkspaceFileChange.make({ path: addedPath, status: "added" }),
          ],
          truncated: false,
        }),
    })
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    root.render(
      <Suspense fallback={runtimeFallback}>
        <CodeScreen
          active
          activeActivity={PROJECT_WORKSPACE_CODE_ACTIVITY_ID}
          activities={[ownedActivity]}
          codeThemes={DEFAULT_CODE_THEME_PREFERENCES}
          colorScheme="light"
          contextWidth={280}
          fileStatuses={HashMap.empty()}
          repo={repo}
          surfaceContribution={ownedSurface}
          selectedPath={null}
          sidebarExpanded
          target={ProjectHeadCodeWorkspaceTarget.make({ projectId: repo.id })}
          threadDetailWidth={320}
          onActiveActivityChange={() => undefined}
          onLinkRepository={() => undefined}
          onSelectedPathChange={() => undefined}
          onSidebarExpandedChange={() => undefined}
          onSidebarWidthChange={() => undefined}
          onThreadDetailWidthChange={() => undefined}
        />
      </Suspense>,
    )

    const packages = await vi.waitFor(() => {
      const row = container.querySelector<HTMLElement>('[data-item-path="packages"]')
      expect(row?.dataset.itemStatus).toBe("modified")
      return row
    })
    const docs = container.querySelector<HTMLElement>('[data-item-path="docs"]')
    expect(docs?.dataset.itemStatus).toBe("added")
    expect(packages?.querySelector("span.flex-1")?.classList).toContain("text-review-modified-text")
    expect(docs?.querySelector("span.flex-1")?.classList).toContain("text-review-success-text")

    packages?.click()
    const packageFolder = await vi.waitFor(() => {
      const row = container.querySelector<HTMLElement>('[data-item-path="packages/agent-provider"]')
      expect(row?.dataset.itemStatus).toBe("modified")
      return row
    })
    packageFolder?.click()
    await vi.waitFor(() => {
      const row = container.querySelector<HTMLElement>(
        '[data-item-path="packages/agent-provider/package.json"]',
      )
      expect(row?.dataset.itemStatus).toBe("modified")
      expect(row?.querySelector("span.flex-1")?.classList).toContain("text-review-modified-text")
    })
  })
})
