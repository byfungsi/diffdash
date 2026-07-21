/* oxlint-disable vitest/no-standalone-expect -- Shared callbacks are registered by feature-owned browser suites. */
import { AISettings, DEFAULT_AI_SETTINGS } from "@diffdash/domain/ai-settings"
import type { AppState } from "@diffdash/domain/app-state"
import type { ParsedDiffFile } from "@diffdash/domain/diff"
import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import {
  BranchRevision,
  ChangedFile,
  GitProviderCapabilities,
  GitProviderDescriptor,
  GitProviderId,
  GitProviderKind,
  GitProviderTerminology,
  HostedRepository,
  HostedReviewDetail,
  HostedReviewDiff,
  HostedReviewSummary,
  makeHostedRepositoryLocator,
  makeHostedReviewLocator,
  ProviderActor,
} from "@diffdash/domain/git-provider"
import {
  BranchComparison,
  LocalReviewDetail,
  LocalReviewDiff,
  LocalReviewTarget,
  workingTreeReviewTarget,
} from "@diffdash/domain/local-review"
import { Repo, RepositorySearchScope } from "@diffdash/domain/repository"
import {
  HostedReviewSnapshot,
  LocalReviewSnapshot,
  makeReviewSnapshotManifest,
  type ReviewSnapshot,
} from "@diffdash/domain/review-context"
import {
  makeReviewDiffIdentity,
  makeReviewSnapshotId,
  ReviewDiffIdentity,
  ReviewHunkId,
  ReviewKey,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import {
  StoredWalkthrough,
  Walkthrough,
  WalkthroughChapter,
  WalkthroughGenerationDetails,
  WalkthroughStop,
  WalkthroughSupportItem,
} from "@diffdash/domain/walkthrough"
import {
  AgentModelId,
  AgentProviderAutoCandidates,
  AgentProviderCapabilityStatus,
  AgentProviderCatalog,
  AgentProviderDefaults,
  AgentProviderId,
  AgentProviderModel,
  AgentProviderSetupRequirement,
  AgentProviderStatus,
  EMPTY_AGENT_PROVIDER_CATALOG,
} from "@diffdash/protocol/agent-providers"
import type { DiffDashApi } from "@diffdash/protocol/api"
import {
  AppUpdateAvailable,
  AppUpdateDownloaded,
  AppUpdateDownloading,
  AppUpdateFailed,
  type AppUpdateState,
  AppUpdateUnsupported,
} from "@diffdash/protocol/app-update"
import {
  type CliNavigationCommand,
  LinkRepositoryCommand,
  OpenBranchDiffCommand,
  OpenPullRequestCommand,
  OpenWorkingTreeCommand,
} from "@diffdash/protocol/cli-navigation"
import { AppPrerequisites, SetupRequirement } from "@diffdash/protocol/prerequisites"
import {
  ReviewSnapshotExpired,
  ReviewSnapshotPageAvailable,
  ReviewSnapshotSearchAvailable,
  ReviewSnapshotSearchCursor,
  ReviewSnapshotSearchMatch,
} from "@diffdash/protocol/review-snapshot"
import { StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, vi } from "vitest"
import { buildReviewSearchIndex, searchReviewIndex } from "@/review/review-search"
import {
  REVIEW_SEARCH_ACTIVE_HIGHLIGHT,
  REVIEW_SEARCH_MATCH_HIGHLIGHT,
} from "@/review/review-search-highlights"
import { App } from "../app"
import "../styles.css"

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

const provider = GitProviderDescriptor.make({
  id: GitProviderId.make("github"),
  kind: GitProviderKind.make("github"),
  displayName: "GitHub",
  host: "github.com",
  capabilities: GitProviderCapabilities.make({
    repositorySearch: true,
    searchScopes: true,
    assignedReviews: true,
    reviewDecisions: true,
    fileUrls: true,
    remoteWorkspaceBootstrap: true,
  }),
  terminology: GitProviderTerminology.make({
    repositorySingular: "repository",
    repositoryPlural: "repositories",
    reviewSingular: "pull request",
    reviewPlural: "pull requests",
  }),
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

const pullRequest = HostedReviewSummary.make({
  locator: makeHostedReviewLocator("github", "fungsi", "diffdash", 51),
  author: ProviderActor.make({
    id: null,
    username: "octocat",
    displayName: null,
    avatarUrl: null,
  }),
  base: BranchRevision.make({
    name: "main",
    revision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  }),
  body: "Please review this workspace change.",
  createdAt: "2026-07-07T00:00:00Z",
  decision: "none",
  head: BranchRevision.make({
    name: "feature/requested-review",
    revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  }),
  draft: false,
  state: "OPEN",
  title: "Request review flow",
  updatedAt: "2026-07-07T02:00:00Z",
  url: "https://github.com/fungsi/diffdash/pull/51",
})

const detail = HostedReviewDetail.make({
  summary: pullRequest,
  commits: [],
  files: [
    ChangedFile.make({
      additions: 1,
      changeType: "modified",
      deletions: 1,
      path: "src/app.tsx",
    }),
    ChangedFile.make({
      additions: 1,
      changeType: "modified",
      deletions: 0,
      path: "docs/readme.md",
    }),
    ChangedFile.make({
      additions: 1,
      changeType: "modified",
      deletions: 1,
      path: "pnpm-lock.yaml",
    }),
  ],
})

const diff = HostedReviewDiff.make({
  locator: pullRequest.locator,
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
  headRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
})

const fixtureProvider = GitProviderDescriptor.make({
  id: GitProviderId.make("fixture"),
  kind: GitProviderKind.make("fixture"),
  displayName: "Fixture Forge",
  host: "git.fixture.test",
  capabilities: GitProviderCapabilities.make({
    repositorySearch: true,
    searchScopes: false,
    assignedReviews: true,
    reviewDecisions: false,
    fileUrls: true,
    remoteWorkspaceBootstrap: true,
  }),
  terminology: GitProviderTerminology.make({
    repositorySingular: "project",
    repositoryPlural: "projects",
    reviewSingular: "merge request",
    reviewPlural: "merge requests",
    reviewAbbreviation: "MR",
  }),
})

const fixturePullRequest = HostedReviewSummary.make({
  ...pullRequest,
  locator: makeHostedReviewLocator("fixture", "platform/backend", "service", 73),
  title: "Fixture merge request flow",
  url: "https://git.fixture.test/platform/backend/service/merge-requests/73",
})

const fixtureDetail = HostedReviewDetail.make({
  summary: fixturePullRequest,
  commits: [],
  files: [
    ChangedFile.make({
      additions: 1,
      changeType: "modified",
      deletions: 1,
      path: "src/fixture.ts",
    }),
  ],
})

const fixtureDiff = HostedReviewDiff.make({
  ...diff,
  locator: fixturePullRequest.locator,
  diff: `diff --git a/src/fixture.ts b/src/fixture.ts
index 1111111..2222222 100644
--- a/src/fixture.ts
+++ b/src/fixture.ts
@@ -1 +1 @@
-old fixture
+new fixture`,
})

const makeLargeDiffFixture = (lineCount: number, number = 52, tailLineCount = 1) => {
  const changedLines = Array.from(
    { length: lineCount },
    (_, index) => `-const value${index + 1} = "before"\n+const value${index + 1} = "after"`,
  ).join("\n")
  const largePath = "src/generated-large.ts"
  const tailPath = "src/tail.ts"
  const tailChangedLines =
    tailLineCount === 1
      ? "-tail before\n+tail after"
      : Array.from(
          { length: tailLineCount },
          (_, index) => `-const tail${index + 1} = "before"\n+const tail${index + 1} = "after"`,
        ).join("\n")
  const largePullRequest = HostedReviewSummary.make({
    ...pullRequest,
    locator: makeHostedReviewLocator("github", "fungsi", "diffdash", number),
    title: "Large diff virtualization",
  })
  const largeDetail = HostedReviewDetail.make({
    summary: largePullRequest,
    commits: [],
    files: [
      ChangedFile.make({
        additions: lineCount,
        changeType: "modified",
        deletions: lineCount,
        path: largePath,
      }),
      ChangedFile.make({
        additions: tailLineCount,
        changeType: "modified",
        deletions: tailLineCount,
        path: tailPath,
      }),
    ],
  })
  const largeDiff = HostedReviewDiff.make({
    ...diff,
    locator: largePullRequest.locator,
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
@@ -1,${tailLineCount} +1,${tailLineCount} @@
${tailChangedLines}`,
  })

  return { largeDetail, largeDiff, largePath, largePullRequest, tailPath }
}

const makeManyFileDiffFixture = () => {
  const number = 58
  const targetIndex = 12
  const fileSpecs = Array.from({ length: 14 }, (_, index) => ({
    lineCount:
      index === targetIndex ? 691 : index === 13 ? 24 : ([36, 72, 144, 220][index % 4] ?? 36),
    path: `src/many/file-${String(index + 1).padStart(2, "0")}.tsx`,
  }))
  const targetPath = fileSpecs[targetIndex]?.path ?? ""
  const sentinelPath = fileSpecs.at(-1)?.path ?? ""
  const manyPullRequest = HostedReviewSummary.make({
    ...pullRequest,
    locator: makeHostedReviewLocator("github", "fungsi", "diffdash", number),
    title: "Many wrapped diff files",
  })
  const manyDetail = HostedReviewDetail.make({
    summary: manyPullRequest,
    commits: [],
    files: fileSpecs.map(({ lineCount, path }) =>
      ChangedFile.make({
        additions: lineCount,
        changeType: "modified",
        deletions: lineCount,
        path,
      }),
    ),
  })
  const manyDiff = HostedReviewDiff.make({
    ...diff,
    locator: manyPullRequest.locator,
    diff: fileSpecs
      .map(({ lineCount, path }, fileIndex) => {
        const padding = "wrapped-content-".repeat(
          fileIndex === targetIndex ? 45 : fileIndex % 3 === 0 ? 6 : 2,
        )
        const changedLines = Array.from({ length: lineCount }, (_, lineIndex) => {
          const lineNumber = lineIndex + 1
          const nextValue =
            fileIndex === targetIndex && lineNumber === lineCount
              ? "TARGET_FINAL_691"
              : `after ${padding}`
          return `-const row${lineNumber} = "before ${padding}"\n+const row${lineNumber} = "${nextValue}"`
        }).join("\n")
        return `diff --git a/${path} b/${path}
index 1111111..2222222 100644
--- a/${path}
+++ b/${path}
@@ -1,${lineCount} +1,${lineCount} @@
${changedLines}`
      })
      .join("\n"),
  })

  return {
    manyDetail,
    manyDiff,
    manyPullRequest,
    paths: fileSpecs.map(({ path }) => path),
    sentinelPath,
    targetPath,
  }
}

const localReview = LocalReviewDetail.make({
  baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  branchName: "feature/local-review",
  diffHash: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  fetchedAt: "2026-07-07T04:00:00Z",
  files: [
    ChangedFile.make({
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
            hunkIds: ["src/app.tsx:hosted-review:github:fungsi/diffdash#51:h1"],
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
        hunkIds: ["docs/readme.md:hosted-review:github:fungsi/diffdash#51:h1"],
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

const remoteSearchResult = HostedRepository.make({
  locator: makeHostedRepositoryLocator("github", "fungsi", "remote-review"),
  description: "Remote review target",
  isPrivate: false,
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

const readyAgentProviderCatalog = AgentProviderCatalog.make({
  providers: (
    [
      ["codex", "Codex", "gpt-5.3-codex-spark", "GPT 5.3 Codex Spark"],
      ["claude", "Claude", "claude-sonnet-5", "Sonnet 5.0"],
      ["opencode", "OpenCode", "openai/gpt-5.3-codex-spark", "GPT 5.3 Codex Spark"],
    ] as const
  ).map(([id, displayName, model, modelName]) =>
    AgentProviderStatus.make({
      id: AgentProviderId.make(id),
      displayName,
      description: `${displayName} provider`,
      homepage: null,
      capabilities: [
        AgentProviderCapabilityStatus.make({
          capability: "walkthrough",
          status: "ready",
          runtimeVersion: "1.0.0",
          reason: null,
        }),
        AgentProviderCapabilityStatus.make({
          capability: "review-thread",
          status: "ready",
          runtimeVersion: "1.0.0",
          reason: null,
        }),
      ],
      models: [
        AgentProviderModel.make({
          id: AgentModelId.make(model),
          displayName: modelName,
          capabilities: ["walkthrough", "review-thread"],
          quality: "balanced",
        }),
      ],
      defaults: AgentProviderDefaults.make({
        walkthroughModel: AgentModelId.make(model),
        reviewThreadModel: AgentModelId.make(model),
      }),
      setup: [
        AgentProviderSetupRequirement.make({
          name: id,
          versionRange: null,
          installHint: null,
        }),
      ],
    }),
  ),
  autoCandidates: AgentProviderAutoCandidates.make({
    walkthrough: ["claude", "codex", "opencode"].map((id) => AgentProviderId.make(id)),
    reviewThread: ["claude", "codex", "opencode"].map((id) => AgentProviderId.make(id)),
  }),
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
  setupRequirements: [
    SetupRequirement.make({
      key: "provider:github",
      providerId: GitProviderId.make("github"),
      title: "GitHub ready",
      description: "Connect GitHub to search repositories and review pull requests.",
      detail: "GitHub needs setup or authentication.",
      ready: false,
      requiredForLocalUse: false,
      helpUrl: "https://cli.github.com/manual/gh_auth_login",
    }),
  ],
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
  window.scrollTo(0, 0)
})

type AppBrowserScenario = () => void | Promise<void>

type AppBrowserScenarioId =
  | "agentMenusKeyboard"
  | "appearance"
  | "cliBranchComparison"
  | "cliBranchNoAncestor"
  | "cliLinkRepository"
  | "cliNumberedPullRequest"
  | "cliPathSetup"
  | "cliPullRequestFailure"
  | "cliRepositoryPullRequests"
  | "diffSearchSubstrings"
  | "diffSearchVisibility"
  | "dismissRepositoryBanner"
  | "explicitProviderRouting"
  | "fileTreeSelection"
  | "firstRunOnboarding"
  | "homeToReview"
  | "incrementalSnapshotPages"
  | "largeDiffVirtualization"
  | "linkRepositoryBanner"
  | "localReview"
  | "markAllViewedViewport"
  | "missingSetupHomeBanner"
  | "onboardingTelemetryOptOut"
  | "providerTerminology"
  | "remoteRepositorySearch"
  | "repositoryInvalidation"
  | "repositorySearchFailure"
  | "sampledWalkthrough"
  | "snapshotExpiryReload"
  | "staleLocalFavorites"
  | "unavailableProviderRoute"
  | "unsupportedGitHubCli"
  | "updateDownloadRestart"
  | "updateFailureTitle"
  | "veryLargePlainDiff"
  | "viewedAcrossPushes"
  | "viewedPersistenceRollback"
  | "viewedViewportAnchor"
  | "virtualizedSearch"
  | "walkthroughNoAgent"
  | "walkthroughSettingsPersistence"
  | "rapidSettingsOrdering"
  | "wrappedFileBuffers"
  | "wrappedSearchConvergence"

const appBrowserScenarios = new Map<AppBrowserScenarioId, AppBrowserScenario>()
const ignoreRejection = (_error: unknown): void => undefined
const ignoreSettingsResolution = (_settings: AISettings): void => undefined

const findSettingsRadio = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
    (button) => button.textContent === label,
  )

const scenario = (id: AppBrowserScenarioId, test: AppBrowserScenario): void => {
  if (appBrowserScenarios.has(id)) throw new Error(`Duplicate app browser scenario: ${id}`)
  appBrowserScenarios.set(id, test)
}

/** Returns a shared browser scenario callback for explicit registration by its owning feature. */
export const appBrowserScenario = (id: AppBrowserScenarioId): AppBrowserScenario => {
  const test = appBrowserScenarios.get(id)
  if (test === undefined) throw new Error(`Unknown app browser scenario: ${id}`)
  return test
}

scenario("appearance", async () => {
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

scenario("firstRunOnboarding", async () => {
  const calls = installDiffDashApi({
    appState: { onboardingCompleted: false },
    diagnostics: missingPrerequisites,
  })
  renderApp()

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Set up DiffDash")
    expect(document.body.textContent).toContain("GitHub ready")
    expect(document.body.textContent).toContain("Coding agent installed")
    expect(document.body.textContent).not.toContain("Bookmarked Repos")
  })

  const docsButton = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Setup docs",
  )
  docsButton?.click()
  expect(calls.openExternalUrl).toHaveBeenCalledWith("https://cli.github.com/manual/gh_auth_login")

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

scenario("cliPathSetup", async () => {
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

scenario("onboardingTelemetryOptOut", async () => {
  const calls = installDiffDashApi({ appState: { onboardingCompleted: false } })
  renderApp()

  await vi.waitFor(() => expect(document.body.textContent).toContain("Share anonymous usage data"))
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

scenario("missingSetupHomeBanner", async () => {
  const calls = installDiffDashApi({ diagnostics: missingPrerequisites })
  renderApp()

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Finish setup")
    expect(document.body.textContent).toContain("git was not found in PATH")
    expect(document.body.textContent).toContain("GitHub needs setup or authentication")
    expect(document.body.textContent).toContain("Walkthroughs require an available agent provider")
  })

  const authDocsButton = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Setup docs",
  )
  authDocsButton?.click()
  expect(calls.openExternalUrl).toHaveBeenCalledWith("https://cli.github.com/manual/gh_auth_login")
})

scenario("unsupportedGitHubCli", async () => {
  installDiffDashApi({
    diagnostics: AppPrerequisites.make({
      ...readyPrerequisites,
      setupRequirements: [
        SetupRequirement.make({
          key: "provider:github",
          providerId: GitProviderId.make("github"),
          title: "GitHub ready",
          description: "Connect GitHub to search repositories and review pull requests.",
          detail: "GitHub CLI is unsupported. Update the provider tooling, then restart DiffDash.",
          ready: false,
          requiredForLocalUse: false,
          helpUrl: null,
        }),
      ],
    }),
  })
  renderApp()

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain(
      "GitHub CLI is unsupported. Update the provider tooling, then restart DiffDash.",
    )
  })
})

scenario("updateDownloadRestart", async () => {
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

scenario("updateFailureTitle", async () => {
  installDiffDashApi({
    updateState: AppUpdateFailed.make({
      currentVersion: "0.3.0",
      message: "Could not prepare the update download.",
    }),
  })
  renderApp()

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Update failed")
    expect(document.body.textContent).toContain("Could not prepare the update download.")
    expect(document.body.textContent).not.toContain("Update check failed")
  })
})

scenario("remoteRepositorySearch", async () => {
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
    providerId: "github",
    namespaces: ["hanipcode", "fungsi"],
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
    providerId: "github",
    namespaces: ["fungsi"],
    query: "owners",
  })
})

scenario("repositorySearchFailure", async () => {
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

scenario("repositoryInvalidation", async () => {
  const calls = installDiffDashApi()
  renderApp()
  await vi.waitFor(() => expect(document.body.textContent).toContain("Bookmarked Repos"))
  const searchInput = document.querySelector<HTMLInputElement>(
    'input[placeholder="Search bookmarked and accessible repositories"]',
  )
  expect(searchInput).not.toBeNull()
  if (searchInput === null) return
  setInputValue(searchInput, "invalidations")
  searchInput.dispatchEvent(new Event("input", { bubbles: true }))
  await vi.waitFor(() => expect(calls.searchRepositories).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(document.body.textContent).toContain("fungsi/remote-review"))

  calls.listRepositories.mockClear()
  calls.searchRepositories.mockClear()
  const bookmarkButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === "Bookmark",
  )
  expect(bookmarkButton).toBeDefined()
  bookmarkButton?.click()

  await vi.waitFor(() => expect(calls.favoriteRemoteRepository).toHaveBeenCalledOnce())
  await vi.waitFor(() => {
    expect(calls.listRepositories).toHaveBeenCalledTimes(2)
    expect(calls.searchRepositories).toHaveBeenCalledOnce()
  })
  expect(calls.listRepositories.mock.calls.filter(([query]) => query === undefined)).toHaveLength(1)
  expect(
    calls.listRepositories.mock.calls.filter(([query]) => query === "invalidations"),
  ).toHaveLength(1)
})

scenario("walkthroughNoAgent", async () => {
  const calls = installDiffDashApi({
    diagnostics: noAgentPrerequisites,
    agentProviderCatalog: EMPTY_AGENT_PROVIDER_CATALOG,
  })
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
    expect(document.body.textContent).toContain("Walkthroughs require an available agent provider")
  })

  const walkthroughTab = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Walkthrough",
  )
  expect(walkthroughTab).toBeDefined()
  expect(walkthroughTab?.disabled).toBe(true)
  walkthroughTab?.click()
  expect(calls.getWalkthrough).not.toHaveBeenCalled()
})

scenario("unavailableProviderRoute", async () => {
  const unavailableReason = "Claude authentication is required."
  const catalog = AgentProviderCatalog.make({
    ...readyAgentProviderCatalog,
    providers: readyAgentProviderCatalog.providers.map((agentProvider) =>
      agentProvider.id === "claude"
        ? AgentProviderStatus.make({
            ...agentProvider,
            capabilities: agentProvider.capabilities.map((capability) =>
              capability.capability === "walkthrough"
                ? AgentProviderCapabilityStatus.make({
                    ...capability,
                    status: "unavailable",
                    runtimeVersion: null,
                    reason: unavailableReason,
                  })
                : capability,
            ),
          })
        : agentProvider,
    ),
  })
  installDiffDashApi({
    agentProviderCatalog: catalog,
    settings: AISettings.make({
      ...DEFAULT_AI_SETTINGS,
      routes: { ...DEFAULT_AI_SETTINGS.routes, walkthrough: "claude" },
    }),
  })
  renderApp()

  await vi.waitFor(() => expect(document.body.textContent).toContain("Bookmarked Repos"))
  const reviewButton = [...document.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.includes("Open requested review #51"),
  )
  reviewButton?.click()
  await vi.waitFor(() => expect(document.body.textContent).toContain("Opened PR #51"))
  const walkthroughTab = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Walkthrough",
  )
  expect(walkthroughTab?.disabled).toBe(true)
  const settingsButton = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Agent settings"]',
  )
  settingsButton?.focus()
  settingsButton?.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
  )

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain(unavailableReason)
    const selectedClaude = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ].find(
      (button) =>
        (button.textContent?.includes("Claude") ?? false) &&
        button.getAttribute("aria-checked") === "true",
    )
    expect(selectedClaude).toBeDefined()
  })
})

scenario("agentMenusKeyboard", async () => {
  installDiffDashApi()
  renderApp()

  await vi.waitFor(() => expect(document.body.textContent).toContain("Recent Review Requests"))
  const reviewButton = [...document.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.includes("Open requested review #51"),
  )
  reviewButton?.click()
  await vi.waitFor(() => expect(document.body.textContent).toContain("Opened PR #51"))

  const actionsButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.includes("Actions") ?? false,
  )
  actionsButton?.click()
  await vi.waitFor(() => {
    expect(document.querySelector('[role="menu"][aria-label="Review actions"]')).not.toBeNull()
  })
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" }),
  )
  await vi.waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("menuitem"))
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
  )
  await vi.waitFor(() => {
    expect(actionsButton?.getAttribute("aria-expanded")).toBe("false")
    expect(document.activeElement).toBe(actionsButton)
  })

  const settingsButton = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Agent settings"]',
  )
  settingsButton?.click()
  await vi.waitFor(() => {
    expect(document.querySelector('[role="menu"][aria-label="Agent settings"]')).not.toBeNull()
  })
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" }),
  )
  await vi.waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("menuitemradio"))
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
  )
  await vi.waitFor(() => {
    expect(settingsButton?.getAttribute("aria-expanded")).toBe("false")
    expect(document.activeElement).toBe(settingsButton)
  })

  settingsButton?.click()
  await vi.waitFor(() =>
    expect(document.querySelector('[role="menu"][aria-label="Agent settings"]')).not.toBeNull(),
  )
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
  await vi.waitFor(() => expect(settingsButton?.getAttribute("aria-expanded")).toBe("false"))
})

scenario("explicitProviderRouting", async () => {
  installDiffDashApi({
    agentProviderCatalog: AgentProviderCatalog.make({
      ...readyAgentProviderCatalog,
      autoCandidates: AgentProviderAutoCandidates.make({
        walkthrough: [],
        reviewThread: [],
      }),
    }),
    settings: AISettings.make({
      ...DEFAULT_AI_SETTINGS,
      routes: { ...DEFAULT_AI_SETTINGS.routes, walkthrough: "claude" },
    }),
  })
  renderApp()

  await vi.waitFor(() => expect(document.body.textContent).toContain("Bookmarked Repos"))
  const reviewButton = [...document.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.includes("Open requested review #51"),
  )
  reviewButton?.click()
  await vi.waitFor(() => expect(document.body.textContent).toContain("Opened PR #51"))
  const walkthroughTab = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Walkthrough",
  )
  expect(walkthroughTab?.disabled).toBe(false)
})

scenario("sampledWalkthrough", async () => {
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

scenario("walkthroughSettingsPersistence", async () => {
  const calls = installDiffDashApi({
    updateSettings: async () => {
      throw new Error("settings disk denied")
    },
  })
  renderApp()

  await vi.waitFor(() => expect(document.body.textContent).toContain("Recent Review Requests"))
  const reviewButton = [...document.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.includes("Open requested review #51"),
  )
  reviewButton?.click()
  await vi.waitFor(() => expect(document.body.textContent).toContain("Opened PR #51"))
  const walkthroughTab = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Walkthrough",
  )
  walkthroughTab?.click()
  await vi.waitFor(() => expect(document.body.textContent).toContain("Review focus"))

  const settingsButton = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Agent settings"]',
  )
  settingsButton?.click()
  await vi.waitFor(() => {
    expect(
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].some(
        (button) => button.textContent === "Claude",
      ),
    ).toBe(true)
  })
  const claudeButton = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
  ].find((button) => button.textContent === "Claude")
  claudeButton?.click()

  await vi.waitFor(() => {
    expect(calls.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        routes: expect.objectContaining({ walkthrough: "claude" }),
      }),
    )
    const autoButton = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ].find((button) => button.textContent?.includes("Auto") ?? false)
    expect(autoButton?.getAttribute("aria-checked")).toBe("true")
  })
})

scenario("rapidSettingsOrdering", async () => {
  let rejectFirst: (error: unknown) => void = ignoreRejection
  let resolveSecond: (settings: AISettings) => void = ignoreSettingsResolution
  let writeCount = 0
  const calls = installDiffDashApi({
    updateSettings: (_settings) => {
      writeCount += 1
      if (writeCount === 1) {
        return new Promise<AISettings>((_resolve, reject) => {
          rejectFirst = reject
        })
      }
      return new Promise<AISettings>((resolve) => {
        resolveSecond = resolve
      })
    },
  })
  renderApp()
  await vi.waitFor(() => expect(document.body.textContent).toContain("Recent Review Requests"))
  const reviewButton = [...document.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.includes("Open requested review #51"),
  )
  reviewButton?.click()
  await vi.waitFor(() => expect(document.body.textContent).toContain("Opened PR #51"))
  document.querySelector<HTMLButtonElement>('button[aria-label="Agent settings"]')?.click()
  await vi.waitFor(() => expect(document.querySelector('[role="menuitemradio"]')).not.toBeNull())
  findSettingsRadio("Claude")?.click()
  findSettingsRadio("Codex")?.click()
  expect(findSettingsRadio("Codex")?.getAttribute("aria-checked")).toBe("true")
  await vi.waitFor(() => expect(calls.updateSettings).toHaveBeenCalledOnce())

  rejectFirst(new Error("older settings write failed"))
  await vi.waitFor(() => expect(calls.updateSettings).toHaveBeenCalledTimes(2))
  const latestSettings = calls.updateSettings.mock.calls[1]?.[0]
  expect(latestSettings).toBeDefined()
  if (latestSettings === undefined) return
  resolveSecond(plainAISettings(latestSettings))

  await vi.waitFor(() =>
    expect(findSettingsRadio("Codex")?.getAttribute("aria-checked")).toBe("true"),
  )
  expect(findSettingsRadio("Auto")?.getAttribute("aria-checked")).not.toBe("true")
})

scenario("staleLocalFavorites", async () => {
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
    expect(calls.listPullRequests).toHaveBeenCalledWith({
      repository: expect.objectContaining({
        providerId: "github",
        namespace: "fungsi",
        name: "diffdash",
      }),
    })
  })
  expect(calls.listPullRequests).not.toHaveBeenCalledWith("local", "diffdash-fe11f30a1061")
})

scenario("linkRepositoryBanner", async () => {
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
      repository: expect.objectContaining({
        providerId: "github",
        namespace: "fungsi",
        name: "diffdash",
      }),
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

scenario("dismissRepositoryBanner", async () => {
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

scenario("cliLinkRepository", async () => {
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

scenario("cliRepositoryPullRequests", async () => {
  const calls = installDiffDashApi()
  renderApp()

  await vi.waitFor(() => expect(document.body.textContent).toContain("Bookmarked Repos"))
  calls.openPullRequest(null, "/workspace/diffdash")

  await vi.waitFor(() => {
    expect(calls.installRepository).toHaveBeenCalledWith("/workspace/diffdash")
    expect(document.body.textContent).toContain("1 open PR in fungsi/diffdash")
  })
})

scenario("cliNumberedPullRequest", async () => {
  const calls = installDiffDashApi()
  renderApp()

  await vi.waitFor(() => expect(document.body.textContent).toContain("Bookmarked Repos"))
  calls.openPullRequest(51, "/workspace/diffdash")

  await vi.waitFor(() => {
    expect(calls.installRepository).toHaveBeenCalledWith("/workspace/diffdash")
    expect(document.body.textContent).toContain("Opened PR #51")
  })
})

scenario("cliPullRequestFailure", async () => {
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

scenario("cliBranchComparison", async () => {
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

scenario("cliBranchNoAncestor", async () => {
  const calls = installDiffDashApi()
  calls.resolveBranch.mockRejectedValueOnce(
    new Error(
      `localReviews:resolveBranch failed: LocalReviewTargetError: { "operation": "branch.mergeBase", "reason": "Branch dev does not share a common ancestor with the current HEAD", "cause": {} }`,
    ),
  )
  renderApp()

  await vi.waitFor(() => expect(document.body.textContent).toContain("Bookmarked Repos"))
  calls.openBranchDiff("dev")

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain(
      "Could not resolve comparison branch: Branch dev does not share a common ancestor with the current HEAD",
    )
    expect(document.body.textContent).not.toContain("branch.mergeBase")
  })
})

scenario("fileTreeSelection", async () => {
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

  docsTreeItem.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }))

  await vi.waitFor(() => {
    expect(document.querySelector('[data-selected-review-path="docs/readme.md"]')).not.toBeNull()
    expect(getDiffShadowRoot("docs/readme.md")?.textContent).toContain("docs update")
  })

  diffPane.dispatchEvent(new Event("scroll", { bubbles: true }))
  diffPane.dispatchEvent(new Event("scroll", { bubbles: true }))
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))

  expect(elementFromPoint).toHaveBeenCalledTimes(1)
  expect(document.querySelector('[data-selected-review-path="docs/readme.md"]')).not.toBeNull()
})

scenario("incrementalSnapshotPages", async () => {
  const fixture = makeManyFileDiffFixture()
  const calls = installDiffDashApi({
    pullRequestDetail: fixture.manyDetail,
    pullRequestDiff: fixture.manyDiff,
    reviewRequests: [fixture.manyPullRequest],
  })
  renderApp()

  await vi.waitFor(() => expect(document.body.textContent).toContain("Recent Review Requests"))
  const reviewButton = [...document.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.includes("Open requested review #58"),
  )
  reviewButton?.click()

  await vi.waitFor(() => {
    expect(calls.getReviewSnapshotPage).toHaveBeenCalled()
    expect(getDiffShadowRoot(fixture.paths[0] ?? "")?.textContent).toContain("after")
  })
  const firstRequest = calls.getReviewSnapshotPage.mock.calls[0]?.[0]
  expect(firstRequest?.fileIds).toHaveLength(3)
  expect(firstRequest?.fileIds.length).toBeLessThan(fixture.paths.length)

  const targetFileId = parseUnifiedDiff(fixture.manyDiff.diff).files.find(
    (file) => file.path === fixture.targetPath,
  )?.fileId
  expect(targetFileId).toBeDefined()
  const target = getChangedFilesTreeItem(fixture.targetPath)
  target?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }))
  await vi.waitFor(() => {
    expect(
      calls.getReviewSnapshotPage.mock.calls.some(([request]) =>
        targetFileId === undefined ? false : request.fileIds.includes(targetFileId),
      ),
    ).toBe(true)
    expect(
      document.querySelector(`[data-diff-card-path="${fixture.targetPath}"] diffs-container`),
    ).not.toBeNull()
  })
})

scenario("snapshotExpiryReload", async () => {
  const expiryPullRequest = HostedReviewSummary.make({
    ...pullRequest,
    locator: makeHostedReviewLocator("github", "fungsi", "diffdash", 59),
    title: "Snapshot expiry recovery",
  })
  const calls = installDiffDashApi({
    expireFirstSnapshotPage: true,
    pullRequestDetail: HostedReviewDetail.make({ ...detail, summary: expiryPullRequest }),
    pullRequestDiff: HostedReviewDiff.make({ ...diff, locator: expiryPullRequest.locator }),
    reviewRequests: [expiryPullRequest],
  })
  renderApp()

  await vi.waitFor(() => expect(document.body.textContent).toContain("Recent Review Requests"))
  const reviewButton = [...document.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.includes("Open requested review #59"),
  )
  reviewButton?.click()

  await vi.waitFor(() => expect(calls.getReviewSnapshotPage).toHaveBeenCalled())
  const firstPageResponse = await calls.getReviewSnapshotPage.mock.results[0]?.value
  expect(firstPageResponse?.["_tag"]).toBe("expired")

  await vi.waitFor(() => {
    expect(getDiffShadowRoot("src/app.tsx")?.textContent).toContain("new")
    expect(calls.getHostedReviewSnapshot.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(calls.getReviewSnapshotPage.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

scenario("largeDiffVirtualization", async () => {
  const lineCount = 3_000
  const fixture = makeLargeDiffFixture(lineCount, 52, 379)
  installDiffDashApi({
    pullRequestDetail: fixture.largeDetail,
    pullRequestDiff: fixture.largeDiff,
    reviewRequests: [fixture.largePullRequest],
  })
  renderApp({ strictMode: true })

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
  const largeDiffShadowRoot = getDiffShadowRoot(fixture.largePath)
  expect(largeDiffShadowRoot?.querySelectorAll('[data-virtualizer-buffer="before"]')).toHaveLength(
    0,
  )
  expect(largeDiffShadowRoot?.querySelectorAll('[data-virtualizer-buffer="after"]')).toHaveLength(1)
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
  tailTreeItem?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }))

  await vi.waitFor(
    () => {
      const tailCard = document.querySelector<HTMLElement>(
        `[data-diff-card-path="${fixture.tailPath}"]`,
      )
      expect(
        document.querySelector(`[data-selected-review-path="${fixture.tailPath}"]`),
      ).not.toBeNull()
      expect(tailCard).not.toBeNull()
      expect(getDiffShadowRoot(fixture.tailPath)?.textContent).toContain("tail1")
      expect(tailCard?.querySelector("[data-diff-loading-skeleton]")).toBeNull()
      expect(tailCard?.querySelector("[data-diff-card-body]")?.getAttribute("aria-busy")).toBe(
        "false",
      )
      if (diffPane === null || tailCard === null) return
      const paneRect = diffPane.getBoundingClientRect()
      const tailRect = tailCard.getBoundingClientRect()
      expect(tailRect.bottom).toBeGreaterThan(paneRect.top)
      expect(tailRect.top).toBeLessThan(paneRect.bottom)
    },
    { timeout: 5_000 },
  )
  expect(getMountedDiffLineCount()).toBeLessThan(1_000)

  const filterInput = document.querySelector<HTMLInputElement>('input[placeholder="Filter files"]')
  expect(filterInput).not.toBeNull()
  if (filterInput !== null) {
    setInputValue(filterInput, "generated-large")
    filterInput.dispatchEvent(new Event("input", { bubbles: true }))
  }
  await vi.waitFor(() => {
    expect(getDiffCardPaths()).toEqual([fixture.largePath])
  })
})

scenario("wrappedFileBuffers", async () => {
  const fixture = makeManyFileDiffFixture()
  installDiffDashApi({
    pullRequestDetail: fixture.manyDetail,
    pullRequestDiff: fixture.manyDiff,
    reviewRequests: [fixture.manyPullRequest],
  })
  renderApp({ strictMode: true })

  await vi.waitFor(() => expect(document.body.textContent).toContain("Recent Review Requests"))
  const reviewButton = [...document.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.includes("Open requested review #58"),
  )
  reviewButton?.click()
  await vi.waitFor(() => expect(getDiffCardPaths()).toHaveLength(fixture.paths.length))

  const visitFile = async (path: string) => {
    const treeItem = await vi.waitFor(() => {
      const item = getChangedFilesTreeItem(path)
      expect(item).not.toBeNull()
      if (item === null) throw new Error(`Missing file-tree item for ${path}`)
      return item
    })
    treeItem.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }))
    await vi.waitFor(
      () => {
        expect(document.querySelector(`[data-selected-review-path="${path}"]`)).not.toBeNull()
        expect(getDiffShadowRoot(path)?.querySelector("[data-line]")).not.toBeNull()
      },
      { timeout: 20_000 },
    )
  }
  const shiftedPath = fixture.paths[2] ?? ""
  const secondVisitedPath = fixture.paths[7] ?? ""
  expect(shiftedPath).not.toBe("")
  expect(secondVisitedPath).not.toBe("")
  await visitFile(shiftedPath)
  await visitFile(secondVisitedPath)

  getViewedCheckbox(shiftedPath)?.click()
  await vi.waitFor(() => expect(getViewedCheckbox(shiftedPath)?.checked).toBe(true))

  dispatchKeyboardShortcut("f", { metaKey: true })
  const searchInput = await vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>("[data-review-search-input]")
    expect(input).not.toBeNull()
    return input!
  })
  setInputValue(searchInput, "TARGET_FINAL_691")
  searchInput.dispatchEvent(new Event("input", { bubbles: true }))

  await vi.waitFor(
    () => {
      expect(getHighlightTexts(REVIEW_SEARCH_ACTIVE_HIGHLIGHT)).toEqual(["TARGET_FINAL_691"])
      const activeLine = getActiveHighlightLine()
      const targetRoot = getDiffShadowRoot(fixture.targetPath)
      const targetCard = document.querySelector<HTMLElement>(
        `[data-diff-card-path="${fixture.targetPath}"]`,
      )
      const sentinelCard = document.querySelector<HTMLElement>(
        `[data-diff-card-path="${fixture.sentinelPath}"]`,
      )
      expect(activeLine?.getAttribute("data-line")).toBe("691")
      expect(targetRoot?.contains(activeLine ?? null)).toBe(true)
      const afterBufferHeight =
        targetRoot
          ?.querySelector<HTMLElement>('[data-virtualizer-buffer="after"]')
          ?.getBoundingClientRect().height ?? 0
      expect(afterBufferHeight).toBeLessThanOrEqual(1)
      expect(targetCard).not.toBeNull()
      expect(sentinelCard).not.toBeNull()
      if (targetCard === null || sentinelCard === null) return
      const cardGap =
        sentinelCard.getBoundingClientRect().top - targetCard.getBoundingClientRect().bottom
      expect(cardGap).toBeGreaterThanOrEqual(14)
      expect(cardGap).toBeLessThanOrEqual(18)
      expect(getMountedDiffLineCount()).toBeLessThan(1_500)
    },
    { timeout: 15_000 },
  )
})

scenario("diffSearchSubstrings", async () => {
  installDiffDashApi({
    pullRequestDiff: HostedReviewDiff.make({
      ...diff,
      diff: diff.diff.replace(
        "-old\n+new",
        "-const previous = createAgent()\n+const AgentProvider = createAgent()",
      ),
    }),
  })
  renderApp()

  await vi.waitFor(() => expect(document.body.textContent).toContain("Recent Review Requests"))
  const reviewButton = [...document.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.includes("Open requested review #51"),
  )
  reviewButton?.click()
  await vi.waitFor(() => expect(getDiffShadowRoot("src/app.tsx")).not.toBeNull())

  dispatchKeyboardShortcut("f", { metaKey: true })
  const searchInput = await vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>("[data-review-search-input]")
    expect(input).not.toBeNull()
    return input!
  })
  setInputValue(searchInput, "agent")
  searchInput.dispatchEvent(new Event("input", { bubbles: true }))

  await vi.waitFor(() => {
    expect(document.querySelector("[data-review-search-toolbar]")?.textContent).toContain("1 / 3")
    expect(getHighlightTexts(REVIEW_SEARCH_ACTIVE_HIGHLIGHT)).toEqual(["Agent"])
    expect(getHighlightTexts(REVIEW_SEARCH_MATCH_HIGHLIGHT)).toEqual(["Agent", "Agent"])
  })

  searchInput.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
  )
  await vi.waitFor(() => {
    expect(document.querySelector("[data-review-search-toolbar]")?.textContent).toContain("2 / 3")
    expect(getHighlightTexts(REVIEW_SEARCH_ACTIVE_HIGHLIGHT)).toEqual(["Agent"])
  })

  searchInput.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      shiftKey: true,
    }),
  )
  await vi.waitFor(() => {
    expect(document.querySelector("[data-review-search-toolbar]")?.textContent).toContain("1 / 3")
  })

  dispatchKeyboardShortcut("Escape")
  await vi.waitFor(() => {
    expect(document.querySelector("[data-review-search-toolbar]")).toBeNull()
    expect(CSS.highlights.has(REVIEW_SEARCH_ACTIVE_HIGHLIGHT)).toBe(false)
    expect(CSS.highlights.has(REVIEW_SEARCH_MATCH_HIGHLIGHT)).toBe(false)
  })
})

scenario("diffSearchVisibility", async () => {
  installDiffDashApi()
  renderApp()

  await vi.waitFor(() => expect(document.body.textContent).toContain("Recent Review Requests"))
  const reviewButton = [...document.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.includes("Open requested review #51"),
  )
  reviewButton?.click()
  await vi.waitFor(() => expect(getDiffCardPaths()).toEqual(["src/app.tsx", "docs/readme.md"]))

  dispatchKeyboardShortcut("f", { metaKey: true })
  const searchInput = await vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>("[data-review-search-input]")
    expect(input).not.toBeNull()
    return input!
  })
  setInputValue(searchInput, "lock new")
  searchInput.dispatchEvent(new Event("input", { bubbles: true }))
  await vi.waitFor(() => {
    expect(getDiffCardPaths()).toContain("pnpm-lock.yaml")
    expect(getHighlightTexts(REVIEW_SEARCH_ACTIVE_HIGHLIGHT)).toEqual(["lock new"])
  })

  dispatchKeyboardShortcut("Escape")
  await vi.waitFor(() => expect(getDiffCardPaths()).not.toContain("pnpm-lock.yaml"))

  const docsViewedCheckbox = getViewedCheckbox("docs/readme.md")
  docsViewedCheckbox?.click()
  await vi.waitFor(() => {
    expect(getViewedCheckbox("docs/readme.md")?.checked).toBe(true)
    expect(getDiffShadowRoot("docs/readme.md")).toBeNull()
  })
  const filterInput = document.querySelector<HTMLInputElement>('input[placeholder="Filter files"]')
  expect(filterInput).not.toBeNull()
  if (filterInput === null) return
  setInputValue(filterInput, "app")
  filterInput.dispatchEvent(new Event("input", { bubbles: true }))
  await vi.waitFor(() => expect(getDiffCardPaths()).toEqual(["src/app.tsx"]))

  dispatchKeyboardShortcut("f", { metaKey: true })
  const reopenedSearchInput = await vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>("[data-review-search-input]")
    expect(input).not.toBeNull()
    return input!
  })
  setInputValue(reopenedSearchInput, "docs update")
  reopenedSearchInput.dispatchEvent(new Event("input", { bubbles: true }))
  await vi.waitFor(() => {
    expect(getDiffCardPaths()).toEqual(["src/app.tsx", "docs/readme.md"])
    expect(getViewedCheckbox("docs/readme.md")?.checked).toBe(true)
    expect(getDiffShadowRoot("docs/readme.md")).not.toBeNull()
    expect(getHighlightTexts(REVIEW_SEARCH_ACTIVE_HIGHLIGHT)).toEqual(["docs update"])
  })

  dispatchKeyboardShortcut("Escape")
  await vi.waitFor(() => expect(getDiffCardPaths()).toEqual(["src/app.tsx"]))
  setInputValue(filterInput, "")
  filterInput.dispatchEvent(new Event("input", { bubbles: true }))
  await vi.waitFor(() => {
    expect(getViewedCheckbox("docs/readme.md")?.checked).toBe(true)
    expect(getDiffShadowRoot("docs/readme.md")).toBeNull()
  })
})

scenario("virtualizedSearch", async () => {
  const fixture = makeLargeDiffFixture(3_000, 56)
  const api = installDiffDashApi({
    pullRequestDetail: fixture.largeDetail,
    pullRequestDiff: fixture.largeDiff,
    reviewRequests: [fixture.largePullRequest],
  })
  renderApp()

  await vi.waitFor(() => expect(document.body.textContent).toContain("Recent Review Requests"))
  const reviewButton = [...document.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.includes("Open requested review #56"),
  )
  reviewButton?.click()
  await vi.waitFor(() => expect(getMountedDiffLineCount()).toBeGreaterThan(0))

  dispatchKeyboardShortcut("f", { metaKey: true })
  const searchInput = await vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>("[data-review-search-input]")
    expect(input).not.toBeNull()
    return input!
  })
  setInputValue(searchInput, "tail after")
  searchInput.dispatchEvent(new Event("input", { bubbles: true }))
  await vi.waitFor(
    () => {
      expect(getHighlightTexts(REVIEW_SEARCH_ACTIVE_HIGHLIGHT)).toEqual(["tail after"])
      const activeLine = getActiveHighlightLine()
      expect(getDiffShadowRoot(fixture.tailPath)?.contains(activeLine ?? null)).toBe(true)
    },
    { timeout: 5_000 },
  )

  setInputValue(searchInput, "value2999")
  searchInput.dispatchEvent(new Event("input", { bubbles: true }))

  await vi.waitFor(
    () => {
      expect(document.querySelector("[data-review-search-toolbar]")?.textContent).toContain("1 / 2")
      expect(getHighlightTexts(REVIEW_SEARCH_ACTIVE_HIGHLIGHT)).toEqual(["value2999"])
      expect(getActiveHighlightLine()?.getAttribute("data-line")).toBe("2999")
      expect(getMountedDiffLineCount()).toBeLessThan(500)
    },
    { timeout: 5_000 },
  )

  setInputValue(searchInput, "after")
  searchInput.dispatchEvent(new Event("input", { bubbles: true }))
  await vi.waitFor(() => {
    expect(document.querySelector("[data-review-search-toolbar]")?.textContent).toContain(
      "1 / 3001",
    )
  })
  searchInput.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      shiftKey: true,
    }),
  )

  await vi.waitFor(
    () => {
      expect(document.querySelector("[data-review-search-toolbar]")?.textContent).toContain(
        "3001 / 3001",
      )
      expect(getHighlightTexts(REVIEW_SEARCH_ACTIVE_HIGHLIGHT)).toEqual(["after"])
      const activeLine = getActiveHighlightLine()
      const tailShadowRoot = getDiffShadowRoot(fixture.tailPath)
      expect(activeLine).not.toBeNull()
      expect(tailShadowRoot?.contains(activeLine ?? null)).toBe(true)

      const diffPane = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
      const stickyChrome = document.querySelector<HTMLElement>("[data-review-sticky-chrome]")
      expect(diffPane).not.toBeNull()
      expect(stickyChrome).not.toBeNull()
      if (activeLine === null || diffPane === null || stickyChrome === null) return
      const activeRect = activeLine.getBoundingClientRect()
      const paneRect = diffPane.getBoundingClientRect()
      expect(activeRect.bottom).toBeGreaterThan(paneRect.top + stickyChrome.offsetHeight)
      expect(activeRect.top).toBeLessThan(paneRect.bottom)
      expect(getMountedDiffLineCount()).toBeLessThan(500)
    },
    { timeout: 5_000 },
  )

  searchInput.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    }),
  )
  await vi.waitFor(() => {
    expect(document.querySelector("[data-review-search-toolbar]")?.textContent).toContain(
      "1 / 3001",
    )
  })

  for (let index = 0; index < 200; index += 1) {
    searchInput.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }),
    )
  }
  await vi.waitFor(
    () => {
      expect(document.querySelector("[data-review-search-toolbar]")?.textContent).toContain(
        "201 / 3001",
      )
      const revisitedPageCalls = api.searchReviewSnapshot.mock.calls.filter(
        ([request]) => request.cursor?.startsWith("search:v1:200:") === true,
      )
      expect(revisitedPageCalls).toHaveLength(2)
    },
    { timeout: 5_000 },
  )

  searchInput.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      shiftKey: true,
    }),
  )
  await vi.waitFor(() => {
    expect(document.querySelector("[data-review-search-toolbar]")?.textContent).toContain(
      "200 / 3001",
    )
  })
})

scenario("wrappedSearchConvergence", async () => {
  const fixture = makeLargeDiffFixture(300, 57)
  const padding = "x".repeat(1_500)
  installDiffDashApi({
    pullRequestDetail: fixture.largeDetail,
    pullRequestDiff: HostedReviewDiff.make({
      ...fixture.largeDiff,
      diff: fixture.largeDiff.diff
        .replaceAll('"before"', `"before ${padding}"`)
        .replaceAll('"after"', `"after ${padding}"`),
    }),
    reviewRequests: [fixture.largePullRequest],
  })
  renderApp()

  await vi.waitFor(() => expect(document.body.textContent).toContain("Recent Review Requests"))
  const reviewButton = [...document.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.includes("Open requested review #57"),
  )
  reviewButton?.click()
  await vi.waitFor(() => expect(getMountedDiffLineCount()).toBeGreaterThan(0))

  dispatchKeyboardShortcut("f", { metaKey: true })
  const searchInput = await vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>("[data-review-search-input]")
    expect(input).not.toBeNull()
    return input!
  })
  setInputValue(searchInput, "value300")
  searchInput.dispatchEvent(new Event("input", { bubbles: true }))

  await vi.waitFor(
    () => {
      expect(getHighlightTexts(REVIEW_SEARCH_ACTIVE_HIGHLIGHT)).toEqual(["value300"])
      const activeLine = getActiveHighlightLine()
      const diffPane = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
      const stickyChrome = document.querySelector<HTMLElement>("[data-review-sticky-chrome]")
      expect(activeLine?.getAttribute("data-line")).toBe("300")
      expect(diffPane).not.toBeNull()
      expect(stickyChrome).not.toBeNull()
      if (activeLine === null || diffPane === null || stickyChrome === null) return
      const activeRect = activeLine.getBoundingClientRect()
      const paneRect = diffPane.getBoundingClientRect()
      expect(activeRect.bottom).toBeGreaterThan(paneRect.top + stickyChrome.offsetHeight)
      expect(activeRect.top).toBeLessThan(paneRect.bottom)
    },
    { timeout: 10_000 },
  )
})

scenario("veryLargePlainDiff", async () => {
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

scenario("viewedViewportAnchor", async () => {
  const fixture = makeLargeDiffFixture(400, 54, 400)
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
    button.getAttribute("aria-label")?.includes("Open requested review #54"),
  )
  reviewButton?.click()

  await vi.waitFor(() => {
    expect(getMountedDiffLineCount()).toBeGreaterThan(0)
    expect(
      document
        .querySelector(`[data-diff-card-path="${fixture.largePath}"] [data-diff-card-body]`)
        ?.getAttribute("aria-busy"),
    ).toBe("false")
  })
  const diffPane = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
  const stickyChrome = document.querySelector<HTMLElement>("[data-review-sticky-chrome]")
  const largeCard = document.querySelector<HTMLElement>(
    `[data-diff-card-path="${fixture.largePath}"]`,
  )
  expect(diffPane).not.toBeNull()
  expect(stickyChrome).not.toBeNull()
  expect(largeCard).not.toBeNull()
  if (diffPane === null || stickyChrome === null || largeCard === null) return

  const visibleTop = diffPane.getBoundingClientRect().top + stickyChrome.offsetHeight
  window.scrollTo(0, 0)
  diffPane.scrollTop += largeCard.getBoundingClientRect().top - visibleTop + 300
  diffPane.dispatchEvent(new Event("scroll", { bubbles: true }))
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
  expect(largeCard.getBoundingClientRect().top).toBeLessThan(visibleTop - 250)
  const diffContainer = largeCard.querySelector("diffs-container")
  expect(diffContainer).not.toBeNull()

  dispatchKeyboardShortcut("v")
  await vi.waitFor(() => {
    expect(getViewedCheckbox(fixture.largePath)?.checked).toBe(true)
    expect(largeCard.querySelector("diffs-container")).toBeNull()
    expect(Math.abs(largeCard.getBoundingClientRect().top - visibleTop)).toBeLessThanOrEqual(1)
    expect(window.scrollY).toBe(0)
  })

  const viewedCheckbox = getViewedCheckbox(fixture.largePath)
  viewedCheckbox?.focus()
  viewedCheckbox?.click()
  await vi.waitFor(() => {
    expect(getViewedCheckbox(fixture.largePath)?.checked).toBe(false)
    expect(largeCard.querySelector("diffs-container")).not.toBeNull()
    expect(largeCard.querySelector("diffs-container")).not.toBe(diffContainer)
    expect(getDiffShadowRoot(fixture.largePath)?.querySelector("[data-line]")).not.toBeNull()
  })
  await new Promise<void>((resolve) =>
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())),
  )

  await vi.waitFor(
    () => {
      const visibleLine = getDiffShadowRoot(fixture.largePath)?.querySelector<HTMLElement>(
        "[data-line]",
      )
      expect(visibleLine).not.toBeNull()
      const visibleLineRect = visibleLine?.getBoundingClientRect()
      const diffPaneRect = diffPane.getBoundingClientRect()
      expect(window.scrollY).toBe(0)
      expect(Math.abs(largeCard.getBoundingClientRect().top - visibleTop)).toBeLessThanOrEqual(1)
      expect(visibleLineRect?.bottom).toBeGreaterThan(visibleTop)
      expect(visibleLineRect?.top).toBeLessThan(diffPaneRect.bottom)
    },
    { timeout: 5_000 },
  )
})

scenario("markAllViewedViewport", async () => {
  const fixture = makeLargeDiffFixture(400, 55, 400)
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
    button.getAttribute("aria-label")?.includes("Open requested review #55"),
  )
  reviewButton?.click()

  await vi.waitFor(() => {
    expect(getMountedDiffLineCount()).toBeGreaterThan(0)
  })
  const diffPane = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
  const stickyChrome = document.querySelector<HTMLElement>("[data-review-sticky-chrome]")
  const largeCard = document.querySelector<HTMLElement>(
    `[data-diff-card-path="${fixture.largePath}"]`,
  )
  expect(diffPane).not.toBeNull()
  expect(stickyChrome).not.toBeNull()
  expect(largeCard).not.toBeNull()
  if (diffPane === null || stickyChrome === null || largeCard === null) return

  const visibleTop = diffPane.getBoundingClientRect().top + stickyChrome.offsetHeight
  const targetScrollTop =
    diffPane.scrollTop + largeCard.getBoundingClientRect().top - visibleTop + 300
  await vi.waitFor(() => {
    expect(diffPane.scrollHeight - diffPane.clientHeight).toBeGreaterThanOrEqual(targetScrollTop)
  })
  diffPane.scrollTop = targetScrollTop
  diffPane.dispatchEvent(new Event("scroll", { bubbles: true }))
  await vi.waitFor(() => {
    expect(largeCard.getBoundingClientRect().top).toBeLessThan(visibleTop - 250)
  })

  const actionsButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.includes("Actions") ?? false,
  )
  actionsButton?.click()
  await vi.waitFor(() => {
    expect(document.querySelector('[role="menu"][aria-label="Review actions"]')).not.toBeNull()
  })
  const markAllButton = [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[role="menu"][aria-label="Review actions"] button',
    ),
  ].find((button) => button.textContent?.includes("Mark all viewed") ?? false)
  markAllButton?.click()

  await vi.waitFor(() => {
    expect(getViewedCheckbox(fixture.largePath)?.checked).toBe(true)
    expect(getViewedCheckbox(fixture.tailPath)?.checked).toBe(true)
    expect(diffPane.scrollTop).toBe(Math.max(0, diffPane.scrollHeight - diffPane.clientHeight))
    expect(window.scrollY).toBe(0)
  })
})

scenario("viewedAcrossPushes", async () => {
  const calls = installDiffDashApi()
  renderApp()

  await vi.waitFor(() => expect(document.body.textContent).toContain("Recent Review Requests"))
  const reviewButton = [...document.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.includes("Open requested review #51"),
  )
  reviewButton?.click()
  await vi.waitFor(() => expect(getViewedCheckbox("src/app.tsx")).not.toBeNull())

  dispatchKeyboardShortcut("v")
  await vi.waitFor(() => expect(getViewedCheckbox("src/app.tsx")?.checked).toBe(true))

  const secondHead = "cccccccccccccccccccccccccccccccccccccccc"
  calls.getPullRequestDetail.mockResolvedValue(
    HostedReviewDetail.make({
      ...detail,
      summary: HostedReviewSummary.make({
        ...detail.summary,
        head: BranchRevision.make({ ...detail.summary.head, revision: secondHead }),
      }),
    }),
  )
  calls.getPullRequestDiff.mockResolvedValue(
    HostedReviewDiff.make({
      ...diff,
      diff: diff.diff.replace("+docs update", "+docs update again"),
      headRevision: secondHead,
    }),
  )
  await reloadReviewDiff()
  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Headccccccc")
    expect(getViewedCheckbox("src/app.tsx")?.checked).toBe(true)
  })

  const thirdHead = "dddddddddddddddddddddddddddddddddddddddd"
  calls.getPullRequestDetail.mockResolvedValue(
    HostedReviewDetail.make({
      ...detail,
      summary: HostedReviewSummary.make({
        ...detail.summary,
        head: BranchRevision.make({ ...detail.summary.head, revision: thirdHead }),
      }),
    }),
  )
  calls.getPullRequestDiff.mockResolvedValue(
    HostedReviewDiff.make({
      ...diff,
      diff: diff.diff.replace("+new", "+new behavior"),
      headRevision: thirdHead,
    }),
  )
  await reloadReviewDiff()
  await vi.waitFor(() => {
    expect(getViewedCheckbox("src/app.tsx")?.checked).toBe(false)
  })
})

scenario("viewedPersistenceRollback", async () => {
  const calls = installDiffDashApi({
    setViewedFile: async () => {
      throw new Error("viewed file storage unavailable")
    },
  })
  renderApp()
  await vi.waitFor(() => expect(document.body.textContent).toContain("Recent Review Requests"))
  const reviewButton = [...document.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.includes("Open requested review #51"),
  )
  reviewButton?.click()
  await vi.waitFor(() => expect(getViewedCheckbox("src/app.tsx")).not.toBeNull())
  const checkbox = getViewedCheckbox("src/app.tsx")
  expect(checkbox).not.toBeNull()
  checkbox?.click()
  expect(checkbox?.checked).toBe(true)

  await vi.waitFor(() => {
    expect(calls.setViewedFile).toHaveBeenCalledOnce()
    expect(getViewedCheckbox("src/app.tsx")?.checked).toBe(false)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "viewed and expansion state was reverted",
    )
  })
  const card = getViewedCheckbox("src/app.tsx")?.closest("section")
  expect(card?.querySelector("[data-diff-card-body]")).not.toBeNull()
})

scenario("homeToReview", async () => {
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
  const repoPaletteButton = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find(
    (button) => button.textContent?.includes("Remote bookmarked repository") ?? false,
  )
  expect(repoPaletteButton).toBeDefined()
  repoPaletteButton?.click()

  await vi.waitFor(() => {
    expect(calls.listPullRequests).toHaveBeenCalledWith({
      repository: expect.objectContaining({
        providerId: "github",
        namespace: "fungsi",
        name: "diffdash",
      }),
    })
    expect(document.body.textContent).toContain("1 open PR in fungsi/diffdash")
  })

  dispatchKeyboardShortcut("k", { metaKey: true })
  await vi.waitFor(() => {
    expect(
      document.querySelector<HTMLInputElement>('dialog input[placeholder="Search repos and PRs"]'),
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
    expect(shadowRoot === null ? null : (getDiffLine(shadowRoot, "new") ?? null)).not.toBeNull()
  })
  const diffShadow = getDiffShadowRoot("src/app.tsx")
  expect(diffShadow).not.toBeNull()
  const addedLine = getDiffLine(diffShadow!, "new")
  const lineNumber = addedLine?.getAttribute("data-line")
  const addedLineIndex = addedLine?.getAttribute("data-line-index")
  expect(addedLine).toBeDefined()
  expect(lineNumber).toBe("1")
  const gutterNumber = [...diffShadow!.querySelectorAll<HTMLElement>("[data-column-number]")].find(
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
  refreshedGutterNumber
    ?.closest("pre")
    ?.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }))
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

  const addedDiffLine = await vi.waitFor(() => {
    const line = getDiffLine(diffShadow!, "new")
    expect(line).toBeDefined()
    if (line === undefined) throw new Error("Missing added diff line")
    return line
  })
  addedDiffLine.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }))
  await vi.waitFor(() => {
    expect(document.querySelector('textarea[aria-label="Thread message"]')).not.toBeNull()
  })
  const refreshedAddedDiffLine = await vi.waitFor(() => {
    const line = getDiffLine(diffShadow!, "new")
    expect(line).toBeDefined()
    if (line === undefined) throw new Error("Missing refreshed added diff line")
    return line
  })
  refreshedAddedDiffLine.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }))
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
  calls.getHostedReviewSnapshot.mockClear()
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
    expect(calls.getHostedReviewSnapshot).toHaveBeenCalledWith({ review: expect.anything() })
    expect(calls.getPullRequestDetail).toHaveBeenCalledWith({ review: expect.anything() })
    expect(calls.getPullRequestDiff).toHaveBeenCalledWith({ review: expect.anything() })
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
  const docsPaletteButton = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find(
    (button) => button.textContent?.includes("docs/readme.md") ?? false,
  )
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
    expect(calls.approvePullRequest).toHaveBeenCalledWith({
      decision: "approved",
      review: expect.anything(),
    })
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
    expect(calls.getWalkthrough).toHaveBeenCalledWith({
      review: expect.anything(),
      baseRevision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      headRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    })
    expect(calls.generateWalkthrough).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain("Review focus")
    expect(document.body.textContent).toContain("Diff-only")
    expect(document.body.textContent).toContain("Entry point")
    expect(document.body.textContent).toContain("CRITICAL")
    expect(getDiffCardPaths()).toEqual(["src/app.tsx"])
    expect(
      document.querySelector(
        '[data-diff-card-path="src/app.tsx"] button[aria-label="Collapse diff"]',
      ),
    ).not.toBeNull()
    expect(getDiffShadowRoot("src/app.tsx")?.textContent ?? "").toContain("new")
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
    (button) => button.getAttribute("aria-label") === "Agent settings",
  )
  expect(settingsButton).toBeDefined()
  settingsButton?.click()

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Walkthrough agent")
    expect(document.body.textContent).toContain("Review comment agent")
  })

  const claudeButton = [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.includes("Claude") ?? false,
  )
  expect(claudeButton).toBeDefined()
  claudeButton?.click()

  await vi.waitFor(() => {
    expect(calls.updateSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        routes: expect.objectContaining({ walkthrough: "claude" }),
      }),
    )
    expect(document.body.textContent).toContain("Sonnet 5.0")
  })

  const reviewClaudeButton = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
  ].filter((button) => button.textContent?.includes("Claude") ?? false)[1]
  expect(reviewClaudeButton).toBeDefined()
  reviewClaudeButton?.click()
  await vi.waitFor(() => {
    expect(calls.updateSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        routes: expect.objectContaining({ reviewThread: "claude" }),
      }),
    )
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
    expect(calls.regenerateWalkthrough).toHaveBeenCalledWith({
      regenerate: true,
      review: expect.anything(),
    })
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
    expect(calls.openRepositoryFile).toHaveBeenCalledWith({
      review: expect.anything(),
      filePath: "src/app.tsx",
      headRefName: "feature/requested-review",
      headRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    })
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

scenario("localReview", async () => {
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
    ...document.querySelectorAll<HTMLButtonElement>('[data-diff-card-path="src/local.ts"] button'),
  ].find((button) => button.textContent === "Open")
  expect(localOpenButton).toBeDefined()
  localOpenButton?.click()

  await vi.waitFor(() => {
    expect(calls.openLocalRepositoryFile).toHaveBeenCalledWith(localReview.rootPath, "src/local.ts")
  })
})

scenario("providerTerminology", async () => {
  const calls = installDiffDashApi({
    providers: [fixtureProvider],
    pullRequestDetail: fixtureDetail,
    pullRequestDiff: fixtureDiff,
    reviewRequests: [fixturePullRequest],
  })
  renderApp()

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("open a merge request")
  })
  const openReview = document.querySelector<HTMLButtonElement>(
    'button[aria-label^="Open requested review #73"]',
  )
  expect(openReview).not.toBeNull()
  openReview?.click()

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Opened MR #73")
    expect(document.body.textContent).toContain("Fixture merge request flow")
  })
  const actions = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Actions",
  )
  actions?.click()
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull())
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("Approve")
  expect(calls.approvePullRequest).not.toHaveBeenCalled()
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

const getHighlightTexts = (name: string) =>
  [...(CSS.highlights.get(name) ?? [])].map((highlightRange) => {
    const range = document.createRange()
    range.setStart(highlightRange.startContainer, highlightRange.startOffset)
    range.setEnd(highlightRange.endContainer, highlightRange.endOffset)
    const text = range.toString()
    range.detach()
    return text
  })

const getActiveHighlightLine = () => {
  const activeRange = CSS.highlights.get(REVIEW_SEARCH_ACTIVE_HIGHLIGHT)?.values().next().value
  return activeRange?.startContainer.parentElement?.closest<HTMLElement>("[data-line]") ?? null
}

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

const reloadReviewDiff = async () => {
  const actionsButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.includes("Actions") ?? false,
  )
  actionsButton?.click()
  await vi.waitFor(() => {
    expect(document.querySelector('[role="menu"][aria-label="Review actions"]')).not.toBeNull()
  })
  const reloadButton = [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[role="menu"][aria-label="Review actions"] button',
    ),
  ].find((button) => button.textContent?.includes("Reload diff") ?? false)
  reloadButton?.click()
}

const dispatchSideMouseButton = (button: number) => {
  window.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button, cancelable: true }))
}

const renderApp = ({ strictMode = false }: { readonly strictMode?: boolean } = {}) => {
  const rootElement = document.createElement("div")
  rootElement.id = "root"
  document.body.append(rootElement)
  root = createRoot(rootElement)
  root.render(
    strictMode ? (
      <StrictMode>
        <App />
      </StrictMode>
    ) : (
      <App />
    ),
  )
}

const setInputValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(input, value)
}

const installDiffDashApi = (
  options: {
    readonly appState?: AppState
    readonly agentProviderCatalog?: AgentProviderCatalog
    readonly cliInstallResult?: { readonly path: string; readonly pathSetupCommand: string | null }
    readonly diagnostics?: AppPrerequisites
    readonly expireFirstSnapshotPage?: boolean
    readonly pullRequestDetail?: HostedReviewDetail
    readonly pullRequestDiff?: HostedReviewDiff
    readonly providers?: readonly GitProviderDescriptor[]
    readonly repositories?: readonly Repo[]
    readonly reviewRequests?: readonly HostedReviewSummary[]
    readonly setViewedFile?: DiffDashApi["viewedFiles"]["set"]
    readonly setLocalViewedFile?: DiffDashApi["viewedFiles"]["setLocal"]
    readonly settings?: AISettings
    readonly updateSettings?: DiffDashApi["settings"]["update"]
    readonly updateState?: AppUpdateState
    readonly walkthrough?: StoredWalkthrough
  } = {},
) => {
  const viewedFiles = new Map<string, ParsedDiffFile["patchHash"]>()
  const localViewedFiles = new Map<string, ParsedDiffFile["patchHash"]>()
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
  let expireNextSnapshotPage = options.expireFirstSnapshotPage ?? false
  const snapshots = new Map<string, ReviewSnapshot>()
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
  const acquireLocalReviewSnapshot = vi.fn<DiffDashApi["reviewSnapshots"]["acquireLocal"]>(
    async (target) => {
      const localDetail = await getLocalReviewDetail(target)
      const localReviewPatch = await getLocalReviewDiff(target)
      const reviewKey = ReviewKey.make(`local:${target.rootPath}`)
      const baseRevision = ReviewRevision.make(localReviewPatch.baseSha)
      const headRevision = ReviewRevision.make(localReviewPatch.headSha)
      const snapshot = LocalReviewSnapshot.make({
        snapshotId: makeReviewSnapshotId({
          reviewKey,
          baseRevision,
          headRevision,
          diffIdentity: ReviewDiffIdentity.make(localReviewPatch.diffHash),
        }),
        reviewKey,
        baseRevision,
        headRevision,
        detail: localDetail,
        diff: localReviewPatch,
        parsedDiff: parseUnifiedDiff(localReviewPatch.diff),
      })
      snapshots.set(snapshot.snapshotId, snapshot)
      return makeReviewSnapshotManifest(snapshot)
    },
  )
  const calls = {
    captureAnalytics: vi.fn<DiffDashApi["analytics"]["capture"]>(async () => undefined),
    startAnalytics: vi.fn<DiffDashApi["analytics"]["start"]>(async () => undefined),
    generateWalkthrough: vi.fn<DiffDashApi["walkthroughs"]["generate"]>(
      async () => options.walkthrough ?? walkthrough,
    ),
    getWalkthrough: vi.fn<DiffDashApi["walkthroughs"]["get"]>(
      async () => options.walkthrough ?? walkthrough,
    ),
    regenerateWalkthrough: vi.fn<DiffDashApi["walkthroughs"]["generate"]>(
      async () => options.walkthrough ?? walkthrough,
    ),
    updateSettings: vi.fn<DiffDashApi["settings"]["update"]>(
      options.updateSettings ?? (async (settings) => plainAISettings(settings)),
    ),
    listRepositories: vi.fn<DiffDashApi["repositories"]["list"]>(async () => repositories),
    favoriteRemoteRepository: vi.fn<DiffDashApi["repositories"]["favoriteRemote"]>(
      async (remoteRepo) =>
        Repo.make({
          ...repo,
          id: `${remoteRepo.locator.namespace}/${remoteRepo.locator.name}`,
          name: remoteRepo.locator.name,
          owner: remoteRepo.locator.namespace,
          remoteUrl: remoteRepo.url,
        }),
    ),
    setRepositoryFavorite: vi.fn<DiffDashApi["repositories"]["setFavorite"]>(async () => repo),
    setViewedFile: vi.fn<DiffDashApi["viewedFiles"]["set"]>(
      options.setViewedFile ?? (async () => undefined),
    ),
    setLocalViewedFile: vi.fn<DiffDashApi["viewedFiles"]["setLocal"]>(
      options.setLocalViewedFile ?? (async () => undefined),
    ),
    listPullRequests: vi.fn<DiffDashApi["hostedReviews"]["list"]>(async () => [pullRequest]),
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
    linkRepository: vi.fn<DiffDashApi["repositories"]["link"]>(async (input) =>
      Repo.make({ ...repo, localPath: input.localPath }),
    ),
    selectLocalFolder: vi.fn<() => Promise<string | null>>(async () => null),
    openExternalUrl: vi.fn<(url: string) => Promise<void>>(async () => undefined),
    updateAppState: vi.fn<(state: AppState) => Promise<AppState>>(async (state) => state),
    checkForUpdates: vi.fn<() => Promise<void>>(async () => undefined),
    downloadUpdate: vi.fn<() => Promise<void>>(async () => undefined),
    restartAndInstallUpdate: vi.fn<() => Promise<void>>(async () => undefined),
    getLocalReviewDetail,
    getLocalReviewDiff,
    acquireLocalReviewSnapshot,
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
      (
        request: Parameters<DiffDashApi["reviewSnapshots"]["acquireHosted"]>[0],
      ) => Promise<HostedReviewDetail>
    >(async () => options.pullRequestDetail ?? detail),
    getPullRequestDiff: vi.fn<
      (
        request: Parameters<DiffDashApi["reviewSnapshots"]["acquireHosted"]>[0],
      ) => Promise<HostedReviewDiff>
    >(async () => options.pullRequestDiff ?? diff),
    searchRepositories: vi.fn<DiffDashApi["hostedRepositories"]["searchRepositories"]>(async () => [
      remoteSearchResult,
    ]),
    openLocalRepositoryFile: vi.fn<(rootPath: string, filePath: string) => Promise<void>>(
      async () => undefined,
    ),
    openRepositoryFile: vi.fn<DiffDashApi["openRepositoryFile"]>(async () => undefined),
    approvePullRequest: vi.fn<DiffDashApi["hostedReviews"]["submitDecision"]>(async () => {
      approved = true
    }),
  }
  const getHostedReviewSnapshot = vi.fn<DiffDashApi["reviewSnapshots"]["acquireHosted"]>(
    async (request) => {
      const pullRequestDetail = await calls.getPullRequestDetail(request)
      const pullRequestDiff = await calls.getPullRequestDiff(request)
      const reviewKey = ReviewKey.make(
        `${request.review.repository.providerId}:${request.review.repository.namespace}/${request.review.repository.name}#${request.review.number}`,
      )
      const baseRevision = ReviewRevision.make(pullRequestDetail.summary.base.revision ?? "unknown")
      const headRevision = ReviewRevision.make(pullRequestDiff.headRevision ?? "unknown")
      const snapshot = HostedReviewSnapshot.make({
        snapshotId: makeReviewSnapshotId({
          reviewKey,
          baseRevision,
          headRevision,
          diffIdentity: makeReviewDiffIdentity(pullRequestDiff.diff),
        }),
        reviewKey,
        baseRevision,
        headRevision,
        detail: pullRequestDetail,
        diff: pullRequestDiff,
        parsedDiff: parseUnifiedDiff(pullRequestDiff.diff),
      })
      snapshots.set(snapshot.snapshotId, snapshot)
      return makeReviewSnapshotManifest(snapshot)
    },
  )
  const getReviewSnapshotPage = vi.fn<DiffDashApi["reviewSnapshots"]["getPage"]>(
    async (request) => {
      const snapshot = snapshots.get(request.snapshotId)
      if (expireNextSnapshotPage) {
        expireNextSnapshotPage = false
        snapshots.delete(request.snapshotId)
        return ReviewSnapshotExpired.make({ snapshotId: request.snapshotId, reason: "evicted" })
      }
      if (snapshot === undefined || request.cursor !== null) {
        return ReviewSnapshotExpired.make({
          snapshotId: request.snapshotId,
          reason: snapshot === undefined ? "evicted" : "mismatched",
        })
      }
      const selected =
        request.fileIds.length === 0
          ? snapshot.parsedDiff.files
          : request.fileIds.flatMap((fileId) => {
              const file = snapshot.parsedDiff.files.find(
                (candidate) => candidate.fileId === fileId,
              )
              return file === undefined ? [] : [file]
            })
      if (request.fileIds.length > 0 && selected.length !== request.fileIds.length) {
        return ReviewSnapshotExpired.make({
          snapshotId: request.snapshotId,
          reason: "mismatched",
        })
      }
      return ReviewSnapshotPageAvailable.make({
        snapshotId: request.snapshotId,
        files: selected,
        nextCursor: null,
      })
    },
  )
  const searchReviewSnapshot = vi.fn<DiffDashApi["reviewSnapshots"]["search"]>(async (request) => {
    const snapshot = snapshots.get(request.snapshotId)
    if (snapshot === undefined) {
      return ReviewSnapshotExpired.make({
        snapshotId: request.snapshotId,
        reason: "evicted",
      })
    }
    const index = buildReviewSearchIndex(snapshot.parsedDiff.files)
    const occurrences = searchReviewIndex(index, request.query)
    const offset =
      request.cursor === null ? 0 : Number(/^search:v1:([0-9]+):/.exec(request.cursor)?.[1])
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > occurrences.length) {
      return ReviewSnapshotExpired.make({
        snapshotId: request.snapshotId,
        reason: "mismatched",
      })
    }
    const end = Math.min(occurrences.length, offset + request.limit)
    const matches = occurrences.slice(offset, end).flatMap((occurrence) => {
      const file = snapshot.parsedDiff.files.find(
        (candidate) => candidate.reviewKey === occurrence.reviewKey,
      )
      if (file === undefined) return []
      return [
        ReviewSnapshotSearchMatch.make({
          id: occurrence.id,
          fileId: file.fileId,
          filePath: occurrence.filePath,
          reviewKey: occurrence.reviewKey,
          hunkId: ReviewHunkId.make(occurrence.hunkId),
          hunkLineIndex: occurrence.hunkLineIndex,
          newLineNumber: occurrence.newLineNumber,
          oldLineNumber: occurrence.oldLineNumber,
          side: occurrence.side,
          text: occurrence.text,
          start: occurrence.start,
          end: occurrence.end,
        }),
      ]
    })
    return ReviewSnapshotSearchAvailable.make({
      snapshotId: request.snapshotId,
      matches,
      totalMatches: occurrences.length,
      nextCursor:
        end < occurrences.length
          ? ReviewSnapshotSearchCursor.make(`search:v1:${end}:00000000`)
          : null,
    })
  })
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
    agentProviders: {
      getCatalog: async () => options.agentProviderCatalog ?? readyAgentProviderCatalog,
    },
    installDiffDashCli: calls.installDiffDashCli,
    openExternalUrl: calls.openExternalUrl,
    openLocalRepositoryFile: calls.openLocalRepositoryFile,
    openRepositoryFile: calls.openRepositoryFile,
    providers: { list: async () => options.providers ?? [provider] },
    hostedRepositories: {
      listSearchScopes: async () => [
        RepositorySearchScope.make({ kind: "user", login: "hanipcode" }),
        RepositorySearchScope.make({ kind: "organization", login: "fungsi" }),
      ],
      searchRepositories: calls.searchRepositories,
    },
    hostedReviews: {
      submitDecision: calls.approvePullRequest,
      getDecision: async () => (approved ? "approved" : "none"),
      list: calls.listPullRequests,
      listAssigned: async () => options.reviewRequests ?? [pullRequest],
    },
    localReviews: {
      resolveBranch: calls.resolveBranch,
    },
    reviewSnapshots: {
      acquireHosted: getHostedReviewSnapshot,
      acquireLocal: calls.acquireLocalReviewSnapshot,
      getPage: getReviewSnapshotPage,
      search: searchReviewSnapshot,
    },
    repositories: {
      install: calls.installRepository,
      link: calls.linkRepository,
      favoriteRemote: calls.favoriteRemoteRepository,
      list: calls.listRepositories,
      selectLocalFolder: calls.selectLocalFolder,
      setFavorite: calls.setRepositoryFavorite,
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
      list: async () =>
        [...viewedFiles].map(([reviewKey, patchHash]) => ({ reviewKey, patchHash })),
      listLocal: async () =>
        [...localViewedFiles].map(([reviewKey, patchHash]) => ({ reviewKey, patchHash })),
      set: async (request) => {
        await calls.setViewedFile(request)
        if (request.viewed) {
          viewedFiles.set(request.reviewKey, request.patchHash)
        } else {
          viewedFiles.delete(request.reviewKey)
        }
      },
      setLocal: async (request) => {
        await calls.setLocalViewedFile(request)
        if (request.viewed) {
          localViewedFiles.set(request.reviewKey, request.patchHash)
        } else {
          localViewedFiles.delete(request.reviewKey)
        }
      },
    },
    walkthroughs: {
      generate: (request) =>
        request.regenerate
          ? calls.regenerateWalkthrough(request)
          : calls.generateWalkthrough(request),
      get: calls.getWalkthrough,
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
    getHostedReviewSnapshot,
    getReviewSnapshotPage,
    searchReviewSnapshot,
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
  version: settings.version,
  appearance: settings.appearance,
  routes: {
    walkthrough: settings.routes.walkthrough,
    reviewThread: settings.routes.reviewThread,
  },
  telemetryEnabled: settings.telemetryEnabled,
  autoQuality: settings.autoQuality,
  models: { ...settings.models },
})
