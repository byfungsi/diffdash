import { afterEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"

import { App } from "./app"
import type { AppState } from "../../shared/app-state"
import {
  LocalReviewDetail,
  LocalReviewDiff,
  Repo,
  PullRequestDetail,
  PullRequestDiff,
  PullRequestFile,
  PullRequestSummary,
  RepositorySearchResult,
  RepositorySearchScope,
  ReviewActor,
} from "../../shared/domain"
import type { DiffDashApi } from "../../../electron/preload"
import { AISettings, DEFAULT_AI_SETTINGS } from "../../shared/ai-settings"
import { AppPrerequisites } from "../../shared/prerequisites"
import {
  Walkthrough,
  WalkthroughChapter,
  WalkthroughStop,
  WalkthroughSupportItem,
  StoredWalkthrough,
} from "../../shared/walkthrough"

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
  diffDashCliPath: "/usr/local/bin/diffdash",
  gitInstalled: true,
  ghAuthenticated: true,
  ghInstalled: true,
  installedCodingAgents: ["codex"],
})

const missingPrerequisites = AppPrerequisites.make({
  checkedAt: "2026-07-08T00:00:00Z",
  codingAgentInstalled: false,
  diffDashCliInstalled: false,
  diffDashCliPath: null,
  gitInstalled: false,
  ghAuthenticated: false,
  ghInstalled: false,
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
  window.localStorage.clear()
  document.documentElement.classList.remove("dark")
  document.documentElement.style.colorScheme = ""
  document.body.replaceChildren()
})

