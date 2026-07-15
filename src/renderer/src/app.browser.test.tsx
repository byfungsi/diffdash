import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DiffDashApi } from "../../shared/diffdash-api"
import { AISettings, DEFAULT_AI_SETTINGS } from "../../shared/ai-settings"
import type { AppState } from "../../shared/app-state"
import {
  LinkRepositoryCommand,
  OpenBranchDiffCommand,
  OpenPullRequestCommand,
  OpenWorkingTreeCommand,
  type CliNavigationCommand,
} from "../../shared/cli-navigation"
import {
  AppUpdateAvailable,
  AppUpdateDownloaded,
  AppUpdateDownloading,
  type AppUpdateState,
  AppUpdateUnsupported,
} from "../../shared/app-update"
import { parseUnifiedDiff } from "../../shared/diff-parser"
import {
  LocalReviewDetail,
  LocalReviewDiff,
  PullRequestDetail,
  PullRequestDiff,
  PullRequestFile,
  PullRequestSummary,
  Repo,
  type RepositorySearchRequest,
  RepositorySearchResult,
  RepositorySearchScope,
  ReviewActor,
} from "../../shared/domain"
import { AppPrerequisites } from "../../shared/prerequisites"
import {
  BranchComparison,
  LocalReviewTarget,
  workingTreeReviewTarget,
} from "../../shared/local-review"
import { LocalReviewSnapshot } from "../../shared/review-context"
import { ReviewKey, ReviewRevision } from "../../shared/review-identity"
import {
  StoredWalkthrough,
  Walkthrough,
  WalkthroughChapter,
  WalkthroughGenerationDetails,
  WalkthroughStop,
  WalkthroughSupportItem,
} from "../../shared/walkthrough"
import { App, prepareReviewFileTreeInput } from "./app"
import "./styles.css"

const repo = Repo.make({
  createdAt: "2026-07-07T00:00:00Z",
  id: "repo-1",
  isFavorite: true,
  lastOpenedAt: null,
  lastSyncedAt: null,
  localPath: null,
  name: "diffdash",
  owner: "fungsi",
  provider: "github",
  remoteUrl: "https://github.com/fungsi/diffdash",
  updatedAt: "2026-07-07T00:00:00Z",
})

const staleLocalFavoriteRepo = Repo.make({
  createdAt: "2026-07-07T00:00:00Z",
  id: "local:local/diffdash-fe11f30a1061",
  isFavorite: true,
  lastOpenedAt: null,
  lastSyncedAt: null,
  localPath: "/workspace/diffdash",
  name: "diffdash-fe11f30a1061",
  owner: "local",
  provider: "local",
  remoteUrl: "file:///workspace/diffdash",
  updatedAt: "2026-07-07T00:00:00Z",
})

const pullRequest = PullRequestSummary.make({
  author: ReviewActor.make({ login: "octocat" }),
  baseRefName: "main",
  baseRefOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  body: "Please review this workspace change.",
  createdAt: "2026-07-07T00:00:00Z",
  headRefName: "feature/requested-review",
  headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  isDraft: false,
  number: 51,
  repoName: "diffdash",
  repoOwner: "fungsi",
  state: "OPEN",
  title: "Request review flow",
  updatedAt: "2026-07-07T02:00:00Z",
  url: "https://github.com/fungsi/diffdash/pull/51",
})

const detail = PullRequestDetail.make({
  ...pullRequest,
  commits: [],
  files: [
    PullRequestFile.make({
      additions: 1,
      changeType: "modified",
      deletions: 1,
      path: "src/app.tsx",
    }),
    PullRequestFile.make({
      additions: 1,
      changeType: "modified",
      deletions: 0,
      path: "docs/readme.md",
    }),
    PullRequestFile.make({
      additions: 1,
      changeType: "modified",
      deletions: 1,
      path: "pnpm-lock.yaml",
    }),
  ],
})

const diff = PullRequestDiff.make({
  diff: `diff --git a/src/app.tsx b/src/app.tsx
index 1111111..2222222 100644
--- a/src/app.tsx
+++ b/src/app.tsx
@@ -1,1 +1,1 @@
-old
+new
diff --git a/docs/readme.md b/docs/readme.md
index 3333333..4444444 100644
--- a/docs/readme.md
+++ b/docs/readme.md
@@ -1,1 +1,1 @@
-docs
+docs update
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index 5555555..6666666 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1,1 +1,1 @@
-lock old
+lock new`,
  fetchedAt: "2026-07-07T02:00:00Z",
  headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  number: 51,
  repoName: "diffdash",
  repoOwner: "fungsi",
})

const makeLargeDiffFixture = (lineCount: number, number = 52) => {
  const changedLines = Array.from(
    { length: lineCount },
    (_, index) => `-const value${index + 1} = "before"\n+const value${index + 1} = "after"`,
  ).join("\n")
  const largePath = "src/generated-large.ts"
  const tailPath = "src/tail.ts"
  const largePullRequest = PullRequestSummary.make({
    ...pullRequest,
    number,
    title: "Large diff virtualization",
  })
  const largeDetail = PullRequestDetail.make({
    ...largePullRequest,
    commits: [],
    files: [
      PullRequestFile.make({
        additions: lineCount,
        changeType: "modified",
        deletions: lineCount,
        path: largePath,
      }),
      PullRequestFile.make({
        additions: 1,
        changeType: "modified",
        deletions: 1,
        path: tailPath,
      }),
    ],
  })
  const largeDiff = PullRequestDiff.make({
    ...diff,
    diff: `diff --git a/${largePath} b/${largePath}
index 1111111..2222222 100644
--- a/${largePath}
+++ b/${largePath}
@@ -1,${lineCount} +1,${lineCount} @@
${changedLines}
diff --git a/${tailPath} b/${tailPath}
index 3333333..4444444 100644
--- a/${tailPath}
+++ b/${tailPath}
@@ -1,1 +1,1 @@
-tail before
+tail after`,
    number: largePullRequest.number,
  })

  return { largeDetail, largeDiff, largePath, largePullRequest, tailPath }
}

const localReview = LocalReviewDetail.make({
  baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  branchName: "feature/local-review",
  diffHash: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  fetchedAt: "2026-07-07T04:00:00Z",
  files: [
    PullRequestFile.make({
      additions: 1,
      changeType: "modified",
      deletions: 1,
      path: "src/local.ts",
    }),
  ],
  headSha: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  repoName: "local-repo",
  rootPath: "/workspace/local-repo",
  title: "Local changes",
})

const localDiff = LocalReviewDiff.make({
  baseSha: localReview.baseSha,
  diff: `diff --git a/src/local.ts b/src/local.ts
index 1111111..2222222 100644
--- a/src/local.ts
+++ b/src/local.ts
@@ -1,1 +1,1 @@
-old local
+new local`,
  diffHash: localReview.diffHash,
  fetchedAt: localReview.fetchedAt,
  headSha: localReview.headSha,
  rootPath: localReview.rootPath,
})

const generatedLocalHeadSha = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"

const walkthrough = StoredWalkthrough.make({
  baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  createdAt: "2026-07-08T00:00:00Z",
  headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  prNumber: 51,
  promptVersion: "walkthrough-v2",
  repoId: "repo-1",
  reviewKey: "github:fungsi/diffdash#51",
  walkthrough: Walkthrough.make({
    title: "Review path",
    summary: "Review the app entry point first, then skim supporting docs.",
    chapters: [
      WalkthroughChapter.make({
        id: "c1",
        title: "Runtime",
        summary: "Runtime behavior changes.",
        stops: [
          WalkthroughStop.make({
            hunkIds: ["src/app.tsx:pull-request:51:h1"],
            id: "s1",
            risk: "critical",
            summary: "The app entry point owns the behavior change.",
            title: "Entry point",
          }),
        ],
      }),
    ],
    support: [
      WalkthroughSupportItem.make({
        hunkIds: ["docs/readme.md:pull-request:51:h1"],
        id: "support-docs",
        reason: "Docs support the behavior change.",
        title: "Documentation",
      }),
    ],
  }),
})

