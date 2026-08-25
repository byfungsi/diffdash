import { DEFAULT_CODE_THEME_PREFERENCES } from "@diffdash/domain/ai-settings"
import { CodeLineChangeRange } from "@diffdash/domain/code-line-change"
import {
  CodeWorkspaceLineChangesResult,
  ProjectHeadCodeWorkspaceTarget,
} from "@diffdash/domain/code-workspace"
import { makeHostedRepositoryLocator, HostedRepositorySource } from "@diffdash/domain/git-provider"
import {
  LocalCheckoutFileContent,
  LocalCheckoutFileList,
} from "@diffdash/domain/local-checkout-file"
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

const ownerExtensionId = TrustedExtensionId.make("diffdash.test.code-line-changes")
const ownerRegistrationToken = new TrustedExtensionRegistrationToken()
const ownedActivity = { ...CODE_PROJECT_ACTIVITY, ownerExtensionId, ownerRegistrationToken }
const ownedSurface = { ...CODE_PROJECT_SURFACE, ownerExtensionId, ownerRegistrationToken }

const repo = Repo.make({
  createdAt: "2026-08-22T00:00:00Z",
  id: ReviewProjectId.make("code-screen-line-changes-test"),
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

describe("CodeScreen line changes", () => {
  it("requests line changes for the selected project-head file", async () => {
    const path = RepositoryRelativePath.make("src/changed.ts")
    const calls = installDiffDashApi({
      repositories: [repo],
      listLocalCheckoutFiles: async () => LocalCheckoutFileList.make({ paths: [path] }),
      readLocalCheckoutFile: async () =>
        LocalCheckoutFileContent.make({ path, content: "changed\n" }),
      codeWorkspaceLineChanges: async () =>
        CodeWorkspaceLineChangesResult.make({
          changes: [CodeLineChangeRange.make({ kind: "modified", startLine: 1, endLine: 1 })],
          truncated: false,
        }),
    })
    const container = document.createElement("div")
    container.style.height = "640px"
    container.style.width = "1024px"
    document.body.append(container)
    root = createRoot(container)
    root.render(
      <Suspense fallback={<div>Loading runtime</div>}>
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
          selectedPath={path}
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

    await vi.waitFor(() => {
      expect(calls.codeWorkspaceLineChanges).toHaveBeenCalledWith({
        leaseId: expect.any(String),
        path,
      })
      expect(document.body.textContent).toContain("changed")
      expect(
        document
          .querySelector("diffs-container")
          ?.shadowRoot?.querySelector<HTMLElement>('[data-line-index="0"]')?.dataset.codeLineChange,
      ).toBe("modified")
    })
  })
})