describe("App browser interactions", () => {
  it("shows first-run onboarding and lets the user continue", async () => {
    const calls = installDiffDashApi({
      appState: { onboardingCompleted: false },
      diagnostics: missingPrerequisites,
    })
    renderApp()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Set up DiffDash")
      expect(document.body.textContent).toContain("GitHub CLI installed")
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
    continueButton?.click()

    await vi.waitFor(() => {
      expect(calls.updateAppState).toHaveBeenCalledWith({ onboardingCompleted: true })
      expect(document.body.textContent).toContain("Bookmarked Repos")
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

    const darkThemeButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Use dark theme"]',
    )
    expect(darkThemeButton).not.toBeNull()
    darkThemeButton?.click()
    await vi.waitFor(() => {
      expect(document.documentElement.classList.contains("dark")).toBe(true)
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
      expect(getDiffCardPaths()).toEqual(["src/app.tsx", "docs/readme.md"])
      expect(getDiffCardPaths()).not.toContain("pnpm-lock.yaml")
    })

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

    await vi.waitFor(() => {
      expect(document.body.textContent).not.toContain("Request changes")
      const approveButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Approve",
      )
      expect(approveButton).toBeDefined()
      expect(approveButton?.disabled).toBe(false)
    })

    const approveButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Approve",
    )
    approveButton?.click()

    await vi.waitFor(() => {
      expect(calls.approvePullRequest).toHaveBeenCalledWith("fungsi", "diffdash", 51)
      const approvedButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Approved",
      )
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

    await vi.waitFor(() => {
      expect(calls.getLocalReviewDetail).toHaveBeenCalledWith(localReview.rootPath)
      expect(calls.getLocalReviewDiff).toHaveBeenCalledWith(localReview.rootPath)
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
        localReview.rootPath,
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

const getDiffCardPaths = () =>
  [...document.querySelectorAll("[data-diff-card-path]")]
    .map((element) => element.getAttribute("data-diff-card-path"))
    .filter((path) => path !== null)

const getViewedCheckbox = (path: string) =>
  document.querySelector<HTMLInputElement>(`[data-diff-card-path="${path}"] input[type="checkbox"]`)

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
    readonly diagnostics?: AppPrerequisites
    readonly repositories?: readonly Repo[]
  } = {},
) => {
  const viewedFileKeys = new Set<string>()
  const localViewedFileKeys = new Set<string>()
  const appState = options.appState ?? { onboardingCompleted: true }
  const diagnostics = options.diagnostics ?? readyPrerequisites
  const repositories = options.repositories ?? [repo]
  let localReviewListener: ((rootPath: string) => void) | null = null
  let approved = false
  const calls = {
    generateWalkthrough: vi.fn<
      (owner: string, name: string, number: number) => Promise<StoredWalkthrough>
    >(async () => walkthrough),
    getWalkthrough: vi.fn<
      (
        owner: string,
        name: string,
        number: number,
        baseSha: string,
        headSha: string,
      ) => Promise<StoredWalkthrough | null>
    >(async () => walkthrough),
    regenerateWalkthrough: vi.fn<
      (owner: string, name: string, number: number) => Promise<StoredWalkthrough>
    >(async () => walkthrough),
    updateSettings: vi.fn<(settings: AISettings) => Promise<AISettings>>(async (settings) =>
      plainAISettings(settings),
    ),
    listPullRequests: vi.fn<
      (owner: string, name: string) => Promise<readonly PullRequestSummary[]>
    >(async () => [pullRequest]),
    getLocalWalkthrough: vi.fn<
      (rootPath: string, baseSha: string, headSha: string) => Promise<StoredWalkthrough | null>
    >(async () => localWalkthrough),
    generateLocalWalkthrough: vi.fn<(rootPath: string) => Promise<StoredWalkthrough>>(
      async () => localWalkthrough,
    ),
    regenerateLocalWalkthrough: vi.fn<(rootPath: string) => Promise<StoredWalkthrough>>(
      async () => localWalkthrough,
    ),
    installDiffDashCli: vi.fn<() => Promise<{ readonly path: string }>>(async () => ({
      path: "/usr/local/bin/diffdash",
    })),
    openExternalUrl: vi.fn<(url: string) => Promise<void>>(async () => undefined),
    updateAppState: vi.fn<(state: AppState) => Promise<AppState>>(async (state) => state),
    getLocalReviewDetail: vi.fn<(rootPath: string) => Promise<LocalReviewDetail>>(
      async () => localReview,
    ),
    getLocalReviewDiff: vi.fn<(rootPath: string) => Promise<LocalReviewDiff>>(
      async () => localDiff,
    ),
    getPullRequestDetail: vi.fn<
      (owner: string, name: string, number: number) => Promise<PullRequestDetail>
    >(async () => detail),
    getPullRequestDiff: vi.fn<
      (owner: string, name: string, number: number) => Promise<PullRequestDiff>
    >(async () => diff),
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
    navigation: {
      getPendingLocalReview: async () => null,
      onOpenLocalReview: (listener) => {
        localReviewListener = listener
        return () => {
          localReviewListener = null
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
      listReviewRequests: async () => [pullRequest],
      listSearchScopes: async () => [
        RepositorySearchScope.make({ kind: "user", login: "hanipcode" }),
        RepositorySearchScope.make({ kind: "organization", login: "fungsi" }),
      ],
      refreshPullRequestDetail: calls.getPullRequestDetail,
      searchRepositories: async () => [remoteSearchResult],
    },
    localReviews: {
      getDetail: calls.getLocalReviewDetail,
      getDiff: calls.getLocalReviewDiff,
    },
    repositories: {
      addLocal: async () => repo,
      favoriteRemote: async (remoteRepo: RepositorySearchResult) =>
        Repo.make({
          ...repo,
          id: `${remoteRepo.owner}/${remoteRepo.name}`,
          name: remoteRepo.name,
          owner: remoteRepo.owner,
          remoteUrl: remoteRepo.url,
        }),
      list: async () => repositories,
      selectLocalFolder: async () => null,
      setFavorite: async () => repo,
    },
    settings: {
      get: async () => plainAISettings(DEFAULT_AI_SETTINGS),
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
    openLocalReview: (rootPath: string = localReview.rootPath) => localReviewListener?.(rootPath),
  }
}

const plainAISettings = (settings: AISettings): AISettings => ({
  provider: settings.provider,
  models: {
    auto: settings.models.auto,
    claude: settings.models.claude,
    codex: settings.models.codex,
    opencode: settings.models.opencode,
  },
})