const sampledWalkthrough = StoredWalkthrough.make({
  ...walkthrough,
  walkthrough: Walkthrough.make({
    ...walkthrough.walkthrough,
    generation: WalkthroughGenerationDetails.make({
      mode: "sampled-tree",
      totalFiles: 1_000,
      analyzedFiles: 42,
      totalFolders: 45,
      analyzedFolders: 31,
    }),
  }),
})

const localWalkthrough = StoredWalkthrough.make({
  baseSha: localReview.baseSha,
  createdAt: "2026-07-08T01:00:00Z",
  headSha: generatedLocalHeadSha,
  prNumber: null,
  promptVersion: "walkthrough-v2",
  repoId: "local-repo-1",
  reviewKey: "local:local-repo",
  walkthrough: Walkthrough.make({
    title: "Local review path",
    summary: "Review local changes in working tree order.",
    chapters: [
      WalkthroughChapter.make({
        id: "c1",
        title: "Local",
        summary: "Local code changes.",
        stops: [
          WalkthroughStop.make({
            hunkIds: [`src/local.ts:local-diff:${generatedLocalHeadSha}:h1`],
            id: "s1",
            risk: "review",
            summary: "Local file change.",
            title: "Local file",
          }),
        ],
      }),
    ],
    support: [],
  }),
})

const remoteSearchResult = RepositorySearchResult.make({
  description: "Remote review target",
  isPrivate: false,
  name: "remote-review",
  nameWithOwner: "fungsi/remote-review",
  owner: "fungsi",
  updatedAt: "2026-07-07T03:00:00Z",
  url: "https://github.com/fungsi/remote-review",
})

const readyPrerequisites = AppPrerequisites.make({
  checkedAt: "2026-07-08T00:00:00Z",
  codingAgentInstalled: true,
  diffDashCliInstalled: true,
  diffDashCliInPath: true,
  diffDashCliPath: "/usr/local/bin/diffdash",
  gitInstalled: true,
  ghAuthenticated: true,
  ghInstalled: true,
  ghSearchRepositoriesAvailable: true,
  ghSupported: true,
  ghVersion: "2.76.1",
  installedCodingAgents: ["codex"],
})

const missingPrerequisites = AppPrerequisites.make({
  checkedAt: "2026-07-08T00:00:00Z",
  codingAgentInstalled: false,
  diffDashCliInstalled: false,
  diffDashCliInPath: false,
  diffDashCliPath: null,
  gitInstalled: false,
  ghAuthenticated: false,
  ghInstalled: false,
  ghSearchRepositoriesAvailable: false,
  ghSupported: false,
  ghVersion: null,
  installedCodingAgents: [],
})

const noAgentPrerequisites = AppPrerequisites.make({
  ...readyPrerequisites,
  codingAgentInstalled: false,
  installedCodingAgents: [],
})

let root: Root | null = null

afterEach(() => {
  root?.unmount()
  root = null
  vi.restoreAllMocks()
  document.documentElement.classList.remove("dark")
  document.documentElement.style.colorScheme = ""
  document.body.replaceChildren()
})

describe("App browser interactions", () => {
  it("sorts non-contiguous directory paths before constructing the file tree", () => {
    const prepared = prepareReviewFileTreeInput([
      "src/main/services/database.ts",
      "web/landing/src/App.tsx",
      "src/main/services/agent-run-store.ts",
    ])

    expect(prepared.paths).toEqual([
      "src/main/services/agent-run-store.ts",
      "src/main/services/database.ts",
      "web/landing/src/App.tsx",
    ])
  })

  it("applies the configured appearance without rendering a theme selector", async () => {
    installDiffDashApi({
      settings: AISettings.make({ ...DEFAULT_AI_SETTINGS, appearance: "dark" }),
    })
    renderApp()

    await vi.waitFor(() => {
      expect(document.documentElement.classList.contains("dark")).toBe(true)
      expect(document.documentElement.style.colorScheme).toBe("dark")
    })
    expect(document.querySelector('button[aria-label^="Use "][aria-label$=" theme"]')).toBeNull()
  })

  it("shows first-run onboarding and lets the user continue", async () => {
    const calls = installDiffDashApi({
      appState: { onboardingCompleted: false },
      diagnostics: missingPrerequisites,
    })
    renderApp()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Set up DiffDash")
      expect(document.body.textContent).toContain("GitHub CLI supported")
      expect(document.body.textContent).toContain("Coding agent installed")
      expect(document.body.textContent).not.toContain("Bookmarked Repos")
    })

    const docsButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "GitHub CLI docs",
    )
    docsButton?.click()
    expect(calls.openExternalUrl).toHaveBeenCalledWith("https://cli.github.com/")

    const installButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Install in PATH",
    )
    installButton?.click()
    await vi.waitFor(() => {
      expect(calls.installDiffDashCli).toHaveBeenCalled()
      expect(document.body.textContent).toContain("Installed diffdash at /usr/local/bin/diffdash")
    })

    const continueButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Continue to DiffDash",
    )
    expect(continueButton).toBeDefined()
    continueButton?.click()

    await vi.waitFor(() => {
      expect(calls.updateAppState).toHaveBeenCalledWith({ onboardingCompleted: true })
      expect(calls.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ telemetryEnabled: true }),
      )
      expect(calls.startAnalytics).toHaveBeenCalled()
      expect(calls.captureAnalytics).toHaveBeenCalledWith({ event: "onboarding_completed" })
      expect(document.body.textContent).toContain("Bookmarked Repos")
    })
  })

  it("shows the shell command when the CLI directory is not in PATH", async () => {
    const pathSetupCommand = `export PATH='$HOME/.local/bin':$PATH`
    installDiffDashApi({
      appState: { onboardingCompleted: false },
      cliInstallResult: { path: "/home/user/.local/bin/diffdash", pathSetupCommand },
      diagnostics: missingPrerequisites,
    })
    renderApp()

    await vi.waitFor(() => expect(document.body.textContent).toContain("Set up DiffDash"))
    const installButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Install in PATH",
    )
    installButton?.click()

    await vi.waitFor(() => expect(document.body.textContent).toContain(pathSetupCommand))
  })

  it("persists an onboarding telemetry opt-out without sending events", async () => {
    const calls = installDiffDashApi({ appState: { onboardingCompleted: false } })
    renderApp()

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Share anonymous usage data"),
    )
    const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(checkbox?.checked).toBe(true)
    checkbox?.click()

    const continueButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Continue to DiffDash",
    )
    expect(continueButton).toBeDefined()
    continueButton?.click()

    await vi.waitFor(() => {
      expect(calls.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ telemetryEnabled: false }),
      )
      expect(calls.captureAnalytics).not.toHaveBeenCalled()
    })
  })

  it("shows a Home banner while setup requirements are missing", async () => {
    const calls = installDiffDashApi({ diagnostics: missingPrerequisites })
    renderApp()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Finish setup")
      expect(document.body.textContent).toContain("git was not found in PATH")
      expect(document.body.textContent).toContain("gh was not found in PATH")
      expect(document.body.textContent).toContain("Walkthroughs require Codex, Claude, or OpenCode")
    })

    const authDocsButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Auth docs",
    )
    authDocsButton?.click()
    expect(calls.openExternalUrl).toHaveBeenCalledWith(
      "https://cli.github.com/manual/gh_auth_login",
    )
  })

  it("shows an actionable error for an unsupported GitHub CLI version", async () => {
    installDiffDashApi({
      diagnostics: AppPrerequisites.make({
        ...readyPrerequisites,
        ghSupported: false,
        ghVersion: "1.14.0",
      }),
    })
    renderApp()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain(
        "GitHub CLI 2.7.0 or newer is required for repository search. Found 1.14.0. Update gh, then restart DiffDash.",
      )
    })
  })

  it("asks before downloading an update and restarts only after it is ready", async () => {
    const calls = installDiffDashApi({
      updateState: AppUpdateAvailable.make({ currentVersion: "0.1.4", version: "0.1.5" }),
    })
    renderApp()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("DiffDash v0.1.5 is available")
    })
    const downloadButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Download update",
    )
    downloadButton?.click()
    expect(calls.downloadUpdate).toHaveBeenCalledTimes(1)

    calls.emitUpdateState(
      AppUpdateDownloading.make({
        currentVersion: "0.1.4",
        percent: 48.4,
        version: "0.1.5",
      }),
    )
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("48% downloaded")
    })

    calls.emitUpdateState(AppUpdateDownloaded.make({ currentVersion: "0.1.4", version: "0.1.5" }))
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("DiffDash v0.1.5 is ready")
    })
    const restartButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Restart and update",
    )
    restartButton?.click()
    expect(calls.restartAndInstallUpdate).toHaveBeenCalledTimes(1)
  })

  it("debounces remote repository search and sends the displayed owner set", async () => {
    const calls = installDiffDashApi()
    renderApp()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Bookmarked Repos")
    })
    const searchInput = document.querySelector<HTMLInputElement>(
      'input[placeholder="Search bookmarked and accessible repositories"]',
    )
    expect(searchInput).not.toBeNull()
    if (searchInput === null) return

    for (const value of ["own", "owner", "owners"]) {
      setInputValue(searchInput, value)
      searchInput.dispatchEvent(new Event("input", { bubbles: true }))
    }

    await vi.waitFor(() => {
      expect(calls.searchRepositories).toHaveBeenCalledTimes(1)
    })
    expect(calls.searchRepositories).toHaveBeenLastCalledWith({
      owners: ["hanipcode", "fungsi"],
      query: "owners",
    })

    const fungsiScope = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "fungsi",
    )
    expect(fungsiScope).toBeDefined()
    fungsiScope?.click()

    await vi.waitFor(() => {
      expect(calls.searchRepositories).toHaveBeenCalledTimes(2)
    })
    expect(calls.searchRepositories).toHaveBeenLastCalledWith({
      owners: ["fungsi"],
      query: "owners",
    })
  })

  it("shows GitHub search failures instead of an empty result", async () => {
    const calls = installDiffDashApi()
    calls.searchRepositories.mockRejectedValue(new Error("GitHub search is unavailable"))
    renderApp()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Bookmarked Repos")
    })
    const searchInput = document.querySelector<HTMLInputElement>(
      'input[placeholder="Search bookmarked and accessible repositories"]',
    )
    expect(searchInput).not.toBeNull()
    if (searchInput === null) return
    setInputValue(searchInput, "failure-state")
    searchInput.dispatchEvent(new Event("input", { bubbles: true }))

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("GitHub search is unavailable")
    })
    expect(document.body.textContent).toContain("Bookmarked repo")
    expect(document.body.textContent).not.toContain("No matching repos found")
  })

  it("disables the walkthrough tab when no coding agent is installed", async () => {
    const calls = installDiffDashApi({ diagnostics: noAgentPrerequisites })
    renderApp()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Bookmarked Repos")
    })

    const reviewButton = [...document.querySelectorAll("button")].find((button) =>
      button.getAttribute("aria-label")?.includes("Open requested review #51"),
    )
    reviewButton?.click()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Opened PR #51")
      expect(document.body.textContent).toContain("Walkthroughs require Codex, Claude, or OpenCode")
    })

    const walkthroughTab = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Walkthrough",
    )
    expect(walkthroughTab).toBeDefined()
    expect(walkthroughTab?.disabled).toBe(true)
    walkthroughTab?.click()
    expect(calls.getWalkthrough).not.toHaveBeenCalled()
  })

  it("explains sampled coverage for unusually large walkthroughs", async () => {
    installDiffDashApi({ walkthrough: sampledWalkthrough })
    renderApp()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Recent Review Requests")
    })
    const reviewButton = [...document.querySelectorAll("button")].find((button) =>
      button.getAttribute("aria-label")?.includes("Open requested review #51"),
    )
    reviewButton?.click()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Opened PR #51")
    })
    const walkthroughTab = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Walkthrough",
    )
    walkthroughTab?.click()

    await vi.waitFor(() => {
      expect(document.querySelector("[data-sampled-walkthrough-notice]")).not.toBeNull()
      expect(document.body.textContent).toContain("Sampled walkthrough")
      expect(document.body.textContent).toContain("analyzed 42 of 1,000 changed files")
      expect(document.body.textContent).toContain("31 of 45 folders")
      expect(document.body.textContent).toContain("Use the file tree to inspect every change")
    })
  })

  it("does not render or query stale local-provider favorites", async () => {
    const calls = installDiffDashApi({ repositories: [repo, staleLocalFavoriteRepo] })
    renderApp()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Bookmarked Repos")
      expect(document.body.textContent).toContain("fungsi/diffdash")
      expect(document.body.textContent).not.toContain("local/diffdash-fe11f30a1061")
    })

    calls.listPullRequests.mockClear()
    const repoButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("fungsi/diffdash") ?? false,
    )
    expect(repoButton).toBeDefined()
    repoButton?.click()

    await vi.waitFor(() => {
      expect(calls.listPullRequests).toHaveBeenCalledWith("fungsi", "diffdash")
    })
    expect(calls.listPullRequests).not.toHaveBeenCalledWith("local", "diffdash-fe11f30a1061")
  })

  it("shows, closes, and links the sticky unlinked-repository banner", async () => {
    const calls = installDiffDashApi()
    calls.selectLocalFolder.mockResolvedValue("/workspace/diffdash")
    renderApp()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Recent Review Requests")
    })
    const reviewButton = [...document.querySelectorAll("button")].find((button) =>
      button.getAttribute("aria-label")?.includes("Open requested review #51"),
    )
    reviewButton?.click()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Link a checkout for isolated agent review")
    })
    const linkButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Link folder",
    )
    linkButton?.click()

    await vi.waitFor(() => {
      expect(calls.linkRepository).toHaveBeenCalledWith({
        owner: "fungsi",
        name: "diffdash",
        localPath: "/workspace/diffdash",
      })
      expect(document.body.textContent).not.toContain("Link a checkout for isolated agent review")
    })

    calls.openLocalReview()
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Opened local changes")
      expect(document.body.textContent).not.toContain("Link a checkout for isolated agent review")
    })
  })

  it("dismisses an unlinked-repository banner without invoking the folder picker", async () => {
    const calls = installDiffDashApi()
    renderApp()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Recent Review Requests")
    })
    const reviewButton = [...document.querySelectorAll("button")].find((button) =>
      button.getAttribute("aria-label")?.includes("Open requested review #51"),
    )
    reviewButton?.click()
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Link a checkout for isolated agent review")
    })

    document
      .querySelector<HTMLButtonElement>('button[aria-label="Dismiss local repository banner"]')
      ?.click()

    await vi.waitFor(() => {
      expect(document.body.textContent).not.toContain("Link a checkout for isolated agent review")
    })
    expect(calls.selectLocalFolder).not.toHaveBeenCalled()
  })

  it("handles a repository link requested by the diffdash install command", async () => {
    const calls = installDiffDashApi()
    renderApp()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Bookmarked Repos")
    })
    calls.linkRepositoryFromCli("/workspace/diffdash")

    await vi.waitFor(() => {
      expect(calls.installRepository).toHaveBeenCalledWith("/workspace/diffdash")
      expect(document.body.textContent).toContain("1 open PR in fungsi/diffdash")
    })
  })

  it("opens a repository PR list from the CLI command", async () => {
    const calls = installDiffDashApi()
    renderApp()

    await vi.waitFor(() => expect(document.body.textContent).toContain("Bookmarked Repos"))
    calls.openPullRequest(null, "/workspace/diffdash")

    await vi.waitFor(() => {
      expect(calls.installRepository).toHaveBeenCalledWith("/workspace/diffdash")
      expect(document.body.textContent).toContain("1 open PR in fungsi/diffdash")
    })
  })

  it("opens a numbered PR from the CLI command", async () => {
    const calls = installDiffDashApi()
    renderApp()

    await vi.waitFor(() => expect(document.body.textContent).toContain("Bookmarked Repos"))
    calls.openPullRequest(51, "/workspace/diffdash")

    await vi.waitFor(() => {
      expect(calls.installRepository).toHaveBeenCalledWith("/workspace/diffdash")
      expect(document.body.textContent).toContain("Opened PR #51")
    })
  })

  it("shows the actionable repository reason for a failed PR CLI command", async () => {
    const calls = installDiffDashApi()
    calls.installRepository.mockRejectedValueOnce(
      new Error(
        `repositories:install failed: (FiberFailure) RepositoryLinkError: { "operation": "detectRepository", "reason": "Select a Git repository with a GitHub origin.", "cause": {} } at internal stack`,
      ),
    )
    renderApp()

    await vi.waitFor(() => expect(document.body.textContent).toContain("Bookmarked Repos"))
    calls.openPullRequest(3, "/workspace/diffdash")

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain(
        "Could not open repository pull requests: Select a Git repository with a GitHub origin.",
      )
      expect(document.body.textContent).not.toContain("internal stack")
    })
  })

  it("opens a fetched branch comparison from the diff CLI command", async () => {
    const calls = installDiffDashApi()
    renderApp()

    await vi.waitFor(() => expect(document.body.textContent).toContain("Bookmarked Repos"))
    calls.openBranchDiff("dev")

    await vi.waitFor(() => {
      expect(calls.resolveBranch).toHaveBeenCalledWith(localReview.rootPath, "dev")
      expect(calls.getLocalReviewDetail).toHaveBeenCalledWith(
        expect.objectContaining({
          comparison: expect.objectContaining({ branchName: "dev" }),
        }),
      )
      expect(document.body.textContent).toContain("Changes vs dev")
      expect(document.body.textContent).toContain("vs dev")
    })
  })

  it("keeps a file-tree selection stable while the diff pane scrolls", async () => {
    installDiffDashApi()
    renderApp()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Recent Review Requests")
    })
    const reviewButton = [...document.querySelectorAll("button")].find((button) =>
      button.getAttribute("aria-label")?.includes("Open requested review #51"),
    )
    reviewButton?.click()

    await vi.waitFor(() => {
      expect(getDiffCardPaths()).toEqual(["src/app.tsx", "docs/readme.md"])
      expect(getChangedFilesTreeItem("docs/readme.md")).not.toBeNull()
    })

    const diffPane = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
    const firstCard = document.querySelector<HTMLElement>('[data-diff-card-path="src/app.tsx"]')
    const docsTreeItem = getChangedFilesTreeItem("docs/readme.md")
    expect(diffPane).not.toBeNull()
    expect(firstCard).not.toBeNull()
    expect(docsTreeItem).not.toBeNull()
    if (diffPane === null || firstCard === null || docsTreeItem === null) return

    const elementFromPoint = vi.spyOn(document, "elementFromPoint").mockReturnValue(firstCard)
    diffPane.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: 400,
        clientY: 300,
        composed: true,
        pointerType: "mouse",
      }),
    )
    diffPane.dispatchEvent(
      new PointerEvent("pointerout", {
        bubbles: true,
        composed: true,
        pointerType: "mouse",
        relatedTarget: docsTreeItem,
      }),
    )

    const scrollTo = vi.spyOn(diffPane, "scrollTo")
    docsTreeItem.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }))

    await vi.waitFor(() => {
      expect(document.querySelector('[data-selected-review-path="docs/readme.md"]')).not.toBeNull()
      expect(scrollTo).toHaveBeenCalledTimes(1)
    })

    diffPane.dispatchEvent(new Event("scroll", { bubbles: true }))
    diffPane.dispatchEvent(new Event("scroll", { bubbles: true }))
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))

    expect(elementFromPoint).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-selected-review-path="docs/readme.md"]')).not.toBeNull()
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })

  it("keeps large diffs in memory while virtualizing their rendered lines", async () => {
    const lineCount = 3_000
    const fixture = makeLargeDiffFixture(lineCount)
    installDiffDashApi({
      pullRequestDetail: fixture.largeDetail,
      pullRequestDiff: fixture.largeDiff,
      reviewRequests: [fixture.largePullRequest],
    })
    renderApp()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Recent Review Requests")
    })
    const reviewButton = [...document.querySelectorAll("button")].find((button) =>
      button.getAttribute("aria-label")?.includes("Open requested review #52"),
    )
    reviewButton?.click()

    await vi.waitFor(() => {
      expect(getDiffCardPaths()).toEqual([fixture.largePath, fixture.tailPath])
      expect(getChangedFilesTreeItem(fixture.tailPath)).not.toBeNull()
      expect(getMountedDiffLineCount()).toBeGreaterThan(0)
    })

    const initialMountedLineCount = getMountedDiffLineCount()
    expect(initialMountedLineCount).toBeLessThan(500)
    const largeDiffElement = document.querySelector(
      `[data-diff-card-path="${fixture.largePath}"] diffs-container`,
    )
    expect(largeDiffElement).not.toBeNull()
    expect(
      document
        .querySelector(`[data-diff-card-path="${fixture.largePath}"]`)
        ?.getAttribute("data-diff-render-mode"),
    ).toBe("highlighted")
    await new Promise((resolve) => window.setTimeout(resolve, 300))
    expect(
      document.querySelector(`[data-diff-card-path="${fixture.largePath}"] diffs-container`),
    ).toBe(largeDiffElement)

    const diffPane = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
    const tailTreeItem = getChangedFilesTreeItem(fixture.tailPath)
    expect(diffPane).not.toBeNull()
    expect(tailTreeItem).not.toBeNull()
    const scrollTo = diffPane === null ? null : vi.spyOn(diffPane, "scrollTo")
    tailTreeItem?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }))

    await vi.waitFor(() => {
      expect(
        document.querySelector(`[data-selected-review-path="${fixture.tailPath}"]`),
      ).not.toBeNull()
      expect(scrollTo).toHaveBeenCalledTimes(1)
    })
    scrollTo?.mockRestore()
    if (diffPane !== null) {
      diffPane.scrollTo({ behavior: "instant", top: diffPane.scrollHeight })
    }
    await vi.waitFor(
      () => {
        const tailCard = document.querySelector<HTMLElement>(
          `[data-diff-card-path="${fixture.tailPath}"]`,
        )
        if (
          diffPane !== null &&
          tailCard !== null &&
          tailCard.getBoundingClientRect().top > diffPane.getBoundingClientRect().bottom
        ) {
          diffPane.scrollTo({ behavior: "instant", top: diffPane.scrollHeight })
        }
        expect(getDiffShadowRoot(fixture.tailPath)?.textContent).toContain("tail after")
      },
      { timeout: 3_000 },
    )
    expect(getMountedDiffLineCount()).toBeLessThan(500)

    const filterInput = document.querySelector<HTMLInputElement>(
      'input[placeholder="Filter files"]',
    )
    expect(filterInput).not.toBeNull()
    if (filterInput !== null) {
      setInputValue(filterInput, "generated-large")
      filterInput.dispatchEvent(new Event("input", { bubbles: true }))
    }
    await vi.waitFor(() => {
      expect(getDiffCardPaths()).toEqual([fixture.largePath])
    })
  })

  it("renders very large files without whole-file syntax highlighting", async () => {
    const fixture = makeLargeDiffFixture(10_001, 53)
    installDiffDashApi({
      pullRequestDetail: fixture.largeDetail,
      pullRequestDiff: fixture.largeDiff,
      reviewRequests: [fixture.largePullRequest],
    })
    renderApp()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Recent Review Requests")
    })
    const reviewButton = [...document.querySelectorAll("button")].find((button) =>
      button.getAttribute("aria-label")?.includes("Open requested review #53"),
    )
    reviewButton?.click()

    await vi.waitFor(
      () => {
        expect(
          document
            .querySelector(`[data-diff-card-path="${fixture.largePath}"]`)
            ?.getAttribute("data-diff-render-mode"),
        ).toBe("plain")
        expect(getMountedDiffLineCount()).toBeGreaterThan(0)
        expect(getMountedDiffLineCount()).toBeLessThan(500)
      },
      { timeout: 5_000 },
    )
  })

  it("covers FUN-40/FUN-42/FUN-41/FUN-25/FUN-26 criteria from Home to Review", async () => {
    const calls = installDiffDashApi()
    renderApp()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Bookmarked Repos")
      expect(document.body.textContent).toContain("Recent Review Requests")
      expect(document.body.textContent).not.toContain("Recently Reviewed")
      expect(document.body.textContent).toContain("Request review flow")
      expect(document.body.textContent).toContain("fungsi/diffdash #51")
    })

    const searchInput = document.querySelector<HTMLInputElement>(
      'input[placeholder="Search bookmarked and accessible repositories"]',
    )
    expect(searchInput).not.toBeNull()
    if (searchInput !== null) {
      setInputValue(searchInput, "review")
      searchInput.dispatchEvent(new Event("input", { bubbles: true }))
    }

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Bookmarked repo")
      expect(document.body.textContent).toContain("fungsi/remote-review")
      expect(document.body.textContent).not.toContain("Search Results")
    })

    calls.listPullRequests.mockClear()
    dispatchKeyboardShortcut("k", { metaKey: true })
    await vi.waitFor(() => {
      expect(document.querySelector('dialog[aria-label="Go anywhere"]')).not.toBeNull()
    })
    const repoPaletteButton = [
      ...document.querySelectorAll<HTMLButtonElement>("dialog button"),
    ].find((button) => button.textContent?.includes("Remote bookmarked repository") ?? false)
    expect(repoPaletteButton).toBeDefined()
    repoPaletteButton?.click()

    await vi.waitFor(() => {
      expect(calls.listPullRequests).toHaveBeenCalledWith("fungsi", "diffdash")
      expect(document.body.textContent).toContain("1 open PR in fungsi/diffdash")
    })

    dispatchKeyboardShortcut("k", { metaKey: true })
    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLInputElement>(
          'dialog input[placeholder="Search repos and PRs"]',
        ),
      ).not.toBeNull()
    })
    const commandInput = document.querySelector<HTMLInputElement>("dialog input")
    expect(commandInput).not.toBeNull()
    if (commandInput !== null) {
      setInputValue(commandInput, "Request")
      commandInput.dispatchEvent(new Event("input", { bubbles: true }))
    }
    const reviewPaletteButton = [
      ...document.querySelectorAll<HTMLButtonElement>("dialog button"),
    ].find((button) => button.textContent?.includes("#51 Request review flow") ?? false)
    expect(reviewPaletteButton).toBeDefined()
    reviewPaletteButton?.click()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Opened PR #51")
      expect(document.body.textContent).toContain("src/app.tsx")
      expect(document.body.textContent).toContain("Viewed")
      expect(document.body.textContent).toContain("+1")
      expect(document.body.textContent).toContain("-1")
      expect(document.body.textContent).not.toContain("Review comment")
      expect(document.body.textContent).not.toContain("File comment")
      expect(document.body.textContent).not.toContain("Hunk 1")
      expect(document.body.textContent).not.toContain("Select a line number to comment inline")
      expect(getDiffCardPaths()).toEqual(["src/app.tsx", "docs/readme.md"])
      expect(getDiffCardPaths()).not.toContain("pnpm-lock.yaml")
    })

    await new Promise((resolve) => window.setTimeout(resolve, 100))
    await vi.waitFor(() => {
      const shadowRoot = getDiffShadowRoot("src/app.tsx")
      expect(shadowRoot).not.toBeNull()
      expect(shadowRoot === null ? null : getDiffLine(shadowRoot, "new")).not.toBeNull()
    })
    const diffShadow = getDiffShadowRoot("src/app.tsx")
    expect(diffShadow).not.toBeNull()
    const addedLine = getDiffLine(diffShadow!, "new")
    const lineNumber = addedLine?.getAttribute("data-line")
    const addedLineIndex = addedLine?.getAttribute("data-line-index")
    expect(addedLine).not.toBeNull()
    expect(lineNumber).toBe("1")
    const gutterNumber = [
      ...diffShadow!.querySelectorAll<HTMLElement>("[data-column-number]"),
    ].find(
      (element) =>
        element.getAttribute("data-column-number") === lineNumber &&
        element.getAttribute("data-line-index") === addedLineIndex,
    )
    expect(gutterNumber).not.toBeUndefined()
    gutterNumber?.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, composed: true, pointerType: "mouse" }),
    )
    await vi.waitFor(() => {
      expect(diffShadow!.querySelector("[data-utility-button]")).not.toBeNull()
    })
    const gutterUtility = diffShadow!.querySelector<HTMLButtonElement>("[data-utility-button]")
    expect(gutterUtility).not.toBeNull()
    clickGutterUtility(gutterUtility!)
    await vi.waitFor(() => {
      expect(document.querySelector('textarea[aria-label="Thread message"]')).not.toBeNull()
    })
    const refreshedGutterNumber = [
      ...diffShadow!.querySelectorAll<HTMLElement>("[data-column-number]"),
    ].find(
      (element) =>
        element.getAttribute("data-column-number") === lineNumber &&
        element.getAttribute("data-line-index") === addedLineIndex,
    )
    refreshedGutterNumber?.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, composed: true, pointerType: "mouse" }),
    )
    await vi.waitFor(() => {
      expect(diffShadow!.querySelector("[data-utility-button]")).not.toBeNull()
    })
    clickGutterUtility(diffShadow!.querySelector<HTMLButtonElement>("[data-utility-button]")!)
    await vi.waitFor(() => {
      expect(document.querySelector('textarea[aria-label="Thread message"]')).toBeNull()
    })

    getDiffLine(diffShadow!, "new")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, composed: true }),
    )
    await vi.waitFor(() => {
      expect(document.querySelector('textarea[aria-label="Thread message"]')).not.toBeNull()
    })
    getDiffLine(diffShadow!, "new")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, composed: true }),
    )
    await vi.waitFor(() => {
      expect(document.querySelector('textarea[aria-label="Thread message"]')).toBeNull()
    })

    const actionsButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Actions") ?? false,
    )
    expect(actionsButton).toBeDefined()
    actionsButton?.click()
    await vi.waitFor(() => {
      const menu = document.querySelector('[role="menu"][aria-label="Review actions"]')
      expect(menu).not.toBeNull()
      expect(menu?.textContent).toContain("Reload diff")
      expect(menu?.textContent).toContain("Approve")
      expect(menu?.textContent).toContain("Regenerate walkthrough")
      expect(menu?.textContent).toContain("Mark all viewed")
      expect(menu?.textContent).toContain("Reveal hidden files")
    })
    actionsButton?.click()

    calls.getPullRequestDetail.mockClear()
    calls.getPullRequestDiff.mockClear()
    dispatchKeyboardShortcut("k", { metaKey: true, shiftKey: true })
    await vi.waitFor(() => {
      expect(document.querySelector('dialog[aria-label="Review actions"]')).not.toBeNull()
    })
    const reloadAction = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find(
      (button) => button.textContent?.includes("Reload diff") ?? false,
    )
    expect(reloadAction).toBeDefined()
    reloadAction?.click()

    await vi.waitFor(() => {
      expect(calls.getPullRequestDetail).toHaveBeenCalledWith("fungsi", "diffdash", 51)
      expect(calls.getPullRequestDiff).toHaveBeenCalledWith("fungsi", "diffdash", 51)
      expect(getDiffCardPaths()).toEqual(["src/app.tsx", "docs/readme.md"])
    })

    dispatchKeyboardShortcut("v")
    await vi.waitFor(() => {
      expect(getViewedCheckbox("src/app.tsx")?.checked).toBe(true)
      expect(document.body.textContent).toContain("Marked src/app.tsx as viewed")
    })

    const reviewFilterInput = document.querySelector<HTMLInputElement>(
      'input[placeholder="Filter files"]',
    )
    expect(reviewFilterInput).not.toBeNull()
    reviewFilterInput?.focus()
    if (reviewFilterInput !== null) {
      reviewFilterInput.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "v" }),
      )
    }
    expect(getViewedCheckbox("src/app.tsx")?.checked).toBe(true)

    dispatchKeyboardShortcut("k", { metaKey: true, shiftKey: true })
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Mark all viewed")
    })
    const revealHiddenAction = [
      ...document.querySelectorAll<HTMLButtonElement>("dialog button"),
    ].find((button) => button.textContent?.includes("Reveal hidden files") ?? false)
    expect(revealHiddenAction).toBeDefined()
    revealHiddenAction?.click()

    await vi.waitFor(() => {
      expect(getDiffCardPaths()).toContain("pnpm-lock.yaml")
      expect(document.body.textContent).toContain("Revealed 1 hidden file")
    })

    dispatchKeyboardShortcut("k", { metaKey: true })
    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLInputElement>(
          'dialog input[placeholder="Search files and walkthrough sections"]',
        ),
      ).not.toBeNull()
    })
    const reviewCommandInput = document.querySelector<HTMLInputElement>("dialog input")
    expect(reviewCommandInput).not.toBeNull()
    if (reviewCommandInput !== null) {
      setInputValue(reviewCommandInput, "docs/readme")
      reviewCommandInput.dispatchEvent(new Event("input", { bubbles: true }))
    }
    const docsPaletteButton = [
      ...document.querySelectorAll<HTMLButtonElement>("dialog button"),
    ].find((button) => button.textContent?.includes("docs/readme.md") ?? false)
    expect(docsPaletteButton).toBeDefined()
    docsPaletteButton?.click()

    await vi.waitFor(() => {
      expect(document.querySelector('[data-selected-review-path="docs/readme.md"]')).not.toBeNull()
    })

    actionsButton?.click()
    await vi.waitFor(() => {
      expect(document.body.textContent).not.toContain("Request changes")
      expect(
        document.querySelector<HTMLButtonElement>(
          '[role="menu"][aria-label="Review actions"] button[role="menuitem"]:not(:disabled)',
        ),
      ).not.toBeNull()
    })
    const approveButton = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[role="menu"][aria-label="Review actions"] button',
      ),
    ].find((button) => button.textContent?.startsWith("Approve") ?? false)
    expect(approveButton?.disabled).toBe(false)
    approveButton?.click()

    await vi.waitFor(() => {
      expect(calls.approvePullRequest).toHaveBeenCalledWith("fungsi", "diffdash", 51)
    })
    actionsButton?.click()
    await vi.waitFor(() => {
      const approvedButton = [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[role="menu"][aria-label="Review actions"] button',
        ),
      ].find((button) => button.textContent?.startsWith("Approve") ?? false)
      expect(approvedButton).toBeDefined()
      expect(approvedButton?.disabled).toBe(true)
    })

    const walkthroughTab = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Walkthrough",
    )
    expect(walkthroughTab).toBeDefined()
    walkthroughTab?.click()

    await vi.waitFor(() => {
      expect(calls.getWalkthrough).toHaveBeenCalledWith(
        "fungsi",
        "diffdash",
        51,
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      )
      expect(calls.generateWalkthrough).not.toHaveBeenCalled()
      expect(document.body.textContent).toContain("Review focus")
      expect(document.body.textContent).toContain("Diff-only")
      expect(document.body.textContent).toContain("Entry point")
      expect(document.body.textContent).toContain("CRITICAL")
      expect(
        document.querySelector(
          '[data-diff-card-path="src/app.tsx"] button[aria-label="Collapse diff"]',
        ),
      ).not.toBeNull()
      expect(getDiffCardPaths()).toEqual(["src/app.tsx"])
    })

    dispatchKeyboardShortcut("k", { metaKey: true })
    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLInputElement>(
          'dialog input[placeholder="Search files and walkthrough sections"]',
        ),
      ).not.toBeNull()
    })
    const walkthroughCommandInput = document.querySelector<HTMLInputElement>("dialog input")
    expect(walkthroughCommandInput).not.toBeNull()
    if (walkthroughCommandInput !== null) {
      setInputValue(walkthroughCommandInput, "Documentation")
      walkthroughCommandInput.dispatchEvent(new Event("input", { bubbles: true }))
    }
    const docsStepPaletteButton = [
      ...document.querySelectorAll<HTMLButtonElement>("dialog button"),
    ].find((button) => button.textContent?.includes("Documentation") ?? false)
    expect(docsStepPaletteButton).toBeDefined()
    docsStepPaletteButton?.click()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("SUPPORT")
      expect(getDiffCardPaths()).toEqual(["docs/readme.md"])
    })

    const entryStepButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Entry point") ?? false,
    )
    expect(entryStepButton).toBeDefined()
    entryStepButton?.click()

    await vi.waitFor(() => {
      expect(getDiffCardPaths()).toEqual(["src/app.tsx"])
    })

    const settingsButton = [...document.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Walkthrough settings",
    )
    expect(settingsButton).toBeDefined()
    settingsButton?.click()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Agent")
      expect(document.body.textContent).toContain("Model")
    })

    const claudeButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Claude") ?? false,
    )
    expect(claudeButton).toBeDefined()
    claudeButton?.click()

    await vi.waitFor(() => {
      expect(calls.updateSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({ provider: "claude" }),
      )
      expect(document.body.textContent).toContain("Sonnet 5.0")
    })

    const fileFilterInput = document.querySelector<HTMLInputElement>(
      'input[placeholder="Filter files"]',
    )
    expect(fileFilterInput).not.toBeNull()
    if (fileFilterInput !== null) {
      setInputValue(fileFilterInput, "app")
      fileFilterInput.dispatchEvent(new Event("input", { bubbles: true }))
    }

    await vi.waitFor(() => {
      expect(getDiffCardPaths()).toEqual(["src/app.tsx"])
    })

    const docsFileButton = document.querySelector<HTMLButtonElement>(
      '[data-walkthrough-file-path="docs/readme.md"]',
    )
    expect(docsFileButton).not.toBeNull()
    docsFileButton?.click()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("SUPPORT")
      expect(fileFilterInput?.value).toBe("")
      expect(getDiffCardPaths()).toEqual(["docs/readme.md"])
    })

    const markCompleteButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Mark complete",
    )
    expect(markCompleteButton).toBeDefined()
    markCompleteButton?.click()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Complete")
    })

    const regenerateButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Regenerate",
    )
    expect(regenerateButton).toBeDefined()
    regenerateButton?.click()

    await vi.waitFor(() => {
      expect(calls.regenerateWalkthrough).toHaveBeenCalledWith("fungsi", "diffdash", 51)
      expect(document.body.textContent).toContain("Mark complete")
    })

    const treeTab = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Tree",
    )
    expect(treeTab).toBeDefined()
    treeTab?.click()

    await vi.waitFor(() => {
      expect(getChangedFilesTreeItemPaths()).toContain("src/app.tsx")
      expect(getChangedFilesTreeItemPaths()).toContain("docs/readme.md")
      expect(getChangedFilesTreeItemPaths()).toContain("pnpm-lock.yaml")
      expect(document.querySelector('[data-selected-review-path="docs/readme.md"]')).not.toBeNull()
      expect(getDiffCardPaths()).toEqual(["src/app.tsx", "docs/readme.md", "pnpm-lock.yaml"])
    })

    const firstDiffOpenButton = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-diff-card-path="src/app.tsx"] button'),
    ].find((button) => button.textContent === "Open")
    expect(firstDiffOpenButton).toBeDefined()
    firstDiffOpenButton?.click()

    await vi.waitFor(() => {
      expect(calls.openRepositoryFile).toHaveBeenCalledWith(
        "fungsi",
        "diffdash",
        "src/app.tsx",
        "feature/requested-review",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      )
    })

    const treeFileFilterInput = document.querySelector<HTMLInputElement>(
      'input[placeholder="Filter files"]',
    )
    expect(treeFileFilterInput).not.toBeNull()
    if (treeFileFilterInput !== null) {
      setInputValue(treeFileFilterInput, "docs")
      treeFileFilterInput.dispatchEvent(new Event("input", { bubbles: true }))
    }

    await vi.waitFor(() => {
      expect(getChangedFilesTreeItemPaths()).toContain("docs/readme.md")
      expect(getChangedFilesTreeItemPaths()).not.toContain("src/app.tsx")
      expect(getDiffCardPaths()).toEqual(["docs/readme.md"])
    })

    dispatchSideMouseButton(3)

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Bookmarked Repos")
      expect(document.body.textContent).toContain("Recently Reviewed")
      expect(document.body.textContent).toContain("1 open PR in fungsi/diffdash")
      expect(document.body.textContent).not.toContain("Opened PR #51")
    })

    dispatchSideMouseButton(4)

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Opened PR #51")
      expect(getDiffCardPaths()).toEqual(["src/app.tsx", "docs/readme.md"])
    })
  })

  it("opens local review navigation with walkthrough and no approve action", async () => {
    const calls = installDiffDashApi()
    renderApp()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Bookmarked Repos")
    })

    calls.openLocalReview()

    const localTarget = workingTreeReviewTarget(localReview.rootPath)

    await vi.waitFor(() => {
      expect(calls.getLocalReviewDetail).toHaveBeenCalledWith(localTarget)
      expect(calls.getLocalReviewDiff).toHaveBeenCalledWith(localTarget)
      expect(document.body.textContent).toContain("Local changes")
      expect(document.body.textContent).toContain("src/local.ts")
      expect(document.body.textContent).not.toContain("Approve")
    })

    const walkthroughTab = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Walkthrough",
    )
    expect(walkthroughTab).toBeDefined()
    walkthroughTab?.click()

    await vi.waitFor(() => {
      expect(calls.getLocalWalkthrough).toHaveBeenCalledWith(
        localTarget,
        localReview.baseSha,
        localReview.headSha,
      )
      expect(calls.getWalkthrough).not.toHaveBeenCalled()
      expect(document.body.textContent).toContain("Local file")
      expect(document.body.textContent).toContain("REVIEW")
      expect(getDiffCardPaths()).toEqual(["src/local.ts"])
    })

    const treeTab = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Tree",
    )
    treeTab?.click()

    const localOpenButton = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[data-diff-card-path="src/local.ts"] button',
      ),
    ].find((button) => button.textContent === "Open")
    expect(localOpenButton).toBeDefined()
    localOpenButton?.click()

    await vi.waitFor(() => {
      expect(calls.openLocalRepositoryFile).toHaveBeenCalledWith(
        localReview.rootPath,
        "src/local.ts",
      )
    })
  })
})

const getChangedFilesTreeItemPaths = () =>
  [
    ...(document
      .querySelector("file-tree-container")
      ?.shadowRoot?.querySelectorAll("[data-item-path]") ?? []),
  ]
    .map((element) => element.getAttribute("data-item-path"))
    .filter((path) => path !== null)

const getChangedFilesTreeItem = (path: string) =>
  document
    .querySelector("file-tree-container")
    ?.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${path}"]`) ?? null

const getDiffCardPaths = () =>
  [...document.querySelectorAll("[data-diff-card-path]")]
    .map((element) => element.getAttribute("data-diff-card-path"))
    .filter((path) => path !== null)

const getViewedCheckbox = (path: string) =>
  document.querySelector<HTMLInputElement>(`[data-diff-card-path="${path}"] input[type="checkbox"]`)

const getDiffShadowRoot = (path: string) =>
  document.querySelector(`[data-diff-card-path="${path}"] diffs-container`)?.shadowRoot ?? null

const getMountedDiffLineCount = () =>
  [...document.querySelectorAll("diffs-container")].reduce(
    (count, element) => count + (element.shadowRoot?.querySelectorAll("[data-line]").length ?? 0),
    0,
  )

const getDiffLine = (shadowRoot: ShadowRoot, content: string) =>
  [...shadowRoot.querySelectorAll<HTMLElement>("[data-line]")].find(
    (element) => element.textContent?.trim() === content,
  )

const clickGutterUtility = (button: HTMLButtonElement) => {
  const init = { bubbles: true, button: 0, composed: true, pointerId: 1, pointerType: "mouse" }
  button.dispatchEvent(new PointerEvent("pointerdown", init))
  button.dispatchEvent(new PointerEvent("pointerup", init))
}

const dispatchKeyboardShortcut = (
  key: string,
  options: { readonly metaKey?: boolean; readonly shiftKey?: boolean } = {},
) => {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key,
      metaKey: options.metaKey ?? false,
      shiftKey: options.shiftKey ?? false,
    }),
  )
}

const dispatchSideMouseButton = (button: number) => {
  window.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button, cancelable: true }))
}

const renderApp = () => {
  const rootElement = document.createElement("div")
  rootElement.id = "root"
  document.body.append(rootElement)
  root = createRoot(rootElement)
  root.render(<App />)
}

const setInputValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(input, value)
}

const installDiffDashApi = (
  options: {
    readonly appState?: AppState
    readonly cliInstallResult?: { readonly path: string; readonly pathSetupCommand: string | null }
    readonly diagnostics?: AppPrerequisites
    readonly pullRequestDetail?: PullRequestDetail
    readonly pullRequestDiff?: PullRequestDiff
    readonly repositories?: readonly Repo[]
    readonly reviewRequests?: readonly PullRequestSummary[]
    readonly settings?: AISettings
    readonly updateState?: AppUpdateState
    readonly walkthrough?: StoredWalkthrough
  } = {},
) => {
  const viewedFileKeys = new Set<string>()
  const localViewedFileKeys = new Set<string>()
  const appState = options.appState ?? { onboardingCompleted: true }
  const diagnostics = options.diagnostics ?? readyPrerequisites
  const repositories = options.repositories ?? [repo]
  const initialUpdateState =
    options.updateState ??
    AppUpdateUnsupported.make({ currentVersion: "0.1.4", reason: "development" })
  let commandsAvailableListener: (() => void) | null = null
  let pendingCommands: CliNavigationCommand[] = []
  let updateStateListener: ((state: AppUpdateState) => void) | null = null
  let approved = false
  const getLocalReviewDetail = vi.fn<(target: LocalReviewTarget) => Promise<LocalReviewDetail>>(
    async (target) =>
      LocalReviewDetail.make({
        ...localReview,
        comparison: target.comparison,
        title:
          target.comparison["_tag"] === "branch"
            ? `Changes vs ${target.comparison.branchName}`
            : "Local changes",
      }),
  )
  const getLocalReviewDiff = vi.fn<(target: LocalReviewTarget) => Promise<LocalReviewDiff>>(
    async (target) => LocalReviewDiff.make({ ...localDiff, comparison: target.comparison }),
  )
  const getLocalReviewSnapshot = vi.fn<DiffDashApi["localReviews"]["getSnapshot"]>(
    async (target) => {
      const localDetail = await getLocalReviewDetail(target)
      const localReviewPatch = await getLocalReviewDiff(target)
      return LocalReviewSnapshot.make({
        reviewKey: ReviewKey.make(`local:${target.rootPath}`),
        baseRevision: ReviewRevision.make(localReviewPatch.baseSha),
        headRevision: ReviewRevision.make(localReviewPatch.headSha),
        detail: localDetail,
        diff: localReviewPatch,
        parsedDiff: parseUnifiedDiff(localReviewPatch.diff),
      })
    },
  )
  const calls = {
    captureAnalytics: vi.fn<DiffDashApi["analytics"]["capture"]>(async () => undefined),
    startAnalytics: vi.fn<DiffDashApi["analytics"]["start"]>(async () => undefined),
    generateWalkthrough: vi.fn<
      (owner: string, name: string, number: number) => Promise<StoredWalkthrough>
    >(async () => options.walkthrough ?? walkthrough),
    getWalkthrough: vi.fn<
      (
        owner: string,
        name: string,
        number: number,
        baseSha: string,
        headSha: string,
      ) => Promise<StoredWalkthrough | null>
    >(async () => options.walkthrough ?? walkthrough),
    regenerateWalkthrough: vi.fn<
      (owner: string, name: string, number: number) => Promise<StoredWalkthrough>
    >(async () => options.walkthrough ?? walkthrough),
    updateSettings: vi.fn<(settings: AISettings) => Promise<AISettings>>(async (settings) =>
      plainAISettings(settings),
    ),
    listPullRequests: vi.fn<
      (owner: string, name: string) => Promise<readonly PullRequestSummary[]>
    >(async () => [pullRequest]),
    getLocalWalkthrough: vi.fn<
      (
        target: LocalReviewTarget,
        baseSha: string,
        headSha: string,
      ) => Promise<StoredWalkthrough | null>
    >(async () => localWalkthrough),
    generateLocalWalkthrough: vi.fn<(target: LocalReviewTarget) => Promise<StoredWalkthrough>>(
      async () => localWalkthrough,
    ),
    regenerateLocalWalkthrough: vi.fn<(target: LocalReviewTarget) => Promise<StoredWalkthrough>>(
      async () => localWalkthrough,
    ),
    installDiffDashCli: vi.fn<
      () => Promise<{ readonly path: string; readonly pathSetupCommand: string | null }>
    >(async () => ({
      path: options.cliInstallResult?.path ?? "/usr/local/bin/diffdash",
      pathSetupCommand: options.cliInstallResult?.pathSetupCommand ?? null,
    })),
    installRepository: vi.fn<(localPath: string) => Promise<Repo>>(async (localPath) =>
      Repo.make({ ...repo, localPath }),
    ),
    linkRepository: vi.fn<
      (input: {
        readonly owner: string
        readonly name: string
        readonly localPath: string
      }) => Promise<Repo>
    >(async (input) => Repo.make({ ...repo, localPath: input.localPath })),
    selectLocalFolder: vi.fn<() => Promise<string | null>>(async () => null),
    openExternalUrl: vi.fn<(url: string) => Promise<void>>(async () => undefined),
    updateAppState: vi.fn<(state: AppState) => Promise<AppState>>(async (state) => state),
    checkForUpdates: vi.fn<() => Promise<void>>(async () => undefined),
    downloadUpdate: vi.fn<() => Promise<void>>(async () => undefined),
    restartAndInstallUpdate: vi.fn<() => Promise<void>>(async () => undefined),
    getLocalReviewDetail,
    getLocalReviewDiff,
    getLocalReviewSnapshot,
    resolveBranch: vi.fn<DiffDashApi["localReviews"]["resolveBranch"]>(
      async (localPath, branchName) =>
        LocalReviewTarget.make({
          kind: "local",
          rootPath: localPath,
          comparison: BranchComparison.make({
            branchName: branchName ?? "main",
            baseRef: `refs/remotes/origin/${branchName ?? "main"}`,
            baseSha: localReview.baseSha,
          }),
        }),
    ),
    getPullRequestDetail: vi.fn<
      (owner: string, name: string, number: number) => Promise<PullRequestDetail>
    >(async () => options.pullRequestDetail ?? detail),
    getPullRequestDiff: vi.fn<
      (owner: string, name: string, number: number) => Promise<PullRequestDiff>
    >(async () => options.pullRequestDiff ?? diff),
    searchRepositories: vi.fn<
      (request: RepositorySearchRequest) => Promise<readonly RepositorySearchResult[]>
    >(async () => [remoteSearchResult]),
    openLocalRepositoryFile: vi.fn<(rootPath: string, filePath: string) => Promise<void>>(
      async () => undefined,
    ),
    openRepositoryFile: vi.fn<
      (
        owner: string,
        name: string,
        filePath: string,
        headRefName: string,
        headRefOid: string | null,
      ) => Promise<void>
    >(async () => undefined),
    approvePullRequest: vi.fn<(owner: string, name: string, number: number) => Promise<void>>(
      async () => {
        approved = true
      },
    ),
  }
  const api: DiffDashApi = {
    analytics: {
      capture: calls.captureAnalytics,
      start: calls.startAnalytics,
    },
    updates: {
      getState: async () => initialUpdateState,
      check: calls.checkForUpdates,
      download: calls.downloadUpdate,
      restartAndInstall: calls.restartAndInstallUpdate,
      onStateChanged: (listener) => {
        updateStateListener = listener
        return () => {
          updateStateListener = null
        }
      },
    },
    navigation: {
      drainCommands: async () => {
        const commands = pendingCommands
        pendingCommands = []
        return commands
      },
      onCommandsAvailable: (listener) => {
        commandsAvailableListener = listener
        return () => {
          commandsAvailableListener = null
        }
      },
    },
    diagnostics: async () => diagnostics,
    installDiffDashCli: calls.installDiffDashCli,
    openExternalUrl: calls.openExternalUrl,
    openLocalRepositoryFile: calls.openLocalRepositoryFile,
    openRepositoryFile: calls.openRepositoryFile,
    gitProvider: {
      approvePullRequest: calls.approvePullRequest,
      getPullRequestDetail: calls.getPullRequestDetail,
      getPullRequestDiff: calls.getPullRequestDiff,
      hasApprovedPullRequest: async () => approved,
      listPullRequests: calls.listPullRequests,
      listReviewRequests: async () => options.reviewRequests ?? [pullRequest],
      listSearchScopes: async () => [
        RepositorySearchScope.make({ kind: "user", login: "hanipcode" }),
        RepositorySearchScope.make({ kind: "organization", login: "fungsi" }),
      ],
      refreshPullRequestDetail: calls.getPullRequestDetail,
      searchRepositories: calls.searchRepositories,
    },
    localReviews: {
      resolveBranch: calls.resolveBranch,
      getDetail: calls.getLocalReviewDetail,
      getDiff: calls.getLocalReviewDiff,
      getSnapshot: calls.getLocalReviewSnapshot,
    },
    repositories: {
      addLocal: async () => repo,
      install: calls.installRepository,
      link: calls.linkRepository,
      favoriteRemote: async (remoteRepo: RepositorySearchResult) =>
        Repo.make({
          ...repo,
          id: `${remoteRepo.owner}/${remoteRepo.name}`,
          name: remoteRepo.name,
          owner: remoteRepo.owner,
          remoteUrl: remoteRepo.url,
        }),
      list: async () => repositories,
      selectLocalFolder: calls.selectLocalFolder,
      setFavorite: async () => repo,
    },
    reviewThreads: {
      list: async () => [],
      create: async () => {
        throw new Error("Review thread creation is not used by this fixture")
      },
      addUserMessage: async () => {
        throw new Error("Review thread messages are not used by this fixture")
      },
      get: async () => {
        throw new Error("Review thread loading is not used by this fixture")
      },
      runAgent: async () => {
        throw new Error("Review thread agents are not used by this fixture")
      },
      onAgentProgress: () => () => undefined,
    },
    settings: {
      get: async () => plainAISettings(options.settings ?? DEFAULT_AI_SETTINGS),
      update: calls.updateSettings,
    },
    appState: {
      get: async () => appState,
      update: calls.updateAppState,
    },
    viewedFiles: {
      list: async () => [...viewedFileKeys],
      listLocal: async () => [...localViewedFileKeys],
      set: async (
        _owner: string,
        _name: string,
        _number: number,
        _headSha: string,
        reviewKey: string,
        _filePath: string,
        viewed: boolean,
      ) => {
        if (viewed) {
          viewedFileKeys.add(reviewKey)
        } else {
          viewedFileKeys.delete(reviewKey)
        }
      },
      setLocal: async (
        _rootPath: string,
        _headSha: string,
        reviewKey: string,
        _filePath: string,
        viewed: boolean,
      ) => {
        if (viewed) {
          localViewedFileKeys.add(reviewKey)
        } else {
          localViewedFileKeys.delete(reviewKey)
        }
      },
    },
    walkthroughs: {
      generate: calls.generateWalkthrough,
      get: calls.getWalkthrough,
      regenerate: calls.regenerateWalkthrough,
    },
    localWalkthroughs: {
      generate: calls.generateLocalWalkthrough,
      get: calls.getLocalWalkthrough,
      regenerate: calls.regenerateLocalWalkthrough,
    },
  }

  Object.defineProperty(window, "diffDash", {
    configurable: true,
    value: api,
  })

  return {
    ...calls,
    emitUpdateState: (state: AppUpdateState) => updateStateListener?.(state),
    linkRepositoryFromCli: (rootPath: string) => {
      pendingCommands.push(LinkRepositoryCommand.make({ localPath: rootPath }))
      commandsAvailableListener?.()
    },
    openLocalReview: (rootPath: string = localReview.rootPath) => {
      pendingCommands.push(OpenWorkingTreeCommand.make({ localPath: rootPath }))
      commandsAvailableListener?.()
    },
    openPullRequest: (number: number | null, localPath = "/workspace/local-repo") => {
      pendingCommands.push(OpenPullRequestCommand.make({ localPath, number }))
      commandsAvailableListener?.()
    },
    openBranchDiff: (branchName: string | null, localPath = localReview.rootPath) => {
      pendingCommands.push(OpenBranchDiffCommand.make({ localPath, branchName }))
      commandsAvailableListener?.()
    },
  }
}

const plainAISettings = (settings: AISettings): AISettings => ({
  appearance: settings.appearance,
  provider: settings.provider,
  telemetryEnabled: settings.telemetryEnabled,
  models: {
    auto: settings.models.auto,
    claude: settings.models.claude,
    codex: settings.models.codex,
    opencode: settings.models.opencode,
  },
})
