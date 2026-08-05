/* oxlint-disable vitest/no-standalone-expect, eslint/no-underscore-dangle -- Shared callbacks use Effect-compatible tagged unions. */
import {
  AISettings,
  CodeThemePreferences,
  DEFAULT_AI_SETTINGS,
  ThemePreferences,
} from "@diffdash/domain/ai-settings"
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
import {
  RendererLayoutSettings,
  ReviewPaneSettings,
} from "@diffdash/domain/renderer-layout-settings"
import {
  ProjectOpened,
  ProjectRemoteCandidate,
  ProjectRemoteSelectionRequired,
  ProjectWorkspaceState,
} from "@diffdash/domain/project-workspace"
import {
  Repo,
  RepositoryIdentityRepairSummary,
  RepositorySearchScope,
} from "@diffdash/domain/repository"
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
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewKey,
  ReviewProjectId,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import {
  MarkdownBody,
  HostedReviewTarget,
  type ReviewThreadAnchor,
  ReviewThread,
  ReviewThreadDetails,
  ReviewThreadId,
  ReviewThreadMessage,
  ReviewThreadMessageId,
} from "@diffdash/domain/review-thread"
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
  RepairRepositoryIdentitiesCommand,
} from "@diffdash/protocol/cli-navigation"
import { AppPrerequisites, SetupRequirement } from "@diffdash/protocol/prerequisites"
import {
  ReviewSnapshotExpired,
  ReviewSnapshotPageAvailable,
  ReviewSnapshotPageCursor,
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
import { lineReviewAnchor } from "../review/thread-annotations"
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

const makeLongReviewThread = (fixture: ReturnType<typeof makeLargeDiffFixture>, lineNumber = 5) => {
  const file = parseUnifiedDiff(fixture.largeDiff.diff).files[0]
  if (file === undefined) throw new Error("Expected a parsed large diff file")
  const anchor = lineReviewAnchor(file, "additions", lineNumber)
  if (anchor === null) throw new Error("Expected a reviewable line in the large diff")
  const threadId = ReviewThreadId.make("thread-long-virtualized")
  const createdAt = "2026-07-23T09:00:00Z"
  const currentBaseRevision = ReviewRevision.make(
    fixture.largeDetail.summary.base.revision ?? "unknown-base",
  )
  const currentHeadRevision = ReviewRevision.make(
    fixture.largeDetail.summary.head.revision ?? "unknown-head",
  )

  return ReviewThreadDetails.make({
    thread: ReviewThread.make({
      id: threadId,
      repoId: repo.id,
      reviewKey: ReviewKey.make(
        `${fixture.largePullRequest.locator.repository.providerId}:${fixture.largePullRequest.locator.repository.namespace}/${fixture.largePullRequest.locator.repository.name}#${fixture.largePullRequest.locator.number}`,
      ),
      prNumber: fixture.largePullRequest.locator.number,
      baseRevision: currentBaseRevision,
      headRevision: currentHeadRevision,
      currentBaseRevision,
      currentHeadRevision,
      originalAnchor: anchor,
      currentAnchor: anchor,
      anchorStatus: "active",
      createdAt,
      updatedAt: createdAt,
    }),
    messages: Array.from({ length: 80 }, (_message, index) =>
      ReviewThreadMessage.make({
        id: ReviewThreadMessageId.make(`message-long-${index + 1}`),
        threadId,
        sequence: index + 1,
        author: index % 2 === 0 ? "user" : "agent",
        bodyMarkdown: MarkdownBody.make(
          `### Review turn ${index + 1}\n\n${Array.from(
            { length: 6 },
            (_line, lineIndex) =>
              `Detailed review context ${index + 1}.${lineIndex + 1} keeps this history intentionally tall.`,
          ).join("\n\n")}`,
        ),
        status: "complete",
        agentRunId: index % 2 === 0 ? null : `run-long-${index + 1}`,
        createdAt,
        updatedAt: createdAt,
      }),
    ),
  })
}

const makeReviewThreadDetails = ({
  anchor,
  id,
  previousRevision = false,
  status = "active",
}: {
  readonly anchor: ReviewThreadAnchor
  readonly id: string
  readonly previousRevision?: boolean
  readonly status?: "active" | "outdated" | "unresolved_anchor"
}) => {
  const threadId = ReviewThreadId.make(id)
  const createdAt = "2026-07-23T09:00:00Z"
  const currentBaseRevision = ReviewRevision.make(pullRequest.base.revision ?? "unknown-base")
  const currentHeadRevision = ReviewRevision.make(pullRequest.head.revision ?? "unknown-head")
  return ReviewThreadDetails.make({
    thread: ReviewThread.make({
      id: threadId,
      repoId: repo.id,
      reviewKey: ReviewKey.make("github:fungsi/diffdash#51"),
      prNumber: pullRequest.locator.number,
      baseRevision: currentBaseRevision,
      headRevision: previousRevision
        ? ReviewRevision.make("head-thread-summary-previous")
        : currentHeadRevision,
      currentBaseRevision,
      currentHeadRevision,
      originalAnchor: anchor,
      currentAnchor: status === "active" ? anchor : null,
      anchorStatus: status,
      createdAt,
      updatedAt: createdAt,
    }),
    messages: [
      ReviewThreadMessage.make({
        id: ReviewThreadMessageId.make(`${id}-user`),
        threadId,
        sequence: 1,
        author: "user",
        bodyMarkdown: MarkdownBody.make(`Question for ${anchor.filePath}`),
        status: "complete",
        agentRunId: null,
        createdAt,
        updatedAt: createdAt,
      }),
      ReviewThreadMessage.make({
        id: ReviewThreadMessageId.make(`${id}-agent`),
        threadId,
        sequence: 2,
        author: "agent",
        bodyMarkdown: MarkdownBody.make(`Response for ${anchor.filePath}`),
        status: "complete",
        agentRunId: `${id}-run`,
        createdAt,
        updatedAt: createdAt,
      }),
    ],
  })
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
          const searchMarker =
            (fileIndex === 0 || fileIndex >= 7) && lineNumber <= 21 ? " SEARCH_WRAP_MATCH" : ""
          const nextValue =
            fileIndex === targetIndex && lineNumber === lineCount
              ? "TARGET_FINAL_691"
              : `after ${padding}${searchMarker}`
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

const makeCachePressureDiffFixture = () => {
  const number = 59
  const paths = Array.from(
    { length: 36 },
    (_, index) => `src/cache/file-${String(index + 1).padStart(2, "0")}.tsx`,
  )
  const cachePullRequest = HostedReviewSummary.make({
    ...pullRequest,
    locator: makeHostedReviewLocator("github", "fungsi", "diffdash", number),
    title: "Large paginated review",
  })
  const cacheDetail = HostedReviewDetail.make({
    summary: cachePullRequest,
    commits: [],
    files: paths.map((path) =>
      ChangedFile.make({
        additions: 1,
        changeType: "modified",
        deletions: 1,
        path,
      }),
    ),
  })
  const cacheDiff = HostedReviewDiff.make({
    ...diff,
    locator: cachePullRequest.locator,
    diff: paths
      .map(
        (path, index) => `diff --git a/${path} b/${path}
index 1111111..2222222 100644
--- a/${path}
+++ b/${path}
@@ -1 +1 @@
-const value = "before ${index}"
+const value = "after ${index}${index === 0 ? " CACHE_PIN_MATCH" : ""}"`,
      )
      .join("\n"),
  })
  return { cacheDetail, cacheDiff, cachePullRequest, paths }
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
      WalkthroughChapter.make({
        id: "duplicate-chapter",
        title: "Section A",
        summary: "First configuration section.",
        stops: [
          WalkthroughStop.make({
            hunkIds: ["src/app.tsx:hosted-review:github:fungsi/diffdash#51:h1"],
            id: "duplicate-stop",
            risk: "review",
            summary: "Review the first configuration path.",
            title: "Ci.yml",
          }),
        ],
      }),
      WalkthroughChapter.make({
        id: "duplicate-chapter",
        title: "Section B",
        summary: "Second configuration section.",
        stops: [
          WalkthroughStop.make({
            hunkIds: ["src/app.tsx:hosted-review:github:fungsi/diffdash#51:h1"],
            id: "duplicate-stop",
            risk: "review",
            summary: "Review the second configuration path.",
            title: "Ci.yml",
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
      ["codex", "Codex", "gpt-5.6-terra", "GPT 5.6 Terra"],
      ["claude", "Claude", "claude-sonnet-5", "Sonnet 5"],
      ["opencode", "OpenCode", "openai/gpt-5.6-terra", "GPT 5.6 Terra"],
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

const cliOnlyMissingPrerequisites = AppPrerequisites.make({
  ...readyPrerequisites,
  diffDashCliInstalled: false,
  diffDashCliInPath: false,
  diffDashCliPath: null,
})

const userLocalCliReadyPrerequisites = AppPrerequisites.make({
  ...readyPrerequisites,
  diffDashCliInstalled: true,
  diffDashCliInPath: false,
  diffDashCliPath: "/home/user/.local/bin/diffdash",
})

const userLocalCliReadyWithOtherMissing = AppPrerequisites.make({
  ...missingPrerequisites,
  diffDashCliInstalled: true,
  diffDashCliInPath: false,
  diffDashCliPath: "/home/user/.local/bin/diffdash",
})

let root: Root | null = null

afterEach(() => {
  root?.unmount()
  root = null
  vi.restoreAllMocks()
  document.documentElement.classList.remove("dark")
  delete document.documentElement.dataset.theme
  document.documentElement.style.colorScheme = ""
  document.body.replaceChildren()
  window.scrollTo(0, 0)
})

type AppBrowserScenario = () => void | Promise<void>

type AppBrowserScenarioId =
  | "agentMenusKeyboard"
  | "appStateRecovery"
  | "appearance"
  | "cliBranchComparison"
  | "cliBranchNoAncestor"
  | "cliLinkRepository"
  | "cliNumberedPullRequest"
  | "cliInstallReadiness"
  | "cliPathSetup"
  | "cliPullRequestFailure"
  | "cliRecheckReadiness"
  | "cliRepairRepositories"
  | "cliRepositoryPullRequests"
  | "diffSearchSubstrings"
  | "diffSearchLatestWork"
  | "diffSearchImmutableAnchor"
  | "diffSearchViewportAnchor"
  | "diffSearchVisibility"
  | "diffViewSettings"
  | "dismissRepositoryBanner"
  | "explicitProviderRouting"
  | "fastScrollPerformance"
  | "fileTreeSelection"
  | "firstRunOnboarding"
  | "homeToReview"
  | "incrementalSnapshotPages"
  | "largeDiffVirtualization"
  | "longThreadVirtualization"
  | "linkRepositoryBanner"
  | "localReview"
  | "longReviewPaths"
  | "markAllViewedViewport"
  | "missingSetupHomeBanner"
  | "multiFileSearchWrap"
  | "onboardingTelemetryOptOut"
  | "providerTerminology"
  | "projectOpenChooser"
  | "projectStateRestoration"
  | "cleanProjectReviews"
  | "failedProjectReviews"
  | "reviewNavigationLifecycle"
  | "remoteRepositorySearch"
  | "repositoryInvalidation"
  | "repositorySearchFailure"
  | "reviewThreadSidebar"
  | "sampledWalkthrough"
  | "shortcutReferenceHome"
  | "shortcutReferenceReview"
  | "shortcutReferenceTitlebarHome"
  | "shortcutReferenceTitlebarReview"
  | "snapshotExpiryReload"
  | "snapshotPageResidency"
  | "staleLocalFavorites"
  | "stickyDiffCardHeaders"
  | "threadComposerShortcut"
  | "threadNavigationConvergence"
  | "unavailableProviderRoute"
  | "unsupportedGitHubCli"
  | "updateDownloadRestart"
  | "updateFailureTitle"
  | "veryLargePlainDiff"
  | "viewedAcrossPushes"
  | "viewedPersistenceRollback"
  | "viewedShortcutPointerTarget"
  | "viewedViewportAnchor"
  | "virtualizedSearch"
  | "walkthroughNoAgent"
  | "walkthroughSettingsPersistence"
  | "workbenchTitlebar"
  | "rapidSettingsOrdering"
  | "wrappedFileBuffers"
  | "wrappedSearchConvergence"

const appBrowserScenarios = new Map<AppBrowserScenarioId, AppBrowserScenario>()
const ignoreRejection = (_error: unknown): void => undefined
const ignoreSettingsResolution = (_settings: AISettings): void => undefined

const makeBrowserWait = () => {
  let release: (() => void) | null = null
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release: () => release?.() }
}

const findSettingsRadio = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
    (button) => button.textContent === label,
  )

const findDiffViewRadio = (menu: HTMLElement, label: string) =>
  [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
    (button) => button.textContent?.startsWith(label) ?? false,
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

const openDefaultProject = async () => {
  const projectButton = await vi.waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Open project fungsi/diffdash"]',
    )
    expect(button).not.toBeNull()
    return button
  })
  projectButton?.click()
  await vi.waitFor(() => {
    expect(document.querySelector('button[aria-label="Reviews"]')).not.toBeNull()
    expect(document.body.textContent).toContain("Open pull requests")
  })
}

const openDefaultHostedReview = async () => {
  await openHostedReview(51)
}

const openHostedReview = async (number: number) => {
  await openDefaultProject()
  const reviewButton = await vi.waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>(
      `button[aria-label^="Open review #${number}:"]`,
    )
    expect(button).not.toBeNull()
    return button
  })
  reviewButton?.click()
  await vi.waitFor(() => {
    expect(document.querySelector('button[aria-label="Files"][aria-pressed="true"]')).not.toBeNull()
  })
}

scenario("appearance", async () => {
  const longCommand = Array.from(
    { length: 30 },
    (_, index) => `--filter @diffdash/package-${index + 1} test`,
  ).join(" && pnpm ")
  const longSyntaxLine = `  "changedField": "DIFFDASH_GREEN_STRING ${longCommand}",`
  expect(longSyntaxLine.length).toBeGreaterThan(1_000)
  expect(longSyntaxLine.length).toBeLessThan(2_000)
  const configuredSettings = AISettings.make({
    ...DEFAULT_AI_SETTINGS,
    appearance: "dark",
    themes: ThemePreferences.make({
      light: "catppuccin-latte",
      dark: "catppuccin-mocha",
    }),
    codeThemes: CodeThemePreferences.make({
      light: "github-light-default",
      dark: "diffdash-dark",
    }),
  })
  installDiffDashApi({
    pullRequestDetail: HostedReviewDetail.make({
      summary: pullRequest,
      commits: [],
      files: [
        ChangedFile.make({
          additions: 1,
          changeType: "modified",
          deletions: 1,
          path: "package.json",
        }),
        ChangedFile.make({
          additions: 1,
          changeType: "modified",
          deletions: 1,
          path: "config/syntax.yaml",
        }),
        ChangedFile.make({
          additions: 1,
          changeType: "modified",
          deletions: 1,
          path: "config/alias.yml",
        }),
        ChangedFile.make({
          additions: 1,
          changeType: "modified",
          deletions: 1,
          path: "src/syntax.tsx",
        }),
      ],
    }),
    pullRequestDiff: HostedReviewDiff.make({
      ...diff,
      diff: `diff --git a/package.json b/package.json
index 1111111..2222222 100644
--- a/package.json
+++ b/package.json
@@ -20,3 +20,3 @@
   "contextField": "context value",
-  "changedField": "before",
+${longSyntaxLine}
   "tailField": "tail value"
diff --git a/config/syntax.yaml b/config/syntax.yaml
index 3333333..4444444 100644
--- a/config/syntax.yaml
+++ b/config/syntax.yaml
@@ -1,4 +1,4 @@
 plainKey: plain value
-"double key": "before"
+"double key": "double value"
 'single key': 'single value'
 enabled: true
diff --git a/config/alias.yml b/config/alias.yml
index 5555555..6666666 100644
--- a/config/alias.yml
+++ b/config/alias.yml
@@ -1,2 +1,2 @@
 aliasKey: alias value
-changedKey: before
+changedKey: after
diff --git a/src/syntax.tsx b/src/syntax.tsx
index 7777777..8888888 100644
--- a/src/syntax.tsx
+++ b/src/syntax.tsx
@@ -1 +1 @@
-<section className="before"><Widget value={file.path} /></section>
+<section className="clear string"><Widget value={file.path} /></section>`,
    }),
    settings: configuredSettings,
  })
  expect((await window.diffDash.settings.get()).themes.dark).toBe("catppuccin-mocha")
  expect((await window.diffDash.settings.get()).codeThemes.dark).toBe("diffdash-dark")
  renderApp()

  await vi.waitFor(() => {
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(document.documentElement.dataset.theme).toBe("catppuccin-mocha")
    expect(document.documentElement.style.colorScheme).toBe("dark")
    expect(getComputedStyle(document.body).backgroundColor).toBe("rgb(30, 30, 46)")
  })
  await openDefaultHostedReview()
  await vi.waitFor(() => {
    const review = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
    const card = document.querySelector<HTMLElement>('[data-diff-card-path="package.json"]')
    const diffBody = card?.querySelector<HTMLElement>("[data-diff-card-body]") ?? null
    const diffRoot = getDiffShadowRoot("package.json")
    const yamlRoot = getDiffShadowRoot("config/syntax.yaml")
    const ymlRoot = getDiffShadowRoot("config/alias.yml")
    const tsxRoot = getDiffShadowRoot("src/syntax.tsx")
    expect(review).not.toBeNull()
    expect(document.querySelector("#review-thread-summary")).toBeNull()
    expect(card).not.toBeNull()
    expect(diffBody).not.toBeNull()
    if (review === null || card === null || diffBody === null) return
    expect(review?.dataset.codeThemeDark).toBe("diffdash-dark")
    expect(review?.dataset.colorScheme).toBe("dark")
    expect(card?.dataset.diffFileStatus).toBe("modified")
    expect(diffRoot).not.toBeNull()
    expect(yamlRoot).not.toBeNull()
    expect(ymlRoot).not.toBeNull()
    expect(tsxRoot).not.toBeNull()
    expect(card.querySelector("[data-diff-loading-skeleton]")).toBeNull()
    expect(getComputedStyle(review).backgroundColor).not.toBe(
      getComputedStyle(diffBody).backgroundColor,
    )

    const longLine = [
      ...(diffRoot?.querySelectorAll<HTMLElement>(
        '[data-content] > [data-line][data-line-type="change-addition"]',
      ) ?? []),
    ].find((line) => line.textContent?.includes("DIFFDASH_GREEN_STRING") ?? false)
    const syntaxTokens = [...(longLine?.querySelectorAll<HTMLElement>("span[style]") ?? [])]
    const stringToken = syntaxTokens.find(
      (token) => token.textContent?.includes("DIFFDASH_GREEN_STRING") ?? false,
    )
    expect(syntaxTokens.length).toBeGreaterThan(1)
    expect(stringToken).not.toBeUndefined()
    expect(getComputedStyle(stringToken!).color).toBe("rgb(140, 218, 148)")
    expect(getSyntaxTokenColor(diffRoot!, "changedField")).toBe("rgb(255, 166, 133)")
    expect(getSyntaxTokenColor(diffRoot!, "contextField")).toBe("rgb(255, 166, 133)")
    expect(getSyntaxTokenColor(diffRoot!, "context value")).toBe("rgb(140, 218, 148)")
    expect(getSyntaxTokenColor(yamlRoot!, "plainKey")).toBe("rgb(255, 166, 133)")
    expect(getSyntaxTokenColor(yamlRoot!, "plain value")).toBe("rgb(140, 218, 148)")
    expect(getSyntaxTokenColor(yamlRoot!, "double key")).toBe("rgb(255, 166, 133)")
    expect(getSyntaxTokenColor(yamlRoot!, "double value")).toBe("rgb(140, 218, 148)")
    expect(getSyntaxTokenColor(yamlRoot!, "single key")).toBe("rgb(255, 166, 133)")
    expect(getSyntaxTokenColor(yamlRoot!, "single value")).toBe("rgb(140, 218, 148)")
    expect(getSyntaxTokenColor(ymlRoot!, "aliasKey")).toBe("rgb(255, 166, 133)")
    expect(getSyntaxTokenColor(ymlRoot!, "alias value")).toBe("rgb(140, 218, 148)")
    expect(getSyntaxTokenColor(tsxRoot!, "section")).toBe("rgb(104, 205, 242)")
    expect(getSyntaxTokenColor(tsxRoot!, "Widget")).toBe("rgb(226, 144, 240)")
    expect(getSyntaxTokenColor(tsxRoot!, "className")).toBe("rgb(255, 222, 128)")
    expect(getSyntaxTokenColor(tsxRoot!, "value")).toBe("rgb(255, 222, 128)")
    expect(getSyntaxTokenColor(tsxRoot!, "clear string")).toBe("rgb(140, 218, 148)")
    expect(getComputedStyle(diffRoot!.host).color).toBe("rgb(188, 188, 196)")

    const additionMarker = diffRoot?.querySelector<HTMLElement>(
      '[data-line-type="change-addition"][data-column-number]',
    )
    const hunkSeparator = diffRoot?.querySelector<HTMLElement>('[data-separator="line-info-basic"]')
    const hunkSeparatorContent = hunkSeparator?.querySelector<HTMLElement>(
      "[data-separator-content]",
    )
    expect(additionMarker).not.toBeNull()
    expect(hunkSeparator).not.toBeNull()
    expect(hunkSeparatorContent).not.toBeNull()
    expect(getComputedStyle(additionMarker!, "::before").opacity).toBe("0.55")

    const expectedBorder = document.createElement("div")
    const expectedSeparator = document.createElement("div")
    const expectedSeparatorBorder = document.createElement("div")
    const expectedSeparatorForeground = document.createElement("div")
    const expectedSuccess = document.createElement("div")
    expectedBorder.style.color = "var(--review-sidebar-border)"
    expectedSeparator.style.color = "var(--diff-separator)"
    expectedSeparatorBorder.style.color = "var(--diff-separator-border)"
    expectedSeparatorForeground.style.color = "var(--diff-separator-foreground)"
    expectedSuccess.style.color = "var(--review-success)"
    document.body.append(
      expectedBorder,
      expectedSeparator,
      expectedSeparatorBorder,
      expectedSeparatorForeground,
      expectedSuccess,
    )
    expect(getComputedStyle(card).borderTopColor).toBe(getComputedStyle(expectedBorder).color)
    expect(getComputedStyle(additionMarker!, "::before").backgroundColor).toBe(
      getComputedStyle(expectedSuccess).color,
    )
    expect(getComputedStyle(hunkSeparator!).backgroundColor).toBe(
      getComputedStyle(expectedSeparator).color,
    )
    expect(getComputedStyle(hunkSeparator!).boxShadow).toContain(
      getComputedStyle(expectedSeparatorBorder).color,
    )
    expect(getComputedStyle(hunkSeparatorContent!).color).toBe(
      getComputedStyle(expectedSeparatorForeground).color,
    )
    expect(getComputedStyle(hunkSeparatorContent!).fontWeight).toBe("500")
    expectedBorder.remove()
    expectedSeparator.remove()
    expectedSeparatorBorder.remove()
    expectedSeparatorForeground.remove()
    expectedSuccess.remove()
  })
  expect(document.querySelector('button[aria-label^="Use "][aria-label$=" theme"]')).toBeNull()
})

scenario("diffViewSettings", async () => {
  const calls = installDiffDashApi()
  renderApp()

  await openDefaultHostedReview()
  const content = await vi.waitFor(() => {
    const element = document.querySelector<HTMLElement>("[data-review-diff-content]")
    expect(element).not.toBeNull()
    expect(getDiffShadowRoot("src/app.tsx")).not.toBeNull()
    return element!
  })
  const settingsButton = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Diff view settings"]',
  )
  expect(settingsButton).not.toBeNull()
  expect(document.querySelector("[data-review-editor-header]")?.contains(settingsButton)).toBe(true)

  content.style.width = "700px"
  await vi.waitFor(() => {
    expect(getDiffShadowRoot("src/app.tsx")?.querySelector("[data-unified]")).not.toBeNull()
  })

  const openMenu = async () => {
    settingsButton?.click()
    return vi.waitFor(() => {
      const menu = document.querySelector<HTMLElement>(
        '[role="menu"][aria-label="Diff view settings"]',
      )
      expect(menu).not.toBeNull()
      return menu!
    })
  }
  let menu = await openMenu()
  expect(findDiffViewRadio(menu, "Auto")?.getAttribute("aria-checked")).toBe("true")
  findDiffViewRadio(menu, "Split")?.click()
  await vi.waitFor(() => {
    expect(calls.updateSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ diffViewMode: "split" }),
    )
    expect(
      getDiffShadowRoot("src/app.tsx")?.querySelector('[data-diff-type="split"]'),
    ).not.toBeNull()
  })

  menu = await openMenu()
  findDiffViewRadio(menu, "Unified")?.click()
  content.style.width = "1000px"
  await vi.waitFor(() => {
    expect(calls.updateSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ diffViewMode: "unified" }),
    )
    expect(getDiffShadowRoot("src/app.tsx")?.querySelector("[data-unified]")).not.toBeNull()
  })

  content.style.width = "1120px"
  await new Promise((resolve) => window.setTimeout(resolve, 50))
  menu = await openMenu()
  findDiffViewRadio(menu, "Auto")?.click()
  await vi.waitFor(() => {
    expect(calls.updateSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ diffViewMode: "auto" }),
    )
    expect(
      getDiffShadowRoot("src/app.tsx")?.querySelector('[data-diff-type="split"]'),
    ).not.toBeNull()
  })

  content.style.width = "1060px"
  await vi.waitFor(() => {
    expect(getDiffShadowRoot("src/app.tsx")?.querySelector("[data-unified]")).not.toBeNull()
  })
  content.style.width = "1090px"
  await new Promise((resolve) => window.setTimeout(resolve, 50))
  expect(getDiffShadowRoot("src/app.tsx")?.querySelector("[data-unified]")).not.toBeNull()
  content.style.width = "1120px"
  await vi.waitFor(() => {
    expect(
      getDiffShadowRoot("src/app.tsx")?.querySelector('[data-diff-type="split"]'),
    ).not.toBeNull()
  })
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
  expect(document.querySelector("[data-workbench-titlebar]")).not.toBeNull()
  expect(document.querySelector("[data-workbench-keyboard-shortcuts]")).not.toBeNull()
  expect(
    document.querySelector<HTMLButtonElement>("[data-workbench-command-center]")?.disabled,
  ).toBe(true)

  const docsButton = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Setup docs",
  )
  docsButton?.click()
  expect(calls.openExternalUrl).toHaveBeenCalledWith("https://cli.github.com/manual/gh_auth_login")

  const installButton = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Install CLI",
  )
  installButton?.click()
  await vi.waitFor(() => {
    expect(calls.installDiffDashCli).toHaveBeenCalled()
    expect(document.body.textContent).toContain(
      "Installed the DiffDash CLI at /usr/local/bin/diffdash",
    )
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
    expect(document.body.textContent).toContain("Pinned projects")
  })
})

scenario("workbenchTitlebar", async () => {
  installDiffDashApi()
  renderApp()

  await vi.waitFor(() => expect(document.body.textContent).toContain("Pinned projects"))
  expect(document.body.textContent).not.toContain("Repair projects")
  const titlebar = document.querySelector<HTMLElement>("[data-workbench-titlebar]")
  const viewport = document.querySelector<HTMLElement>("[data-workbench-viewport]")
  const frame = document.querySelector<HTMLElement>("[data-workbench-frame]")
  const globalRail = document.querySelector<HTMLElement>("[data-workbench-global-rail]")
  const content = document.querySelector<HTMLElement>("[data-workbench-content]")
  const commandCenter = document.querySelector<HTMLButtonElement>("[data-workbench-command-center]")
  const back = titlebar?.querySelector<HTMLButtonElement>('button[aria-label="Back"]')
  expect(titlebar).not.toBeNull()
  expect(viewport).not.toBeNull()
  expect(frame).not.toBeNull()
  expect(globalRail).not.toBeNull()
  expect(content).not.toBeNull()
  expect(commandCenter?.textContent).toContain("DiffDash")
  expect(commandCenter?.disabled).toBe(false)
  expect(back).toBeNull()
  expect(titlebar?.querySelector('button[aria-label="Review actions"]')).toBeNull()
  if (
    titlebar === null ||
    viewport === null ||
    frame === null ||
    globalRail === null ||
    content === null ||
    commandCenter === null
  )
    return

  const titlebarRect = titlebar.getBoundingClientRect()
  const viewportRect = viewport.getBoundingClientRect()
  const frameRect = frame.getBoundingClientRect()
  const globalRailRect = globalRail.getBoundingClientRect()
  const contentRect = content.getBoundingClientRect()
  const commandRect = commandCenter.getBoundingClientRect()
  expect(titlebarRect.height).toBe(48)
  expect(titlebarRect.bottom).toBe(frameRect.top)
  expect(frameRect.left).toBe(viewportRect.left + 8)
  expect(frameRect.right).toBe(viewportRect.right - 8)
  expect(frameRect.bottom).toBe(globalRailRect.top)
  expect(globalRailRect.height).toBe(8)
  expect(globalRailRect.bottom).toBe(viewportRect.bottom)
  expect(contentRect.top).toBe(frameRect.top)
  expect(contentRect.right).toBe(frameRect.right)
  expect(contentRect.bottom).toBe(frameRect.bottom)
  expect(contentRect.left).toBe(frameRect.left)
  expect(frame.dataset.workbenchFrameMode).toBe("route")
  expect(getComputedStyle(frame).borderRadius).toBe("12px")
  expect(getComputedStyle(frame).boxShadow).toBe("none")
  expect(getComputedStyle(frame).clipPath).toBe("inset(0px round 12px)")
  expect(getComputedStyle(frame).overflow).toBe("hidden")
  expect(Math.round(commandRect.left + commandRect.width / 2)).toBe(
    Math.round(titlebarRect.left + titlebarRect.width / 2),
  )
  commandCenter.focus()
  commandCenter.click()
  const palette = await vi.waitFor(() => {
    const dialog = document.querySelector<HTMLDialogElement>('dialog[aria-label="Go anywhere"]')
    expect(dialog).not.toBeNull()
    expect(
      dialog?.querySelector<HTMLInputElement>('input[placeholder="Search projects and reviews"]'),
    ).not.toBeNull()
    return dialog!
  })
  palette.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
  )
  await vi.waitFor(() => {
    expect(document.querySelector('dialog[aria-label="Go anywhere"]')).toBeNull()
    expect(document.activeElement).toBe(commandCenter)
  })
})

scenario("appStateRecovery", async () => {
  let attempt = 0
  const calls = installDiffDashApi({
    getAppState: async () => {
      attempt += 1
      if (attempt === 1) throw new Error("Application runtime unavailable")
      return { onboardingCompleted: true }
    },
  })
  renderApp()

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("DiffDash could not load application state")
    expect(document.body.textContent).toContain("Application runtime unavailable")
    expect(document.body.textContent).not.toContain("Set up DiffDash")
  })

  const retryButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Retry",
  )
  expect(retryButton).toBeDefined()
  retryButton?.click()

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Pinned projects")
    expect(document.body.textContent).not.toContain("Set up DiffDash")
  })
  expect(calls.getAppState).toHaveBeenCalledTimes(2)
})

scenario("projectOpenChooser", async () => {
  const candidates = [
    ProjectRemoteCandidate.make({
      remoteName: "origin",
      repository: makeHostedRepositoryLocator("github", "fungsi", "diffdash"),
    }),
    ProjectRemoteCandidate.make({
      remoteName: "upstream",
      repository: makeHostedRepositoryLocator("github", "upstream", "diffdash"),
    }),
  ] as const
  const calls = installDiffDashApi({
    selectLocalFolder: "/workspace/diffdash",
    openProject: async (localPath, selectedRepository) =>
      selectedRepository === undefined
        ? ProjectRemoteSelectionRequired.make({ rootPath: localPath, candidates })
        : ProjectOpened.make({ repo: Repo.make({ ...repo, localPath }) }),
  })
  renderApp()

  await vi.waitFor(() => expect(document.body.textContent).toContain("Pinned projects"))
  const openProjectButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === "Open project",
  )
  calls.selectLocalFolder.mockResolvedValueOnce(null)
  openProjectButton?.click()
  await vi.waitFor(() => expect(calls.selectLocalFolder).toHaveBeenCalledOnce())
  expect(calls.openProject).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain("Pinned projects")

  openProjectButton?.click()
  await vi.waitFor(() => {
    expect(
      document.querySelector('dialog[aria-labelledby="project-remote-chooser-title"]'),
    ).not.toBeNull()
    expect(document.body.textContent).toContain("origin · github")
    expect(document.body.textContent).toContain("upstream · github")
  })
  document.querySelector<HTMLButtonElement>('button[aria-label="Cancel opening project"]')?.click()
  await vi.waitFor(() => {
    expect(
      document.querySelector('dialog[aria-labelledby="project-remote-chooser-title"]'),
    ).toBeNull()
    expect(document.body.textContent).toContain("Pinned projects")
  })

  openProjectButton?.click()
  const selectedCandidate = await vi.waitFor(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find(
      (candidate) => candidate.textContent?.includes("fungsi/diffdash") ?? false,
    )
    expect(button).toBeDefined()
    return button
  })
  selectedCandidate?.click()
  await vi.waitFor(() => {
    expect(calls.openProject).toHaveBeenLastCalledWith(
      "/workspace/diffdash",
      expect.objectContaining({ namespace: "fungsi", name: "diffdash" }),
    )
    expect(
      document.querySelector('button[aria-label="Reviews"][aria-pressed="true"]'),
    ).not.toBeNull()
    expect(document.querySelector("[data-workbench-keyboard-shortcuts]")).not.toBeNull()
  })
})

scenario("projectStateRestoration", async () => {
  const persisted = ProjectWorkspaceState.make({
    projectId: ReviewProjectId.make(repo.id),
    activeRibbon: "reviews",
    selectedReviewTarget: HostedReviewTarget.make({
      kind: "hosted",
      review: pullRequest.locator,
    }),
    updatedAt: "2026-08-02T00:00:00.000Z",
  })
  const calls = installDiffDashApi({ projectWorkspaceState: persisted })
  renderApp()

  await openDefaultProject()
  await vi.waitFor(() => {
    expect(calls.getProjectWorkspace).toHaveBeenCalledWith(ReviewProjectId.make(repo.id))
    expect(
      document.querySelector('button[aria-label="Reviews"][aria-pressed="true"]'),
    ).not.toBeNull()
    expect(document.body.textContent).toContain("Opened PR #51")
    expect(getDiffCardPaths()).toEqual(["src/app.tsx", "docs/readme.md"])
  })
})

scenario("cleanProjectReviews", async () => {
  const localRepo = Repo.make({ ...repo, localPath: localReview.rootPath })
  installDiffDashApi({
    repositories: [localRepo],
    pullRequests: [],
    localReviewDiff: LocalReviewDiff.make({
      ...localDiff,
      diff: "",
      diffHash: "0000000000000000000000000000000000000000000000000000000000000000",
    }),
  })
  renderApp()

  await openDefaultProject()
  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Clean working tree")
    expect(document.body.textContent).toContain("No open pull requests")
    expect(document.body.textContent).not.toContain("Hosted reviews unavailable")
  })
  document
    .querySelector<HTMLButtonElement>('button[aria-label="Open working tree review"]')
    ?.click()
  await vi.waitFor(() => {
    expect(document.querySelector('button[aria-label="Files"][aria-pressed="true"]')).not.toBeNull()
    expect(document.body.textContent).toContain("No changed files in this review")
  })
})

scenario("failedProjectReviews", async () => {
  const calls = installDiffDashApi()
  calls.listPullRequests.mockRejectedValue(new Error("Hosted provider unavailable"))
  renderApp()

  await openDefaultProject()
  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Hosted reviews unavailable")
    expect(document.body.textContent).toContain("Could not load pull requests")
    expect(document.body.textContent).not.toContain("No open pull requests")
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
    (button) => button.textContent === "Install CLI",
  )
  installButton?.click()

  await vi.waitFor(() => expect(document.body.textContent).toContain(pathSetupCommand))
})

scenario("cliInstallReadiness", async () => {
  let currentDiagnostics = cliOnlyMissingPrerequisites
  const calls = installDiffDashApi({ getDiagnostics: async () => currentDiagnostics })
  renderApp()

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Finish setup")
    expect(document.body.textContent).toContain("DiffDash CLI available")
    expect(document.body.textContent).toContain("diffdash is not available to DiffDash")
  })

  currentDiagnostics = userLocalCliReadyPrerequisites
  const installButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Install CLI",
  )
  installButton?.click()

  await vi.waitFor(() => {
    expect(calls.installDiffDashCli).toHaveBeenCalledOnce()
    expect(document.body.textContent).not.toContain("Finish setup")
    expect(document.body.textContent).not.toContain("DiffDash CLI available")
  })
})

scenario("cliRecheckReadiness", async () => {
  let currentDiagnostics = missingPrerequisites
  const calls = installDiffDashApi({ getDiagnostics: async () => currentDiagnostics })
  renderApp()

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Finish setup")
    expect(document.body.textContent).toContain("DiffDash CLI available")
    expect(document.body.textContent).toContain("git was not found in PATH")
  })
  const diagnosticsCallsBeforeRecheck = calls.getDiagnostics.mock.calls.length
  currentDiagnostics = userLocalCliReadyWithOtherMissing
  const recheckButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Recheck",
  )
  recheckButton?.click()

  await vi.waitFor(() => {
    expect(calls.getDiagnostics.mock.calls.length).toBeGreaterThan(diagnosticsCallsBeforeRecheck)
    expect(document.body.textContent).toContain("Finish setup")
    expect(document.body.textContent).toContain("git was not found in PATH")
    expect(document.body.textContent).not.toContain("DiffDash CLI available")
  })
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
    expect(document.body.textContent).toContain("Pinned projects")
  })
  const searchInput = document.querySelector<HTMLInputElement>(
    'input[placeholder="Search local and hosted projects"]',
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
    expect(document.body.textContent).toContain("Pinned projects")
  })
  const searchInput = document.querySelector<HTMLInputElement>(
    'input[placeholder="Search local and hosted projects"]',
  )
  expect(searchInput).not.toBeNull()
  if (searchInput === null) return
  setInputValue(searchInput, "failure-state")
  searchInput.dispatchEvent(new Event("input", { bubbles: true }))

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("GitHub search is unavailable")
  })
  expect(document.body.textContent).toContain("Hosted")
  expect(document.body.textContent).not.toContain("No matching projects found")
})

scenario("repositoryInvalidation", async () => {
  const calls = installDiffDashApi()
  renderApp()
  await vi.waitFor(() => expect(document.body.textContent).toContain("Pinned projects"))
  const searchInput = document.querySelector<HTMLInputElement>(
    'input[placeholder="Search local and hosted projects"]',
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
    (button) => button.textContent?.trim() === "Pin",
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

  await openDefaultHostedReview()

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Opened PR #51")
  })

  const walkthroughTab = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Walkthrough",
  )
  expect(walkthroughTab).toBeDefined()
  expect(walkthroughTab?.disabled).toBe(false)
  walkthroughTab?.click()
  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Walkthroughs require an available agent provider")
    expect(calls.getWalkthrough).toHaveBeenCalled()
  })
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

  await openDefaultHostedReview()
  await vi.waitFor(() => expect(document.body.textContent).toContain("Opened PR #51"))
  await showWideReviewLayout()
  const treeButton = document.querySelector<HTMLButtonElement>('button[aria-label="Files"]')
  if (treeButton?.getAttribute("aria-expanded") !== "true") treeButton?.click()
  await vi.waitFor(() =>
    expect(
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Files"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("true"),
  )
  const walkthroughTab = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Walkthrough",
  )
  expect(walkthroughTab?.disabled).toBe(false)
  walkthroughTab?.click()
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

  await openDefaultHostedReview()
  await vi.waitFor(() => expect(document.body.textContent).toContain("Opened PR #51"))
  await showWideReviewLayout()

  const actionsButton = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Review actions"]',
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

  await openDefaultHostedReview()
  await vi.waitFor(() => expect(document.body.textContent).toContain("Opened PR #51"))
  const walkthroughTab = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Walkthrough",
  )
  expect(walkthroughTab?.disabled).toBe(false)
})

scenario("sampledWalkthrough", async () => {
  installDiffDashApi({ walkthrough: sampledWalkthrough })
  renderApp()

  await openDefaultHostedReview()

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

  await openDefaultHostedReview()
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
  await openDefaultHostedReview()
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
    expect(document.body.textContent).toContain("Pinned projects")
    expect(document.body.textContent).toContain("fungsi/diffdash")
    expect(document.body.textContent).toContain("local/diffdash-fe11f30a1061")
    expect(document.body.textContent).toContain("Local only")
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

  await openDefaultHostedReview()

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
    expect(document.querySelector('button[aria-label="Files"][aria-pressed="true"]')).not.toBeNull()
    expect(document.body.textContent).toContain("Local changes")
    expect(document.body.textContent).not.toContain("Link a checkout for isolated agent review")
  })
})

scenario("dismissRepositoryBanner", async () => {
  const calls = installDiffDashApi()
  renderApp()

  await openDefaultHostedReview()
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
    expect(document.body.textContent).toContain("Pinned projects")
  })
  calls.linkRepositoryFromCli("/workspace/diffdash")

  await vi.waitFor(() => {
    expect(calls.installRepository).toHaveBeenCalledWith("/workspace/diffdash")
    expect(document.body.textContent).toContain("Open pull requests")
  })
})

scenario("cliRepairRepositories", async () => {
  const calls = installDiffDashApi()
  renderApp()

  await vi.waitFor(() => expect(document.body.textContent).toContain("Pinned projects"))
  const listCallsBeforeRepair = calls.listRepositories.mock.calls.length
  calls.repairRepositoriesFromCli()

  await vi.waitFor(() => {
    expect(calls.repairRepositoryIdentities).toHaveBeenCalledOnce()
    expect(calls.listRepositories.mock.calls.length).toBeGreaterThan(listCallsBeforeRepair)
    expect(document.body.textContent).toContain("Repaired 1 project identities; 0 will retry")
  })
})

scenario("cliRepositoryPullRequests", async () => {
  const calls = installDiffDashApi()
  renderApp()

  await vi.waitFor(() => expect(document.body.textContent).toContain("Pinned projects"))
  calls.openPullRequest(null, "/workspace/diffdash")

  await vi.waitFor(() => {
    expect(calls.openProject).toHaveBeenCalledWith("/workspace/diffdash", undefined)
    expect(
      document.querySelector('button[aria-label="Reviews"][aria-pressed="true"]'),
    ).not.toBeNull()
    expect(document.body.textContent).toContain(
      "Local changes and hosted pull requests stay together in this workspace.",
    )
  })
})

scenario("cliNumberedPullRequest", async () => {
  const calls = installDiffDashApi()
  renderApp()

  await vi.waitFor(() => expect(document.body.textContent).toContain("Pinned projects"))
  calls.openPullRequest(51, "/workspace/diffdash")

  await vi.waitFor(() => {
    expect(calls.openProject).toHaveBeenCalledWith("/workspace/diffdash", undefined)
    expect(document.body.textContent).toContain("Opened PR #51")
    expect(document.querySelector('button[aria-label="Files"][aria-pressed="true"]')).not.toBeNull()
  })
})

scenario("cliPullRequestFailure", async () => {
  const calls = installDiffDashApi()
  calls.openProject.mockRejectedValueOnce(
    new Error(
      `repositories:install failed: (FiberFailure) RepositoryLinkError: { "operation": "detectRepository", "reason": "Select a Git repository with a GitHub origin.", "cause": {} } at internal stack`,
    ),
  )
  renderApp()

  await vi.waitFor(() => expect(document.body.textContent).toContain("Pinned projects"))
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

  await vi.waitFor(() => expect(document.body.textContent).toContain("Pinned projects"))
  calls.openBranchDiff("dev")

  await vi.waitFor(() => {
    expect(calls.resolveBranch).toHaveBeenCalledWith(localReview.rootPath, "dev")
    expect(calls.getLocalReviewDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        comparison: expect.objectContaining({ branchName: "dev" }),
      }),
    )
    expect(document.body.textContent).toContain("Changes vs dev")
    expect(document.querySelector('button[aria-label="Files"][aria-pressed="true"]')).not.toBeNull()
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

  await vi.waitFor(() => expect(document.body.textContent).toContain("Pinned projects"))
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

  await openDefaultHostedReview()

  await vi.waitFor(() => {
    expect(getDiffCardPaths()).toEqual(["src/app.tsx", "docs/readme.md"])
    expect(getChangedFilesTreeItem("docs/readme.md")).not.toBeNull()
  })

  const diffPane = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
  const docsCard = document.querySelector<HTMLElement>('[data-diff-card-path="docs/readme.md"]')
  const docsTreeItem = getChangedFilesTreeItem("docs/readme.md")
  expect(diffPane).not.toBeNull()
  expect(docsCard).not.toBeNull()
  expect(docsTreeItem).not.toBeNull()
  if (diffPane === null || docsCard === null || docsTreeItem === null) return

  docsCard.querySelector<HTMLButtonElement>('button[aria-label="Collapse diff"]')?.click()
  await vi.waitFor(() => expect(docsCard.querySelector("[data-diff-card-body]")).toBeNull())

  docsTreeItem.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }))

  await new Promise<void>((resolve) =>
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())),
  )
  await vi.waitFor(() => {
    expect(getSelectedChangedFileTreeItems()).toHaveLength(1)
    expect(getSelectedChangedFileTreeItems()[0]?.getAttribute("data-item-path")).toBe(
      "docs/readme.md",
    )
  })

  diffPane.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 120 }))
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))

  expect(getSelectedChangedFileTreeItems()).toHaveLength(1)
  expect(getSelectedChangedFileTreeItems()[0]?.getAttribute("data-item-path")).toBe(
    "docs/readme.md",
  )
  await vi.waitFor(() => {
    expect(diffPane.dataset.reviewNavigationPhase).toBe("idle")
    expect(diffPane.dataset.reviewNavigationOutcome).toBe("completed::")
  })
  diffPane.scrollTop = Math.max(0, diffPane.scrollHeight - diffPane.clientHeight)
  diffPane.dispatchEvent(new Event("scroll", { bubbles: true }))
  await waitForAnimationFrames(2)
  const stickyChrome = document.querySelector<HTMLElement>("[data-review-sticky-chrome]")
  expect(stickyChrome).not.toBeNull()
  if (stickyChrome !== null) {
    const expectedTop = diffPane.getBoundingClientRect().top + stickyChrome.offsetHeight
    expect(Math.abs(docsCard.getBoundingClientRect().top - expectedTop)).toBeLessThanOrEqual(1)
  }
})

scenario("reviewNavigationLifecycle", async () => {
  const fixture = makeManyFileDiffFixture()
  const parsedFiles = parseUnifiedDiff(fixture.manyDiff.diff).files
  const firstTarget = parsedFiles[12]
  const secondTarget = parsedFiles[13]
  if (firstTarget === undefined || secondTarget === undefined) {
    throw new Error("Expected distant navigation targets")
  }
  const releases = new Map<string, () => void>()
  const waits = new Map(
    [firstTarget, secondTarget].map((file) => {
      let release!: () => void
      const wait = new Promise<void>((resolve) => {
        release = resolve
      })
      releases.set(file.fileId, release)
      return [file.fileId, wait] as const
    }),
  )
  installDiffDashApi({
    pullRequestDetail: fixture.manyDetail,
    pullRequestDiff: fixture.manyDiff,
    reviewRequests: [fixture.manyPullRequest],
    beforeReviewSnapshotPage: async (request) => {
      const wait = request.fileIds.flatMap((fileId) => {
        const pending = waits.get(fileId)
        return pending === undefined ? [] : [pending]
      })[0]
      if (wait !== undefined) await wait
    },
  })
  renderApp()

  await openHostedReview(58)
  await showResponsiveDiffPane()
  await vi.waitFor(() => expect(getChangedFilesTreeItem(firstTarget.path)).not.toBeNull())
  const diffPane = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
  expect(diffPane).not.toBeNull()
  if (diffPane === null) return

  getChangedFilesTreeItem(firstTarget.path)?.dispatchEvent(
    new MouseEvent("click", { bubbles: true, composed: true }),
  )
  await vi.waitFor(() => {
    expect(diffPane.hasAttribute("data-review-navigation-locked")).toBe(true)
    expect(diffPane.getAttribute("aria-busy")).toBe("true")
    expect(diffPane.style.overflowY).toBe("hidden")
  })
  expect(diffPane.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true }))).toBe(
    false,
  )
  expect(
    diffPane.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, cancelable: true })),
  ).toBe(false)
  expect(
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "PageDown" }),
    ),
  ).toBe(false)

  getChangedFilesTreeItem(secondTarget.path)?.dispatchEvent(
    new MouseEvent("click", { bubbles: true, composed: true }),
  )
  await vi.waitFor(() => {
    expect(diffPane.hasAttribute("data-review-navigation-locked")).toBe(true)
    expect(getSelectedChangedFileTreeItems()[0]?.dataset.itemPath).toBe(secondTarget.path)
  })
  releases.get(firstTarget.fileId)?.()
  await waitForAnimationFrames(2)
  expect(diffPane.hasAttribute("data-review-navigation-locked")).toBe(true)
  expect(getSelectedChangedFileTreeItems()[0]?.dataset.itemPath).toBe(secondTarget.path)

  dispatchKeyboardShortcut("k", { metaKey: true })
  await vi.waitFor(() => {
    expect(document.querySelector('dialog[aria-label="Go anywhere"]')).not.toBeNull()
  })
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
  )
  await vi.waitFor(() => {
    expect(document.querySelector('dialog[aria-label="Go anywhere"]')).toBeNull()
    expect(diffPane.dataset.reviewNavigationOutcome).toBe("cancelled:user:")
    expect(diffPane.dataset.reviewNavigationPhase).toBe("idle")
    expect(diffPane.hasAttribute("data-review-navigation-locked")).toBe(false)
  })
  const terminalScrollTop = diffPane.scrollTop
  releases.get(secondTarget.fileId)?.()
  await waitForAnimationFrames(3)
  expect(diffPane.dataset.reviewNavigationOutcome).toBe("cancelled:user:")
  expect(diffPane.scrollTop).toBe(terminalScrollTop)

  getChangedFilesTreeItem(secondTarget.path)?.dispatchEvent(
    new MouseEvent("click", { bubbles: true, composed: true }),
  )
  await vi.waitFor(
    () => {
      expect(diffPane.dataset.reviewNavigationPhase).toBe("idle")
      expect(diffPane.dataset.reviewNavigationOutcome).toBe("completed::")
      expect(diffPane.hasAttribute("data-review-navigation-locked")).toBe(false)
      expect(diffPane.getAttribute("aria-busy")).toBe("false")
      const card = document.querySelector<HTMLElement>(
        `[data-diff-card-path="${secondTarget.path}"]`,
      )
      const stickyChrome = document.querySelector<HTMLElement>("[data-review-sticky-chrome]")
      const content = document.querySelector<HTMLElement>("[data-review-diff-content]")
      const spacer = document.querySelector<HTMLElement>("[data-review-scroll-past-end]")
      expect(card).not.toBeNull()
      expect(stickyChrome).not.toBeNull()
      expect(content).not.toBeNull()
      expect(spacer).not.toBeNull()
      if (card === null || stickyChrome === null || content === null || spacer === null) return
      const expectedTop = diffPane.getBoundingClientRect().top + stickyChrome.offsetHeight
      expect(Math.abs(card.getBoundingClientRect().top - expectedTop)).toBeLessThanOrEqual(1)
      const trailingContentHeight =
        content.getBoundingClientRect().bottom - card.getBoundingClientRect().top
      expect(Number.parseFloat(spacer.style.height)).toBeCloseTo(
        Math.max(0, diffPane.clientHeight - stickyChrome.offsetHeight - trailingContentHeight),
        5,
      )
    },
    { timeout: 20_000 },
  )
  diffPane.scrollTop = Math.max(0, diffPane.scrollHeight - diffPane.clientHeight)
  diffPane.dispatchEvent(new Event("scroll", { bubbles: true }))
  await waitForAnimationFrames(2)
  const finalCard = document.querySelector<HTMLElement>(
    `[data-diff-card-path="${secondTarget.path}"]`,
  )
  const finalStickyChrome = document.querySelector<HTMLElement>("[data-review-sticky-chrome]")
  expect(finalCard).not.toBeNull()
  expect(finalStickyChrome).not.toBeNull()
  if (finalCard !== null && finalStickyChrome !== null) {
    const paneRect = diffPane.getBoundingClientRect()
    const cardRect = finalCard.getBoundingClientRect()
    const visibleTop = paneRect.top + finalStickyChrome.offsetHeight
    expect(cardRect.bottom).toBeGreaterThan(visibleTop)
    expect(cardRect.top).toBeLessThan(paneRect.bottom)
  }
})

scenario("longReviewPaths", async () => {
  const longPath = "src/atomic-webhook-replay-story-with-an-extremely-long-name.test.ts"
  installDiffDashApi({
    pullRequestDetail: HostedReviewDetail.make({
      ...detail,
      files: detail.files.map((file) =>
        file.path === "src/app.tsx" ? ChangedFile.make({ ...file, path: longPath }) : file,
      ),
    }),
    pullRequestDiff: HostedReviewDiff.make({
      ...diff,
      diff: diff.diff.replaceAll("src/app.tsx", longPath),
    }),
  })
  renderApp()

  await openDefaultHostedReview()

  const card = await vi.waitFor(() => {
    const element = document.querySelector<HTMLElement>(`[data-diff-card-path="${longPath}"]`)
    expect(element).not.toBeNull()
    return element!
  })
  const pathText = card.querySelector<HTMLElement>(`[aria-label="${longPath}"]`)
  expect(pathText).not.toBeNull()
  expect(pathText?.getAttribute("aria-label")).toBe(longPath)
  expect(pathText?.className).toContain("overflow-hidden")

  const treeItem = getChangedFilesTreeItem(longPath)
  expect(treeItem).not.toBeNull()
  expect(treeItem?.getAttribute("aria-label")).toContain(
    "atomic-webhook-replay-story-with-an-extremely-long-name.test.ts",
  )
  const visibleTruncationMarker = await vi.waitFor(() => {
    const marker = [
      ...(treeItem?.querySelectorAll<HTMLElement>("[data-truncate-marker]") ?? []),
    ].find((candidate) => getComputedStyle(candidate).opacity === "1")
    expect(marker).not.toBeUndefined()
    return marker!
  })
  expect(visibleTruncationMarker.textContent).toContain("…")
  expect(getComputedStyle(visibleTruncationMarker).backgroundColor).not.toBe("rgba(0, 0, 0, 0)")
  expect(treeItem!.scrollHeight).toBe(treeItem!.clientHeight)
})

scenario("incrementalSnapshotPages", async () => {
  const fixture = makeManyFileDiffFixture()
  const calls = installDiffDashApi({
    pullRequestDetail: fixture.manyDetail,
    pullRequestDiff: fixture.manyDiff,
    reviewRequests: [fixture.manyPullRequest],
  })
  renderApp()

  await openHostedReview(58)

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

  await openHostedReview(59)

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

  await openHostedReview(52)

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

scenario("fastScrollPerformance", async () => {
  const frameCount = 48
  const fixture = makeLargeDiffFixture(3_000, 83)
  installDiffDashApi({
    pullRequestDetail: fixture.largeDetail,
    pullRequestDiff: fixture.largeDiff,
    reviewRequests: [fixture.largePullRequest],
  })
  renderApp({ strictMode: true })

  await openHostedReview(83)
  await showResponsiveDiffPane()
  const diffPane = await vi.waitFor(() => {
    const pane = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
    const body = document.querySelector<HTMLElement>(
      `[data-diff-card-path="${fixture.largePath}"] [data-diff-card-body]`,
    )
    expect(pane).not.toBeNull()
    expect(body?.getAttribute("aria-busy")).toBe("false")
    expect(getMountedDiffLineCount()).toBeGreaterThan(0)
    return pane!
  })
  await waitForAnimationFrames(8)

  type InstrumentedVirtualizer = {
    readonly markDOMDirty: () => void
    readonly requestHeightReconcile: (instance: object) => void
  }
  const virtualizer = (window as typeof window & { readonly __INSTANCE?: InstrumentedVirtualizer })
    .__INSTANCE
  expect(virtualizer).not.toBeUndefined()
  if (virtualizer === undefined) return

  const markDOMDirty = vi.spyOn(virtualizer, "markDOMDirty")
  const requestHeightReconcile = vi.spyOn(virtualizer, "requestHeightReconcile")
  const replaceHighlight = vi.spyOn(CSS.highlights, "set")
  const removeHighlight = vi.spyOn(CSS.highlights, "delete")
  const longTaskDurations: number[] = []
  const longTaskObserver = PerformanceObserver.supportedEntryTypes.includes("longtask")
    ? new PerformanceObserver((entries) => {
        entries.getEntries().forEach((entry) => longTaskDurations.push(entry.duration))
      })
    : null
  longTaskObserver?.observe({ entryTypes: ["longtask"] })

  const frameDurations = await runContinuousReviewScroll(diffPane, frameCount)
  longTaskObserver?.disconnect()
  await waitForAnimationFrames(4)

  const longFrames = frameDurations.filter((duration) => duration > 50)
  const metrics = {
    frames: frameDurations.length,
    globalInvalidations: markDOMDirty.mock.calls.length,
    longFrames: longFrames.length,
    longTasks: longTaskDurations.length,
    maxFrameDuration: Math.max(...frameDurations),
    reconciliations: requestHeightReconcile.mock.calls.length,
    searchHighlightRemovals: removeHighlight.mock.calls.length,
    searchHighlightReplacements: replaceHighlight.mock.calls.length,
  }
  expect(metrics.frames).toBe(frameCount)
  expect(metrics.globalInvalidations).toBeLessThan(frameCount * 2)
  expect(metrics.reconciliations).toBeLessThan(frameCount * 2)
  expect(metrics.longFrames).toBeLessThanOrEqual(4)
  expect(metrics.longTasks).toBeLessThanOrEqual(4)
  expect(metrics.maxFrameDuration).toBeLessThan(150)
  expect(metrics.searchHighlightRemovals).toBe(0)
  expect(metrics.searchHighlightReplacements).toBe(0)
  expect(diffPane.scrollTop).toBeGreaterThan(0)
  expect(getMountedDiffLineCount()).toBeLessThan(1_000)
  expect(window.scrollY).toBe(0)
})

scenario("longThreadVirtualization", async () => {
  const fixture = makeLargeDiffFixture(3_000, 75, 20)
  const reviewThreadDetails = [makeLongReviewThread(fixture)]
  installDiffDashApi({
    pullRequestDetail: fixture.largeDetail,
    pullRequestDiff: fixture.largeDiff,
    reviewRequests: [fixture.largePullRequest],
    reviewThreadDetails,
    settings: AISettings.make({ ...DEFAULT_AI_SETTINGS, diffViewMode: "split" }),
  })
  renderApp({ strictMode: true })

  await openHostedReview(75)
  await showResponsiveDiffPane()

  await openOnlyReviewThreadInDiff(fixture.largePath, "R5")

  const { chatBox, conversation, history } = await vi.waitFor(() => {
    const diffCard = document.querySelector<HTMLElement>(
      `[data-diff-card-path="${fixture.largePath}"]`,
    )
    const nextConversation = diffCard?.querySelector<HTMLElement>(
      "[data-review-thread-conversation]",
    )
    const nextHistory = diffCard?.querySelector<HTMLElement>("[data-review-thread-history]")
    const nextChatBox = nextConversation?.parentElement
    expect(nextConversation).not.toBeNull()
    expect(nextHistory).not.toBeNull()
    expect(nextChatBox).not.toBeNull()
    expect(nextHistory?.scrollHeight).toBeGreaterThan(nextHistory?.clientHeight ?? 0)
    if (
      nextConversation === undefined ||
      nextConversation === null ||
      nextHistory === undefined ||
      nextHistory === null ||
      nextChatBox === undefined ||
      nextChatBox === null
    ) {
      throw new Error("Expected a bounded review thread conversation")
    }
    return { chatBox: nextChatBox, conversation: nextConversation, history: nextHistory }
  })

  expect(history.getBoundingClientRect().height).toBeLessThanOrEqual(
    Math.min(28 * 16, window.innerHeight * 0.5) + 1,
  )
  expect(history.getAttribute("role")).toBe("log")
  expect(history.getAttribute("aria-label")).toContain("conversation history")
  await vi.waitFor(() => {
    expect(history.scrollHeight - history.clientHeight - history.scrollTop).toBeLessThanOrEqual(1)
  })
  expect(chatBox.getBoundingClientRect().height).toBeGreaterThan(
    history.getBoundingClientRect().height,
  )
  const composer = conversation.querySelector<HTMLFormElement>("form")
  expect(composer).not.toBeNull()
  expect(composer?.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    chatBox.getBoundingClientRect().bottom + 1,
  )

  const boundedHeight = chatBox.getBoundingClientRect().height
  history.scrollTop = history.scrollHeight
  history.dispatchEvent(new Event("scroll", { bubbles: true }))
  expect(history.scrollTop).toBeGreaterThan(0)
  expect(chatBox.getBoundingClientRect().height).toBe(boundedHeight)
  expect(getMountedDiffLineCount()).toBeLessThan(1_000)

  const tailTreeItem = getChangedFilesTreeItem(fixture.tailPath)
  expect(tailTreeItem).not.toBeNull()
  tailTreeItem?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }))
  await vi.waitFor(
    () => {
      expect(getDiffShadowRoot(fixture.tailPath)?.querySelector("[data-line]")).not.toBeNull()
      const tailCard = document.querySelector<HTMLElement>(
        `[data-diff-card-path="${fixture.tailPath}"]`,
      )
      const diffPane = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
      expect(tailCard).not.toBeNull()
      expect(diffPane).not.toBeNull()
      if (tailCard === null || diffPane === null) return
      const cardRect = tailCard.getBoundingClientRect()
      const paneRect = diffPane.getBoundingClientRect()
      expect(cardRect.bottom).toBeGreaterThan(paneRect.top)
      expect(cardRect.top).toBeLessThan(paneRect.bottom)
    },
    { timeout: 10_000 },
  )
  expect(getMountedDiffLineCount()).toBeLessThan(1_000)
})

scenario("threadNavigationConvergence", async () => {
  const targetLineNumber = 2_400
  const fixture = makeLargeDiffFixture(3_000, 77, 20)
  const longThread = makeLongReviewThread(fixture, targetLineNumber)
  const details = ReviewThreadDetails.make({
    thread: longThread.thread,
    messages: longThread.messages.slice(0, 6),
  })
  const calls = installDiffDashApi({
    pullRequestDetail: fixture.largeDetail,
    pullRequestDiff: fixture.largeDiff,
    reviewRequests: [fixture.largePullRequest],
    reviewThreadDetails: [details],
    settings: AISettings.make({ ...DEFAULT_AI_SETTINGS, diffViewMode: "unified" }),
  })
  renderApp({ strictMode: true })

  await openHostedReview(77)
  const threadsButton = await vi.waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Threads"]')
    expect(button).not.toBeNull()
    return button!
  })
  threadsButton.click()
  const threadButton = await vi.waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>(
      `button[aria-label="Open thread details for ${fixture.largePath} R${targetLineNumber}"]`,
    )
    expect(button).not.toBeNull()
    return button!
  })
  threadButton.click()
  const goToDiff = await vi.waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>(
      '[data-review-thread-detail] button[aria-label="Go to thread in diff"]',
    )
    expect(button).not.toBeNull()
    return button!
  })
  goToDiff.click()

  const mountedLine = await vi.waitFor(
    () => {
      const shadowRoot = getDiffShadowRoot(fixture.largePath)
      const line =
        shadowRoot === null
          ? undefined
          : getDiffLine(shadowRoot, `const value${targetLineNumber} = "after"`)
      const card = document.querySelector<HTMLElement>(
        `[data-diff-card-path="${fixture.largePath}"]`,
      )
      const panel = card?.querySelector<HTMLElement>(
        `[data-review-thread-id="${details.thread.id}"]`,
      )
      const composer = panel?.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Thread message"]',
      )
      const diffPane = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
      const stickyChrome = document.querySelector<HTMLElement>("[data-review-sticky-chrome]")
      const fileHeader = card?.querySelector<HTMLElement>("[data-diff-card-header]")
      expect(line).not.toBeNull()
      expect(panel).not.toBeNull()
      expect(composer).not.toBeNull()
      expect(document.activeElement).toBe(composer)
      expect(calls.activateWindow).toHaveBeenCalledOnce()
      expect(
        document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")?.dataset
          .reviewNavigationOutcome,
      ).toBe("completed::")
      expect(
        document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")?.dataset
          .reviewNavigationPhase,
      ).toBe("idle")
      expect(diffPane).not.toBeNull()
      expect(stickyChrome).not.toBeNull()
      expect(fileHeader).not.toBeNull()
      const lineRect = line!.getBoundingClientRect()
      const paneRect = diffPane!.getBoundingClientRect()
      const visibleTop = paneRect.top + stickyChrome!.offsetHeight + fileHeader!.offsetHeight
      const visibleCenter = visibleTop + (paneRect.bottom - visibleTop) / 2
      expect(Math.abs(lineRect.top + lineRect.height / 2 - visibleCenter)).toBeLessThanOrEqual(1)
      return line!
    },
    { timeout: 20_000 },
  )
  const stableTop = mountedLine.getBoundingClientRect().top
  await waitForAnimationFrames(4)
  expect(Math.abs(mountedLine.getBoundingClientRect().top - stableTop)).toBeLessThanOrEqual(1)
  expect(getMountedDiffLineCount()).toBeLessThan(1_000)
})

scenario("stickyDiffCardHeaders", async () => {
  const fixture = makeLargeDiffFixture(500, 82, 120)
  installDiffDashApi({
    pullRequestDetail: fixture.largeDetail,
    pullRequestDiff: fixture.largeDiff,
    reviewRequests: [fixture.largePullRequest],
  })
  renderApp({ strictMode: true })

  await openHostedReview(82)
  await showResponsiveDiffPane()
  await vi.waitFor(() => {
    expect(getDiffShadowRoot(fixture.largePath)?.querySelector("[data-line]")).not.toBeNull()
    expect(document.querySelector(`[data-diff-card-path="${fixture.tailPath}"]`)).not.toBeNull()
  })

  const diffPane = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
  const stickyChrome = document.querySelector<HTMLElement>("[data-review-sticky-chrome]")
  const largeCard = document.querySelector<HTMLElement>(
    `[data-diff-card-path="${fixture.largePath}"]`,
  )
  const tailCard = document.querySelector<HTMLElement>(
    `[data-diff-card-path="${fixture.tailPath}"]`,
  )
  const largeHeader = largeCard?.querySelector<HTMLElement>("[data-diff-card-header]") ?? null
  const tailHeader = tailCard?.querySelector<HTMLElement>("[data-diff-card-header]") ?? null
  expect(diffPane).not.toBeNull()
  expect(stickyChrome).not.toBeNull()
  expect(largeCard).not.toBeNull()
  expect(tailCard).not.toBeNull()
  expect(largeHeader).not.toBeNull()
  expect(tailHeader).not.toBeNull()
  if (
    diffPane === null ||
    stickyChrome === null ||
    largeCard === null ||
    tailCard === null ||
    largeHeader === null ||
    tailHeader === null
  ) {
    return
  }

  const visibleTop = () => diffPane.getBoundingClientRect().top + stickyChrome.offsetHeight
  await vi.waitFor(() => {
    expect(diffPane.style.getPropertyValue("--review-sticky-chrome-height")).toBe(
      `${stickyChrome.offsetHeight}px`,
    )
  })

  diffPane.scrollTop += largeCard.getBoundingClientRect().top - visibleTop() + 600
  diffPane.dispatchEvent(new Event("scroll", { bubbles: true }))
  await vi.waitFor(() => {
    expect(largeCard.getBoundingClientRect().top).toBeLessThan(visibleTop() - 500)
    expect(Math.abs(largeHeader.getBoundingClientRect().top - visibleTop())).toBeLessThanOrEqual(1)
  })
  const headerRect = largeHeader.getBoundingClientRect()
  const headerHit = document.elementFromPoint(headerRect.left + 8, headerRect.top + 8)
  expect(headerHit === largeHeader || largeHeader.contains(headerHit)).toBe(true)

  const chromeHeightBeforeSearch = stickyChrome.offsetHeight
  dispatchKeyboardShortcut("f", { metaKey: true })
  await vi.waitFor(() => {
    expect(document.querySelector("[data-review-search-toolbar]")).not.toBeNull()
    expect(stickyChrome.offsetHeight).toBeGreaterThan(chromeHeightBeforeSearch)
    expect(diffPane.style.getPropertyValue("--review-sticky-chrome-height")).toBe(
      `${stickyChrome.offsetHeight}px`,
    )
    expect(Math.abs(largeHeader.getBoundingClientRect().top - visibleTop())).toBeLessThanOrEqual(1)
  })
  dispatchKeyboardShortcut("Escape")
  await vi.waitFor(() => {
    expect(document.querySelector("[data-review-search-toolbar]")).toBeNull()
    expect(stickyChrome.offsetHeight).toBe(chromeHeightBeforeSearch)
    expect(Math.abs(largeHeader.getBoundingClientRect().top - visibleTop())).toBeLessThanOrEqual(1)
  })

  largeHeader.querySelector<HTMLButtonElement>('button[aria-label="Collapse diff"]')?.click()
  await vi.waitFor(() => {
    expect(largeCard.querySelector("[data-diff-card-body]")).toBeNull()
    expect(Math.abs(largeCard.getBoundingClientRect().top - visibleTop())).toBeLessThanOrEqual(1)
  })
  largeHeader.querySelector<HTMLButtonElement>('button[aria-label="Expand diff"]')?.click()
  await vi.waitFor(() => {
    expect(largeCard.querySelector("[data-diff-card-body]")).not.toBeNull()
    expect(getDiffShadowRoot(fixture.largePath)?.querySelector("[data-line]")).not.toBeNull()
  })

  const boundaryTarget = visibleTop() + largeHeader.offsetHeight / 2
  diffPane.scrollTop += tailCard.getBoundingClientRect().top - boundaryTarget
  diffPane.dispatchEvent(new Event("scroll", { bubbles: true }))
  await vi.waitFor(() => {
    const largeHeaderRect = largeHeader.getBoundingClientRect()
    const tailHeaderRect = tailHeader.getBoundingClientRect()
    expect(largeHeaderRect.bottom).toBeLessThanOrEqual(largeCard.getBoundingClientRect().bottom + 1)
    expect(largeHeaderRect.bottom).toBeLessThanOrEqual(tailHeaderRect.top)
  })

  diffPane.scrollTop += tailCard.getBoundingClientRect().top - visibleTop()
  diffPane.dispatchEvent(new Event("scroll", { bubbles: true }))
  await vi.waitFor(() => {
    expect(Math.abs(tailHeader.getBoundingClientRect().top - visibleTop())).toBeLessThanOrEqual(1)
    expect(largeCard.getBoundingClientRect().bottom).toBeLessThanOrEqual(visibleTop())
  })
  expect(window.scrollY).toBe(0)
})

scenario("threadComposerShortcut", async () => {
  const fixture = makeLargeDiffFixture(3_000, 76, 20)
  const longThread = makeLongReviewThread(fixture)
  installDiffDashApi({
    pullRequestDetail: fixture.largeDetail,
    pullRequestDiff: fixture.largeDiff,
    reviewRequests: [fixture.largePullRequest],
    reviewThreadDetails: [
      ReviewThreadDetails.make({
        thread: longThread.thread,
        messages: longThread.messages.slice(0, 2),
      }),
    ],
    settings: AISettings.make({ ...DEFAULT_AI_SETTINGS, diffViewMode: "split" }),
  })
  renderApp({ strictMode: true })

  await openHostedReview(76)
  await showResponsiveDiffPane()
  await openOnlyReviewThreadInDiff(fixture.largePath, "R5")

  const textarea = await vi.waitFor(() => {
    const element = [
      ...document.querySelectorAll<HTMLTextAreaElement>(
        '[data-review-thread-annotation] textarea[aria-label="Thread message"]',
      ),
    ].find((candidate) => candidate.getBoundingClientRect().height > 0)
    expect(element).toBeDefined()
    return element!
  })
  await vi.waitFor(
    () => {
      const navigation = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
      expect(navigation?.dataset.reviewNavigationPhase).toBe("idle")
      expect(navigation?.dataset.reviewNavigationOutcome).toBe("completed::")
    },
    { timeout: 5_000 },
  )
  textarea.scrollIntoView({ block: "center" })
  textarea.focus()
  await vi.waitFor(() => expect(textarea.matches(":focus")).toBe(true))
  const diffPane = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
  expect(diffPane).not.toBeNull()
  if (diffPane === null) return
  diffPane.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 1 }))
  diffPane.scrollTop = diffPane.scrollHeight
  diffPane.dispatchEvent(new Event("scroll", { bubbles: true }))

  await vi.waitFor(() => expect(textarea.matches(":focus")).toBe(false))
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "v" }),
  )
  await vi.waitFor(() => expect(document.body.textContent).toContain("with shortcut v."))
})

scenario("reviewThreadSidebar", async () => {
  const previousRevisionPath = "src/features/thread-sidebar/components/extra-review-thread.ts"
  const paths = ["src/app.tsx", "docs/readme.md", previousRevisionPath, "pnpm-lock.yaml"] as const
  const summaryDiffText = paths
    .map(
      (path) => `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1 +1 @@
-old ${path}
+new ${path}`,
    )
    .join("\n")
  const parsed = parseUnifiedDiff(summaryDiffText)
  const docsFile = parsed.files.find((file) => file.path === "docs/readme.md")
  const extraFile = parsed.files.find((file) => file.path === previousRevisionPath)
  const lockFile = parsed.files.find((file) => file.path === "pnpm-lock.yaml")
  const appFile = parsed.files.find((file) => file.path === "src/app.tsx")
  const docsAnchor = docsFile === undefined ? null : lineReviewAnchor(docsFile, "additions", 1)
  const extraAnchor = extraFile === undefined ? null : lineReviewAnchor(extraFile, "additions", 1)
  const lockAnchor = lockFile === undefined ? null : lineReviewAnchor(lockFile, "additions", 1)
  const appAnchor = appFile === undefined ? null : lineReviewAnchor(appFile, "additions", 1)
  if (docsAnchor === null || extraAnchor === null || lockAnchor === null || appAnchor === null) {
    throw new Error("Expected summary review anchors")
  }
  const reviewThreadDetails = [
    makeReviewThreadDetails({ anchor: docsAnchor, id: "thread-summary-docs" }),
    makeReviewThreadDetails({ anchor: lockAnchor, id: "thread-summary-lock" }),
    makeReviewThreadDetails({
      anchor: extraAnchor,
      id: "thread-summary-previous-revision",
      previousRevision: true,
    }),
    makeReviewThreadDetails({
      anchor: appAnchor,
      id: "thread-summary-outdated",
      status: "outdated",
    }),
  ]
  const calls = installDiffDashApi({
    pullRequestDetail: HostedReviewDetail.make({
      ...detail,
      files: parsed.files.map((file) =>
        ChangedFile.make({
          additions: file.additions,
          changeType: file.status,
          deletions: file.deletions,
          path: file.path,
        }),
      ),
    }),
    pullRequestDiff: HostedReviewDiff.make({ ...diff, diff: summaryDiffText }),
    reviewThreadDetails,
  })
  renderApp()

  await openDefaultHostedReview()
  await showWideReviewLayout()
  const railButton = await vi.waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Threads"]')
    expect(button).not.toBeNull()
    return button!
  })
  const activityRail = document.querySelector<HTMLElement>("[data-review-activity-rail]")
  const treeActivity = document.querySelector<HTMLButtonElement>('button[aria-label="Files"]')
  const titlebar = document.querySelector<HTMLElement>("[data-workbench-titlebar]")
  const workbenchFrame = document.querySelector<HTMLElement>("[data-workbench-frame]")
  const reviewWorkspaceFrame = document.querySelector<HTMLElement>("[data-review-workspace-frame]")
  const workbenchContent = document.querySelector<HTMLElement>("[data-workbench-content]")
  const commandCenter = document.querySelector<HTMLButtonElement>("[data-workbench-command-center]")
  expect(activityRail).not.toBeNull()
  expect(treeActivity).not.toBeNull()
  expect(railButton.textContent).toBe("Threads")
  expect(titlebar).not.toBeNull()
  expect(workbenchFrame).not.toBeNull()
  expect(reviewWorkspaceFrame).not.toBeNull()
  expect(workbenchContent).not.toBeNull()
  expect(commandCenter?.textContent).toContain("fungsi/diffdash")
  if (
    activityRail === null ||
    treeActivity === null ||
    titlebar === null ||
    workbenchFrame === null ||
    reviewWorkspaceFrame === null ||
    workbenchContent === null ||
    commandCenter === null
  )
    return
  const titlebarRect = titlebar.getBoundingClientRect()
  const frameRect = workbenchFrame.getBoundingClientRect()
  const workspaceRect = reviewWorkspaceFrame.getBoundingClientRect()
  const contentRect = workbenchContent.getBoundingClientRect()
  const commandCenterRect = commandCenter.getBoundingClientRect()
  const backButton = titlebar.querySelector<HTMLButtonElement>('button[aria-label="Back"]')
  const reviewActions = titlebar.querySelector<HTMLButtonElement>(
    'button[aria-label="Review actions"]',
  )
  expect(backButton).not.toBeNull()
  expect(reviewActions).not.toBeNull()
  expect(reviewActions?.textContent).toBe("")
  expect(getComputedStyle(backButton!).getPropertyValue("-webkit-app-region")).toBe("no-drag")
  expect(getComputedStyle(commandCenter).getPropertyValue("-webkit-app-region")).toBe("no-drag")
  expect(getComputedStyle(reviewActions!).getPropertyValue("-webkit-app-region")).toBe("no-drag")
  expect(getComputedStyle(reviewActions!).borderTopWidth).toBe("0px")
  expect(titlebarRect.height).toBe(48)
  expect(titlebarRect.width).toBe(document.documentElement.getBoundingClientRect().width)
  expect(titlebarRect.bottom).toBe(contentRect.top)
  expect(frameRect.left).toBe(8)
  expect(frameRect.right).toBe(titlebarRect.right - 8)
  expect(contentRect.top).toBe(frameRect.top)
  expect(contentRect.right).toBe(frameRect.right)
  expect(contentRect.bottom).toBe(frameRect.bottom)
  expect(contentRect.left).toBe(frameRect.left)
  expect(workbenchFrame.dataset.workbenchFrameMode).toBe("project")
  expect(getComputedStyle(workbenchFrame).borderRadius).toBe("0px")
  expect(getComputedStyle(workbenchFrame).clipPath).toBe("none")
  expect(activityRail.getBoundingClientRect().top).toBe(contentRect.top)
  expect(activityRail.getBoundingClientRect().left).toBe(frameRect.left)
  expect(workspaceRect.top).toBe(contentRect.top)
  expect(workspaceRect.right).toBe(activityRail.parentElement?.getBoundingClientRect().right)
  expect(workspaceRect.bottom).toBe(contentRect.bottom)
  expect(workspaceRect.left).toBe(activityRail.getBoundingClientRect().right)
  expect(getComputedStyle(reviewWorkspaceFrame).borderRadius).toBe("12px")
  expect(getComputedStyle(reviewWorkspaceFrame).clipPath).toBe("inset(0px round 12px)")
  expect(Math.round(commandCenterRect.left + commandCenterRect.width / 2)).toBe(
    Math.round(titlebarRect.left + titlebarRect.width / 2),
  )
  expect(backButton!.getBoundingClientRect().right).toBeLessThanOrEqual(commandCenterRect.left)
  expect(reviewActions!.getBoundingClientRect().left).toBeGreaterThanOrEqual(
    commandCenterRect.right,
  )
  expect(activityRail?.getBoundingClientRect().height).toBe(
    activityRail?.parentElement?.getBoundingClientRect().height,
  )
  expect(activityRail?.getBoundingClientRect().width).toBe(52)
  expect(treeActivity?.getBoundingClientRect().width).toBe(40)
  expect(getComputedStyle(treeActivity).cursor).toBe("pointer")
  expect(treeActivity?.querySelector("svg")?.getBoundingClientRect().width).toBe(24)
  expect(activityRail.querySelector('button[aria-label="Back"]')).toBeNull()
  commandCenter.focus()
  commandCenter.click()
  await vi.waitFor(() => {
    const dialog = document.querySelector<HTMLDialogElement>('dialog[aria-label="Go anywhere"]')
    expect(dialog).not.toBeNull()
    expect(
      dialog?.querySelector<HTMLInputElement>('input[placeholder="Search files"]'),
    ).not.toBeNull()
  })
  window.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
  )
  await vi.waitFor(() => {
    expect(document.querySelector('dialog[aria-label="Go anywhere"]')).toBeNull()
    expect(document.activeElement).toBe(commandCenter)
  })
  expect(document.querySelector("[data-review-context-panel]")).not.toBeNull()
  expect(treeActivity.getAttribute("aria-pressed")).toBe("true")
  expect(treeActivity.getAttribute("aria-expanded")).toBe("true")
  expect(treeActivity.className).toContain("text-primary")
  expect(treeActivity.className).not.toContain("bg-shell-activity-rail-active")
  treeActivity.focus()
  treeActivity.click()
  await vi.waitFor(() => {
    expect(document.querySelector("[data-review-context-panel]")).toBeNull()
    expect(treeActivity.getAttribute("aria-pressed")).toBe("true")
    expect(treeActivity.getAttribute("aria-expanded")).toBe("false")
    expect(document.activeElement).toBe(treeActivity)
    expect(
      document
        .querySelector<HTMLElement>("[data-review-diff-scroll-container]")
        ?.getBoundingClientRect().left,
    ).toBe(reviewWorkspaceFrame.getBoundingClientRect().left)
  })
  treeActivity.click()
  await vi.waitFor(() =>
    expect(document.querySelector("[data-review-context-panel]")).not.toBeNull(),
  )
  const collapseSidebar = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Collapse sidebar"]',
  )
  expect(collapseSidebar).not.toBeNull()
  expect(titlebar.contains(collapseSidebar)).toBe(true)
  expect(document.querySelector("[data-review-context-header]")?.textContent).toContain("Files")
  expect(document.querySelector("[data-review-context-header]")?.textContent).not.toContain(
    "fungsi/diffdash",
  )
  collapseSidebar?.focus()
  collapseSidebar?.click()
  await vi.waitFor(() => expect(document.querySelector("[data-review-context-panel]")).toBeNull())
  const expandSidebar = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Expand sidebar"]',
  )
  expect(expandSidebar).not.toBeNull()
  expect(document.activeElement).toBe(expandSidebar)
  expandSidebar?.click()
  const filterInput = await vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Filter files"]')
    expect(input).not.toBeNull()
    return input!
  })
  const contextPanel = document.querySelector<HTMLElement>("[data-review-context-panel]")
  expect(contextPanel).not.toBeNull()
  if (contextPanel === null) return
  expect(getComputedStyle(activityRail).backgroundColor).not.toBe(
    getComputedStyle(contextPanel).backgroundColor,
  )
  expect(getComputedStyle(titlebar).backgroundColor).not.toBe(
    getComputedStyle(contextPanel).backgroundColor,
  )
  expect(getComputedStyle(activityRail).backgroundColor).toBe(
    getComputedStyle(workbenchFrame).backgroundColor,
  )
  expect(getComputedStyle(titlebar).backgroundColor).toBe(
    getComputedStyle(activityRail).backgroundColor,
  )
  expect(getComputedStyle(activityRail).borderRightWidth).toBe("0px")
  expect(getComputedStyle(contextPanel).borderRightWidth).toBe("0px")
  expect(getComputedStyle(activityRail).boxShadow).toBe("none")
  expect(getComputedStyle(contextPanel).boxShadow).toBe("none")

  const resizer = document.querySelector<HTMLElement>("[data-review-sidebar-resizer]")
  expect(resizer).not.toBeNull()
  if (resizer !== null) {
    const initialWidth = contextPanel.getBoundingClientRect().width
    resizer.focus()
    resizer.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowRight" }),
    )
    await vi.waitFor(() =>
      expect(contextPanel.getBoundingClientRect().width).toBeGreaterThan(initialWidth),
    )
    await vi.waitFor(() =>
      expect(calls.updateSettings.mock.calls.at(-1)?.[0].layout.review.contextWidth).toBe(
        Math.round(contextPanel.getBoundingClientRect().width),
      ),
    )
    resizer.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    await vi.waitFor(() => expect(contextPanel.getBoundingClientRect().width).toBe(304))
  }
  setInputValue(filterInput, "app")
  filterInput.dispatchEvent(new Event("input", { bubbles: true }))
  await vi.waitFor(() => expect(getDiffCardPaths()).toEqual(["src/app.tsx"]))

  expect(document.querySelector("[data-review-thread-list]")).toBeNull()
  railButton.click()
  const threadList = await vi.waitFor(() => {
    const element = document.querySelector<HTMLElement>("[data-review-thread-list]")
    expect(element?.textContent).not.toContain("4 threads")
    expect(element?.querySelector('button[aria-label="Agent settings"]')).not.toBeNull()
    expect(document.querySelector("[data-review-thread-detail]")).toBeNull()
    const rootRect = element?.parentElement?.getBoundingClientRect()
    const listRect = element?.getBoundingClientRect()
    expect(listRect?.top).toBe(rootRect?.top)
    expect(listRect?.bottom).toBe(rootRect?.bottom)
    expect(getComputedStyle(element!).borderRightWidth).toBe("0px")
    expect(getComputedStyle(element!).boxShadow).toBe("none")
    expect(
      element?.querySelector<HTMLButtonElement>('button[aria-label="Collapse sidebar"]'),
    ).toBeNull()
    expect(titlebar.querySelector('button[aria-label="Collapse sidebar"]')).not.toBeNull()
    return element!
  })
  const diffControl = document.querySelector<HTMLButtonElement>(
    '[data-diff-card-path="src/app.tsx"] button[aria-label="Collapse diff"]',
  )
  diffControl?.focus()
  expect(document.activeElement).toBe(diffControl)

  const previousRevisionButton = threadList.querySelector<HTMLButtonElement>(
    `button[aria-label="Open thread details for ${previousRevisionPath} R1"]`,
  )
  const previousRevisionRow = previousRevisionButton?.closest("[data-review-thread-list-item]")
  const previousRevisionPathText = previousRevisionRow?.querySelector<HTMLElement>(
    `[aria-label="${previousRevisionPath}"]`,
  )
  const previousRevisionLineLabel = previousRevisionRow?.querySelector<HTMLElement>(
    "[data-review-thread-line-label]",
  )
  const lockThreadButton = threadList.querySelector<HTMLButtonElement>(
    'button[aria-label="Open thread details for pnpm-lock.yaml R1"]',
  )
  expect(previousRevisionButton).not.toBeNull()
  expect(lockThreadButton).not.toBeNull()
  expect(previousRevisionRow?.textContent).toContain("Previous revision")
  expect(previousRevisionLineLabel?.textContent).toBe("R1")
  expect(previousRevisionPathText?.children).toHaveLength(2)
  expect(getComputedStyle(previousRevisionPathText!).overflowX).toBe("hidden")
  expect(getComputedStyle(previousRevisionRow!).borderBottomWidth).toBe("1px")
  expect(previousRevisionRow?.querySelector(".lucide-move-right")).toBeNull()
  previousRevisionButton?.click()
  const previousRevisionDetail = await vi.waitFor(() => {
    const selectedDetailElement = document.querySelector<HTMLElement>("[data-review-thread-detail]")
    expect(selectedDetailElement?.textContent).toContain("Previous revision")
    expect(
      selectedDetailElement?.querySelector('button[aria-label="Go to thread in diff"]'),
    ).not.toBeNull()
    expect(
      selectedDetailElement?.querySelector('button[aria-label="Go to thread in diff"]')
        ?.textContent,
    ).toBe("go to diff")
    expect(selectedDetailElement?.querySelector(".lucide-move-right")).toBeNull()
    return selectedDetailElement!
  })
  lockThreadButton?.click()
  const lockDetail = await vi.waitFor(() => {
    const element = document.querySelector<HTMLElement>("[data-review-thread-detail]")
    expect(element).toBe(previousRevisionDetail)
    expect(element?.tagName).toBe("ASIDE")
    expect(element?.getAttribute("aria-label")).toBe("Thread details")
    expect(element?.textContent).toContain("pnpm-lock.yaml")
    expect(element?.textContent).not.toContain(previousRevisionPath)
    expect(document.querySelector("[data-review-thread-list]")).not.toBeNull()
    expect(lockThreadButton?.getAttribute("aria-current")).toBe("true")
    expect(previousRevisionButton?.getAttribute("aria-current")).toBeNull()
    const listRect = threadList.getBoundingClientRect()
    const detailRect = element?.getBoundingClientRect()
    expect(detailRect?.left).toBe(listRect.right)
    expect(detailRect?.top).toBe(listRect.top)
    expect(detailRect?.bottom).toBe(listRect.bottom)
    expect(getComputedStyle(element!).borderRightWidth).toBe("0px")
    expect(getComputedStyle(element!).boxShadow).toBe("none")
    return element!
  })
  const detailResizer = document.querySelector<HTMLElement>("[data-review-thread-detail-resizer]")
  expect(detailResizer).not.toBeNull()
  if (detailResizer !== null) {
    const initialDetailWidth = lockDetail.getBoundingClientRect().width
    detailResizer.focus()
    detailResizer.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowLeft" }),
    )
    await vi.waitFor(() =>
      expect(lockDetail.getBoundingClientRect().width).toBeLessThan(initialDetailWidth),
    )
    await vi.waitFor(() =>
      expect(calls.updateSettings.mock.calls.at(-1)?.[0].layout.review.threadDetailWidth).toBe(
        Math.round(lockDetail.getBoundingClientRect().width),
      ),
    )
    detailResizer.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    await vi.waitFor(() =>
      expect(calls.updateSettings.mock.calls.at(-1)?.[0].layout.review.threadDetailWidth).toBe(432),
    )
  }

  const reviewLayout = document.querySelector<HTMLElement>("[data-review-layout]")
  expect(reviewLayout).not.toBeNull()
  if (reviewLayout !== null) {
    reviewLayout.style.width = "950px"
    await vi.waitFor(() => {
      expect(reviewLayout.dataset.reviewPaneMode).toBe("compact")
      expect(threadList.parentElement?.getAttribute("aria-hidden")).toBe("true")
      expect(lockDetail.parentElement?.getAttribute("aria-hidden")).toBe("false")
      expect(
        document
          .querySelector<HTMLElement>("[data-review-diff-scroll-container]")
          ?.closest("[aria-hidden]")
          ?.getAttribute("aria-hidden"),
      ).toBe("false")
      expect(
        document
          .querySelector<HTMLElement>("[data-review-activity-rail]")
          ?.getAttribute("data-review-activity-placement"),
      ).toBe("rail")
      expect(reviewWorkspaceFrame.getBoundingClientRect().left).toBe(
        document.querySelector<HTMLElement>("[data-review-activity-rail]")?.getBoundingClientRect()
          .right,
      )
    })

    reviewLayout.style.width = "800px"
    await vi.waitFor(() => {
      expect(reviewLayout.dataset.reviewPaneMode).toBe("single")
      expect(lockDetail.parentElement?.getAttribute("aria-hidden")).toBe("false")
      expect(
        document
          .querySelector<HTMLElement>("[data-review-diff-scroll-container]")
          ?.closest("[aria-hidden]")
          ?.getAttribute("aria-hidden"),
      ).toBe("true")
      expect(
        document
          .querySelector<HTMLElement>("[data-review-activity-rail]")
          ?.getAttribute("data-review-activity-placement"),
      ).toBe("bottom")
      const bottomRail = document.querySelector<HTMLElement>("[data-review-activity-rail]")
      expect(reviewWorkspaceFrame.getBoundingClientRect().bottom).toBe(
        bottomRail?.getBoundingClientRect().top,
      )
      expect(getComputedStyle(bottomRail!).borderTopWidth).toBe("0px")
    })

    document.querySelector<HTMLButtonElement>('button[aria-label="Threads"]')?.click()
    await vi.waitFor(() => {
      expect(lockDetail.parentElement?.getAttribute("aria-hidden")).toBe("true")
      expect(
        document
          .querySelector<HTMLElement>("[data-review-diff-scroll-container]")
          ?.closest("[aria-hidden]")
          ?.getAttribute("aria-hidden"),
      ).toBe("false")
    })

    reviewLayout.style.width = "1400px"
    await vi.waitFor(() => {
      expect(reviewLayout.dataset.reviewPaneMode).toBe("wide")
      expect(threadList.parentElement?.getAttribute("aria-hidden")).toBe("false")
      expect(lockDetail.parentElement?.getAttribute("aria-hidden")).toBe("false")
      expect(Math.round(lockDetail.getBoundingClientRect().width)).toBe(432)
    })
  }
  const closeLockDetail = lockDetail.querySelector<HTMLButtonElement>(
    'button[aria-label="Close thread details"]',
  )
  expect(closeLockDetail).not.toBeNull()
  closeLockDetail?.focus()
  await vi.waitFor(() => expect(lockDetail.contains(document.activeElement)).toBe(true))
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
  )
  await vi.waitFor(() => {
    expect(document.querySelector("[data-review-thread-detail]")).toBeNull()
    expect(document.querySelector("[data-review-thread-list]")).not.toBeNull()
    expect(document.activeElement).toBe(lockThreadButton)
  })

  lockThreadButton?.click()
  const goToLockDiff = await vi.waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>(
      '[data-review-thread-detail] button[aria-label="Go to thread in diff"]',
    )
    expect(button).not.toBeNull()
    return button!
  })
  goToLockDiff.click()
  await vi.waitFor(
    () => {
      expect(
        document.querySelector<HTMLInputElement>('input[placeholder="Filter files"]')?.value,
      ).toBe("app")
      expect(getDiffCardPaths()).toContain("pnpm-lock.yaml")
      expect(document.querySelector('[data-review-thread-id="thread-summary-lock"]')).not.toBeNull()
      const composer = document.querySelector<HTMLTextAreaElement>(
        '[data-review-thread-id="thread-summary-lock"] textarea[aria-label="Thread message"]',
      )
      expect(composer).not.toBeNull()
      expect(document.activeElement).toBe(composer)
      expect(
        document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")?.dataset
          .reviewNavigationOutcome,
      ).toBe("completed::")
      expect(
        document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")?.dataset
          .reviewNavigationPhase,
      ).toBe("idle")
      const lockShadowRoot = getDiffShadowRoot("pnpm-lock.yaml")
      const lockLine =
        lockShadowRoot === null ? undefined : getDiffLine(lockShadowRoot, "new pnpm-lock.yaml")
      const diffPane = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
      expect(lockLine).not.toBeNull()
      expect(diffPane).not.toBeNull()
      expect(lockLine!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        diffPane!.getBoundingClientRect().top,
      )
      expect(document.querySelector("[data-review-thread-list]")).toBeNull()
      expect(
        document.querySelector('[data-diff-card-path="pnpm-lock.yaml"] [data-diff-card-body]'),
      ).not.toBeNull()
    },
    { timeout: 10_000 },
  )
  expect(
    calls.getReviewSnapshotPage.mock.calls.some(([request]) =>
      request.fileIds.includes(lockAnchor.fileId),
    ),
  ).toBe(true)

  const preservedFilterInput = document.querySelector<HTMLInputElement>(
    'input[placeholder="Filter files"]',
  )
  expect(preservedFilterInput?.value).toBe("app")
  if (preservedFilterInput !== null) {
    setInputValue(preservedFilterInput, "")
    preservedFilterInput.dispatchEvent(new Event("input", { bubbles: true }))
  }
  const docsViewed = await vi.waitFor(() => {
    const checkbox = getViewedCheckbox("docs/readme.md")
    expect(checkbox).not.toBeNull()
    return checkbox!
  })
  docsViewed?.click()
  await vi.waitFor(() => expect(getDiffShadowRoot("docs/readme.md")).toBeNull())
  const restoredFilterInput = document.querySelector<HTMLInputElement>(
    'input[placeholder="Filter files"]',
  )
  expect(restoredFilterInput).not.toBeNull()
  if (restoredFilterInput !== null) {
    setInputValue(restoredFilterInput, "app")
    restoredFilterInput.dispatchEvent(new Event("input", { bubbles: true }))
  }
  document.querySelector<HTMLButtonElement>('button[aria-label="Threads"]')?.click()
  const docsThreadButton = await vi.waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Open thread details for docs/readme.md R1"]',
    )
    expect(button).not.toBeNull()
    return button!
  })
  docsThreadButton.click()
  const docsGoToDiff = await vi.waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>(
      '[data-review-thread-detail] button[aria-label="Go to thread in diff"]',
    )
    expect(button).not.toBeNull()
    return button!
  })
  docsGoToDiff.click()
  await vi.waitFor(
    () => {
      expect(
        document.querySelector<HTMLInputElement>('input[placeholder="Filter files"]')?.value,
      ).toBe("app")
      expect(getViewedCheckbox("docs/readme.md")?.checked).toBe(true)
      expect(getDiffShadowRoot("docs/readme.md")).not.toBeNull()
      expect(document.querySelector('[data-review-thread-id="thread-summary-docs"]')).not.toBeNull()
      expect(
        document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")?.dataset
          .reviewNavigationOutcome,
      ).toBe("completed::")
      expect(
        document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")?.dataset
          .reviewNavigationPhase,
      ).toBe("idle")
    },
    { timeout: 10_000 },
  )

  document.querySelector<HTMLButtonElement>('button[aria-label="Threads"]')?.click()
  const outdatedButton = await vi.waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Open thread details for src/app.tsx R1"]',
    )
    expect(button).not.toBeNull()
    return button!
  })
  outdatedButton.click()
  await vi.waitFor(() => {
    const outdatedDetail = document.querySelector<HTMLElement>("[data-review-thread-detail]")
    expect(outdatedDetail?.textContent).toContain("Response for src/app.tsx")
    expect(outdatedDetail?.textContent).toContain("Outdated")
    expect(
      outdatedDetail?.querySelector<HTMLButtonElement>('button[aria-label="Go to thread in diff"]'),
    ).toBeNull()
  })
  document
    .querySelector<HTMLButtonElement>(
      '[data-review-thread-detail] button[aria-label="Close thread details"]',
    )
    ?.click()

  const currentLockThreadButton = await vi.waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Open thread details for pnpm-lock.yaml R1"]',
    )
    expect(button).not.toBeNull()
    return button!
  })
  currentLockThreadButton.click()
  const lockGoToDiff = await vi.waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>(
      '[data-review-thread-detail] button[aria-label="Go to thread in diff"]',
    )
    expect(button).not.toBeNull()
    return button!
  })
  expect(lockGoToDiff.textContent).toBe("go to diff")
  expect(lockGoToDiff.querySelector(".lucide-move-right")).toBeNull()
  lockGoToDiff.click()
  const inlineOpenDetail = await vi.waitFor(
    () => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-diff-card-path="pnpm-lock.yaml"] [data-review-thread-annotation] button[aria-label="Open R1 thread details"]',
      )
      expect(button).not.toBeNull()
      expect(
        document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")?.dataset
          .reviewNavigationPhase,
      ).toBe("idle")
      return button!
    },
    { timeout: 10_000 },
  )
  inlineOpenDetail.click()
  await vi.waitFor(() => {
    expect(document.querySelector("[data-review-thread-list]")).not.toBeNull()
    expect(document.querySelector("[data-review-thread-detail]")?.textContent).toContain(
      "pnpm-lock.yaml",
    )
  })
  document
    .querySelector<HTMLButtonElement>(
      '[data-review-thread-detail] button[aria-label="Close thread details"]',
    )
    ?.click()
  await vi.waitFor(() => expect(document.querySelector("[data-review-thread-detail]")).toBeNull())
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
  )
  await vi.waitFor(() => {
    const collapsedRailButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Threads"]',
    )
    expect(document.querySelector("[data-review-thread-list]")).toBeNull()
    expect(document.activeElement).toBe(collapsedRailButton)
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

  await openHostedReview(58)
  await showResponsiveDiffPane()
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
      const navigation = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
      expect(
        `${navigation?.dataset.reviewNavigationPhase}|${navigation?.dataset.reviewNavigationOutcome}`,
      ).toBe("idle|completed::")
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

scenario("multiFileSearchWrap", async () => {
  const fixture = makeManyFileDiffFixture()
  installDiffDashApi({
    pullRequestDetail: fixture.manyDetail,
    pullRequestDiff: fixture.manyDiff,
    reviewRequests: [fixture.manyPullRequest],
  })
  renderApp({ strictMode: true })

  await openHostedReview(58)
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
      () => expect(getDiffShadowRoot(path)?.querySelector("[data-line]")).not.toBeNull(),
      { timeout: 20_000 },
    )
  }

  const wrapTargetPath = fixture.paths[0] ?? ""
  const anchorPath = fixture.paths[7] ?? ""
  expect(wrapTargetPath).not.toBe("")
  expect(anchorPath).not.toBe("")
  await visitFile(wrapTargetPath)
  await visitFile(anchorPath)
  await vi.waitFor(
    () =>
      expect(getDiffShadowRoot(wrapTargetPath)?.querySelector("[data-placeholder]")).not.toBeNull(),
    { timeout: 20_000 },
  )

  dispatchKeyboardShortcut("f", { metaKey: true })
  const searchInput = await vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>("[data-review-search-input]")
    expect(input).not.toBeNull()
    return input!
  })
  setInputValue(searchInput, "SEARCH_WRAP_MATCH")
  searchInput.dispatchEvent(new Event("input", { bubbles: true }))
  await vi.waitFor(
    () => {
      expect(document.querySelector("[data-review-search-toolbar]")?.textContent).toContain(
        "1 / 168",
      )
      expect(getDiffShadowRoot(anchorPath)?.contains(getActiveHighlightLine())).toBe(true)
    },
    { timeout: 20_000 },
  )

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
        "168 / 168",
      )
      const activeLine = getActiveHighlightLine()
      const targetRoot = getDiffShadowRoot(wrapTargetPath)
      const targetHeader = document.querySelector<HTMLElement>(
        `[data-diff-card-path="${wrapTargetPath}"] [data-diff-card-header]`,
      )
      const diffPane = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
      const stickyChrome = document.querySelector<HTMLElement>("[data-review-sticky-chrome]")
      expect(activeLine?.getAttribute("data-line")).toBe("21")
      expect(targetRoot?.contains(activeLine ?? null)).toBe(true)
      expect(targetRoot?.querySelector("[data-placeholder]")).toBeNull()
      expect(diffPane).not.toBeNull()
      expect(stickyChrome).not.toBeNull()
      expect(targetHeader).not.toBeNull()
      if (
        activeLine === null ||
        diffPane === null ||
        stickyChrome === null ||
        targetHeader === null
      ) {
        return
      }
      const activeRect = activeLine.getBoundingClientRect()
      const paneRect = diffPane.getBoundingClientRect()
      expect(activeRect.bottom).toBeGreaterThan(
        paneRect.top + stickyChrome.offsetHeight + targetHeader.offsetHeight,
      )
      expect(activeRect.top).toBeLessThan(paneRect.bottom)
      expect(getMountedDiffLineCount()).toBeLessThan(1_500)
    },
    { timeout: 20_000 },
  )
})

scenario("snapshotPageResidency", async () => {
  const fixture = makeCachePressureDiffFixture()
  const api = installDiffDashApi({
    pullRequestDetail: fixture.cacheDetail,
    pullRequestDiff: fixture.cacheDiff,
    reviewRequests: [fixture.cachePullRequest],
    snapshotPageFileLimit: 1,
  })
  renderApp({ strictMode: true })

  await openHostedReview(59)
  await vi.waitFor(() => expect(getDiffCardPaths()).toHaveLength(fixture.paths.length))
  await vi.waitFor(
    () => {
      fixture.paths.slice(0, 3).forEach((path) => {
        expect(getDiffShadowRoot(path)).not.toBeNull()
      })
    },
    { timeout: 20_000 },
  )
  expect(api.getReviewSnapshotPage.mock.calls.some(([request]) => request.cursor !== null)).toBe(
    true,
  )

  dispatchKeyboardShortcut("f", { metaKey: true })
  const searchInput = await vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>("[data-review-search-input]")
    expect(input).not.toBeNull()
    return input!
  })
  setInputValue(searchInput, "CACHE_PIN_MATCH")
  searchInput.dispatchEvent(new Event("input", { bubbles: true }))
  const activePath = fixture.paths[0] ?? ""
  await vi.waitFor(
    () => {
      expect(document.querySelector("[data-review-search-toolbar]")?.textContent).toContain("1 / 1")
      expect(getDiffShadowRoot(activePath)?.contains(getActiveHighlightLine())).toBe(true)
    },
    { timeout: 20_000 },
  )

  const selectedPath = fixture.paths[1] ?? ""
  const selectedTreeItem = getChangedFilesTreeItem(selectedPath)
  expect(selectedTreeItem).not.toBeNull()
  selectedTreeItem?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }))
  await vi.waitFor(() => {
    expect(getSelectedChangedFileTreeItems()[0]?.getAttribute("data-item-path")).toBe(selectedPath)
    expect(selectedPath).not.toBe(activePath)
  })

  const diffPane = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
  expect(diffPane).not.toBeNull()
  if (diffPane === null) return
  diffPane.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 1 }))
  for (const path of fixture.paths.slice(3)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential navigation intentionally crosses the cache residency bound.
    await vi.waitFor(
      () => {
        const card = document.querySelector<HTMLElement>(`[data-diff-card-path="${path}"]`)
        expect(card).not.toBeNull()
        if (card === null) return
        const paneRect = diffPane.getBoundingClientRect()
        const cardRect = card.getBoundingClientRect()
        diffPane.scrollTop += cardRect.top - paneRect.top
        diffPane.dispatchEvent(new Event("scroll", { bubbles: true }))
        if (getDiffShadowRoot(path) === null) throw new Error(`Queued diff did not load: ${path}`)
      },
      { timeout: 20_000 },
    )
  }

  await vi.waitFor(() => {
    const activeCard = document.querySelector<HTMLElement>(`[data-diff-card-path="${activePath}"]`)
    expect(activeCard?.querySelector("diffs-container")).not.toBeNull()
    expect(activeCard?.textContent).not.toContain("Queued")
  })
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

  await openDefaultHostedReview()
  await vi.waitFor(() => {
    expect(getDiffShadowRoot("src/app.tsx")?.querySelector("[data-unified]")).not.toBeNull()
  })
  await waitForAnimationFrames(4)

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

scenario("diffSearchLatestWork", async () => {
  const oldWait = makeBrowserWait()
  const closingWait = makeBrowserWait()
  const api = installDiffDashApi({
    beforeReviewSnapshotSearch: async (request) => {
      if (request.query === "old") await oldWait.promise
      if (request.query === "lock new") await closingWait.promise
    },
  })
  renderApp()

  await openDefaultHostedReview()
  await vi.waitFor(() => {
    expect(getDiffShadowRoot("src/app.tsx")?.querySelector("[data-unified]")).not.toBeNull()
  })
  await waitForAnimationFrames(4)

  dispatchKeyboardShortcut("f", { metaKey: true })
  const searchInput = await vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>("[data-review-search-input]")
    expect(input).not.toBeNull()
    if (input === null) throw new Error("Missing review search input")
    return input
  })
  setInputValue(searchInput, "old")
  searchInput.dispatchEvent(new Event("input", { bubbles: true }))
  await vi.waitFor(() => {
    expect(api.searchReviewSnapshot.mock.calls.some(([request]) => request.query === "old")).toBe(
      true,
    )
  })

  setInputValue(searchInput, "docs update")
  searchInput.dispatchEvent(new Event("input", { bubbles: true }))
  await vi.waitFor(() => {
    expect(document.querySelector("[data-review-search-toolbar]")?.textContent).toContain("1 / 1")
    expect(getHighlightTexts(REVIEW_SEARCH_ACTIVE_HIGHLIGHT)).toEqual(["docs update"])
  })
  oldWait.release()
  await waitForAnimationFrames(2)
  expect(searchInput.value).toBe("docs update")
  expect(getHighlightTexts(REVIEW_SEARCH_ACTIVE_HIGHLIGHT)).toEqual(["docs update"])

  setInputValue(searchInput, "lock new")
  searchInput.dispatchEvent(new Event("input", { bubbles: true }))
  await vi.waitFor(() => {
    expect(
      api.searchReviewSnapshot.mock.calls.some(([request]) => request.query === "lock new"),
    ).toBe(true)
  })
  dispatchKeyboardShortcut("Escape")
  await vi.waitFor(() => {
    expect(document.querySelector("[data-review-search-toolbar]")).toBeNull()
  })
  closingWait.release()
  await waitForAnimationFrames(2)

  expect(CSS.highlights.has(REVIEW_SEARCH_ACTIVE_HIGHLIGHT)).toBe(false)
  expect(CSS.highlights.has(REVIEW_SEARCH_MATCH_HIGHLIGHT)).toBe(false)
  expect(getDiffCardPaths()).not.toContain("pnpm-lock.yaml")
})

scenario("diffSearchViewportAnchor", async () => {
  const fillerLines = Array.from({ length: 80 }, (_, index) => `+const filler${index} = true`).join(
    "\n",
  )
  const docsFillerLines = Array.from(
    { length: 40 },
    (_, index) => `+docs filler line ${index + 1}`,
  ).join("\n")
  const lockFileStart = diff.diff.indexOf("diff --git a/pnpm-lock.yaml")
  installDiffDashApi({
    pullRequestDetail: HostedReviewDetail.make({
      ...detail,
      files: detail.files.filter((file) => file.path !== "pnpm-lock.yaml"),
    }),
    pullRequestDiff: HostedReviewDiff.make({
      ...diff,
      diff: diff.diff
        .slice(0, lockFileStart)
        .replace(
          "@@ -1,1 +1,1 @@\n-old\n+new",
          `@@ -1,1 +1,81 @@\n-shared app old\n+shared app new\n${fillerLines}`,
        )
        .replace(
          "@@ -1,1 +1,1 @@\n-docs\n+docs update",
          `@@ -1,1 +1,41 @@\n-shared docs old\n+shared docs update\n${docsFillerLines}`,
        )
        .replace("-lock old\n+lock new", "-shared lock old\n+shared lock new"),
    }),
    settings: AISettings.make({ ...DEFAULT_AI_SETTINGS, diffViewMode: "split" }),
  })
  renderApp()

  await openDefaultHostedReview()
  await showResponsiveDiffPane()
  const docsCard = await vi.waitFor(() => {
    const card = document.querySelector<HTMLElement>('[data-diff-card-path="docs/readme.md"]')
    expect(getDiffShadowRoot("docs/readme.md")).not.toBeNull()
    expect(card).not.toBeNull()
    return card!
  })
  const diffPane = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
  const stickyChrome = document.querySelector<HTMLElement>("[data-review-sticky-chrome]")
  const appCard = document.querySelector<HTMLElement>('[data-diff-card-path="src/app.tsx"]')
  expect(diffPane).not.toBeNull()
  expect(stickyChrome).not.toBeNull()
  expect(appCard).not.toBeNull()
  if (diffPane === null || stickyChrome === null || appCard === null) return

  appCard.querySelector<HTMLButtonElement>('button[aria-label="Collapse diff"]')?.click()
  await vi.waitFor(() => expect(getDiffShadowRoot("src/app.tsx")).toBeNull())
  getChangedFilesTreeItem("docs/readme.md")?.dispatchEvent(
    new MouseEvent("click", { bubbles: true, composed: true }),
  )
  await alignReviewCardAtVisibleTop("docs/readme.md")
  const visibleTop = diffPane.getBoundingClientRect().top + stickyChrome.offsetHeight
  expect(appCard.getBoundingClientRect().bottom).toBeLessThanOrEqual(visibleTop)
  expect(docsCard.getBoundingClientRect().top).toBeLessThanOrEqual(visibleTop + 1)

  dispatchKeyboardShortcut("f", { metaKey: true })
  const searchInput = await vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>("[data-review-search-input]")
    expect(input).not.toBeNull()
    return input!
  })
  setInputValue(searchInput, "shared")
  searchInput.dispatchEvent(new Event("input", { bubbles: true }))

  await vi.waitFor(() => {
    expect(document.querySelector("[data-review-search-toolbar]")?.textContent).toContain("1 / 4")
    expect(getDiffShadowRoot("docs/readme.md")?.contains(getActiveHighlightLine())).toBe(true)
    expect(getActiveHighlightLine()?.textContent).toContain("shared docs")
  })

  searchInput.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
  )
  await vi.waitFor(() => {
    expect(document.querySelector("[data-review-search-toolbar]")?.textContent).toContain("2 / 4")
    expect(getDiffShadowRoot("docs/readme.md")?.contains(getActiveHighlightLine())).toBe(true)
  })
  searchInput.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
  )
  await vi.waitFor(() => {
    expect(document.querySelector("[data-review-search-toolbar]")?.textContent).toContain("3 / 4")
    expect(getDiffShadowRoot("src/app.tsx")?.contains(getActiveHighlightLine())).toBe(true)
  })
})

scenario("diffSearchImmutableAnchor", async () => {
  const appMatches = Array.from({ length: 205 }, (_, index) => `+needle result ${index + 1}`).join(
    "\n",
  )
  const docsFillerLines = Array.from(
    { length: 40 },
    (_, index) => `+docs filler line ${index + 1}`,
  ).join("\n")
  const searchDiffText = `diff --git a/src/app.tsx b/src/app.tsx
--- a/src/app.tsx
+++ b/src/app.tsx
@@ -1 +1,205 @@
-old app
${appMatches}
diff --git a/docs/readme.md b/docs/readme.md
--- a/docs/readme.md
+++ b/docs/readme.md
@@ -1 +1,41 @@
-old docs
+needle docs result
${docsFillerLines}`
  const parsed = parseUnifiedDiff(searchDiffText)
  const calls = installDiffDashApi({
    pullRequestDetail: HostedReviewDetail.make({
      ...detail,
      files: parsed.files.map((file) =>
        ChangedFile.make({
          additions: file.additions,
          changeType: file.status,
          deletions: file.deletions,
          path: file.path,
        }),
      ),
    }),
    pullRequestDiff: HostedReviewDiff.make({ ...diff, diff: searchDiffText }),
    settings: AISettings.make({ ...DEFAULT_AI_SETTINGS, diffViewMode: "split" }),
  })
  renderApp()

  await openDefaultHostedReview()
  await showResponsiveDiffPane()
  const appCard = await vi.waitFor(() => {
    const card = document.querySelector<HTMLElement>('[data-diff-card-path="src/app.tsx"]')
    expect(card).not.toBeNull()
    return card!
  })
  appCard.querySelector<HTMLButtonElement>('button[aria-label="Collapse diff"]')?.click()
  await vi.waitFor(() => expect(getDiffShadowRoot("src/app.tsx")).toBeNull())
  const docsTreeItem = await vi.waitFor(() => {
    const item = getChangedFilesTreeItem("docs/readme.md")
    expect(item).not.toBeNull()
    return item!
  })
  docsTreeItem.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }))
  await vi.waitFor(() => {
    expect(getSelectedChangedFileTreeItems()[0]?.getAttribute("data-item-path")).toBe(
      "docs/readme.md",
    )
  })
  await alignReviewCardAtVisibleTop("docs/readme.md")

  dispatchKeyboardShortcut("f", { metaKey: true })
  const searchInput = await vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>("[data-review-search-input]")
    expect(input).not.toBeNull()
    return input!
  })
  setInputValue(searchInput, "needle")
  searchInput.dispatchEvent(new Event("input", { bubbles: true }))
  await vi.waitFor(() => {
    expect(document.querySelector("[data-review-search-toolbar]")?.textContent).toContain("1 / 206")
    expect(getDiffShadowRoot("docs/readme.md")?.contains(getActiveHighlightLine())).toBe(true)
  })
  const firstRequest = calls.searchReviewSnapshot.mock.calls[0]?.[0]
  expect(firstRequest?.anchor?.fileId).toBe(parsed.files[1]?.fileId)

  const appTreeItem = getChangedFilesTreeItem("src/app.tsx")
  expect(appTreeItem).not.toBeNull()
  appTreeItem?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }))
  await vi.waitFor(() => {
    expect(getSelectedChangedFileTreeItems()[0]?.getAttribute("data-item-path")).toBe("src/app.tsx")
  })
  await alignReviewCardAtVisibleTop("src/app.tsx")
  dispatchKeyboardShortcut("f", { metaKey: true })
  await vi.waitFor(() => {
    expect(document.activeElement).toBe(searchInput)
    expect(searchInput.value).toBe("needle")
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
        "206 / 206",
      )
      expect(calls.searchReviewSnapshot).toHaveBeenCalledTimes(2)
    },
    { timeout: 10_000 },
  )
  expect(
    calls.searchReviewSnapshot.mock.calls.every(
      ([request]) => request.anchor?.fileId === parsed.files[1]?.fileId,
    ),
  ).toBe(true)
  expect(calls.searchReviewSnapshot.mock.calls[1]?.[0].cursor).not.toBeNull()
})

scenario("diffSearchVisibility", async () => {
  installDiffDashApi()
  renderApp()

  await openDefaultHostedReview()
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

  await openHostedReview(56)
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
      const navigation = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
      expect(navigation?.dataset.reviewNavigationOutcome).toBe("completed::")
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
      const fileHeader = document.querySelector<HTMLElement>(
        `[data-diff-card-path="${fixture.tailPath}"] [data-diff-card-header]`,
      )
      expect(diffPane).not.toBeNull()
      expect(stickyChrome).not.toBeNull()
      expect(fileHeader).not.toBeNull()
      if (activeLine === null || diffPane === null || stickyChrome === null || fileHeader === null)
        return
      const activeRect = activeLine.getBoundingClientRect()
      const paneRect = diffPane.getBoundingClientRect()
      expect(activeRect.bottom).toBeGreaterThan(
        paneRect.top + stickyChrome.offsetHeight + fileHeader.offsetHeight,
      )
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

  await openHostedReview(57)
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
      const fileHeader = document.querySelector<HTMLElement>(
        `[data-diff-card-path="${fixture.largePath}"] [data-diff-card-header]`,
      )
      expect(activeLine?.getAttribute("data-line")).toBe("300")
      expect(diffPane).not.toBeNull()
      expect(stickyChrome).not.toBeNull()
      expect(fileHeader).not.toBeNull()
      if (activeLine === null || diffPane === null || stickyChrome === null || fileHeader === null)
        return
      const activeRect = activeLine.getBoundingClientRect()
      const paneRect = diffPane.getBoundingClientRect()
      expect(activeRect.bottom).toBeGreaterThan(
        paneRect.top + stickyChrome.offsetHeight + fileHeader.offsetHeight,
      )
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

  await openHostedReview(53)

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

  await openHostedReview(54)

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
  await scrollDiffCardAboveViewport(diffPane, largeCard, visibleTop)
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

scenario("viewedShortcutPointerTarget", async () => {
  installDiffDashApi()
  renderApp()

  await openDefaultHostedReview()
  await vi.waitFor(() => {
    expect(getViewedCheckbox("src/app.tsx")).not.toBeNull()
    expect(getViewedCheckbox("docs/readme.md")).not.toBeNull()
  })

  getViewedCheckbox("src/app.tsx")?.click()
  await vi.waitFor(() => {
    expect(getViewedCheckbox("src/app.tsx")?.checked).toBe(true)
    expect(getDiffShadowRoot("src/app.tsx")).toBeNull()
  })
  await new Promise<void>((resolve) =>
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())),
  )

  const diffPane = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
  const stickyChrome = document.querySelector<HTMLElement>("[data-review-sticky-chrome]")
  const appCard = document.querySelector<HTMLElement>('[data-diff-card-path="src/app.tsx"]')
  const docsCard = document.querySelector<HTMLElement>('[data-diff-card-path="docs/readme.md"]')
  expect(diffPane).not.toBeNull()
  expect(stickyChrome).not.toBeNull()
  expect(appCard).not.toBeNull()
  expect(docsCard).not.toBeNull()
  if (diffPane === null || stickyChrome === null || appCard === null || docsCard === null) return
  vi.spyOn(stickyChrome, "offsetHeight", "get").mockReturnValue(100)
  vi.spyOn(diffPane, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1_200, 800))
  vi.spyOn(appCard, "getBoundingClientRect").mockReturnValue(new DOMRect(300, 100, 800, 50))
  vi.spyOn(docsCard, "getBoundingClientRect").mockReturnValue(new DOMRect(300, 170, 800, 400))
  const docsRect = docsCard.getBoundingClientRect()
  diffPane.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      clientX: docsRect.left + Math.min(100, docsRect.width / 2),
      clientY: docsRect.top + Math.min(20, docsRect.height / 2),
      composed: true,
      pointerType: "mouse",
    }),
  )
  dispatchKeyboardShortcut("v")

  await vi.waitFor(() => {
    expect(getViewedCheckbox("docs/readme.md")?.checked).toBe(true)
    expect(getDiffShadowRoot("docs/readme.md")).toBeNull()
    expect(getViewedCheckbox("src/app.tsx")?.checked).toBe(true)
    expect(getDiffShadowRoot("src/app.tsx")).toBeNull()
    expect(document.body.textContent).toContain("Marked docs/readme.md as viewed")
  })
})

scenario("markAllViewedViewport", async () => {
  const fixture = makeLargeDiffFixture(400, 55, 400)
  installDiffDashApi({
    pullRequestDetail: fixture.largeDetail,
    pullRequestDiff: fixture.largeDiff,
    reviewRequests: [fixture.largePullRequest],
  })
  renderApp()

  await openHostedReview(55)

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
  await scrollDiffCardAboveViewport(diffPane, largeCard, visibleTop)

  const actionsButton = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Review actions"]',
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
    const tailCard = document.querySelector<HTMLElement>(
      `[data-diff-card-path="${fixture.tailPath}"]`,
    )
    expect(diffPane.scrollTop).toBeGreaterThan(0)
    expect(diffPane.scrollTop).toBeLessThanOrEqual(diffPane.scrollHeight - diffPane.clientHeight)
    expect(tailCard?.getBoundingClientRect().top).toBeLessThan(
      diffPane.getBoundingClientRect().bottom,
    )
    expect(window.scrollY).toBe(0)
  })
})

scenario("viewedAcrossPushes", async () => {
  const calls = installDiffDashApi()
  renderApp()

  await openDefaultHostedReview()
  await vi.waitFor(() => expect(getViewedCheckbox("src/app.tsx")).not.toBeNull())
  document.querySelector<HTMLButtonElement>('button[aria-label="Files"]')?.click()
  await vi.waitFor(() =>
    expect(
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Files"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("true"),
  )

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
    expect(getDiffShadowRoot("docs/readme.md")?.textContent).toContain("docs update again")
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
      diff: diff.diff.replace(
        "@@ -1,1 +1,1 @@\n-old\n+new",
        "@@ -1,1 +1,1 @@\n-old\n+new behavior\n@@ -20,1 +20,2 @@\n context line\n+new distant line",
      ),
      headRevision: thirdHead,
    }),
  )
  await reloadReviewDiff()
  await vi.waitFor(() => {
    expect(getViewedCheckbox("src/app.tsx")?.checked).toBe(false)
    const renderedText = getDiffShadowRoot("src/app.tsx")?.textContent ?? ""
    expect(renderedText).toContain("new distant line")
    expect(renderedText).not.toContain("deletionLine and additionLine are null")
  })
})

scenario("viewedPersistenceRollback", async () => {
  const calls = installDiffDashApi({
    setViewedFile: async () => {
      throw new Error("viewed file storage unavailable")
    },
  })
  renderApp()
  await openDefaultHostedReview()
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

scenario("shortcutReferenceHome", async () => {
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel")
  installDiffDashApi()
  renderApp()

  await vi.waitFor(() => expect(document.body.textContent).toContain("Pinned projects"))
  const searchInput = document.querySelector<HTMLInputElement>(
    'input[placeholder="Search local and hosted projects"]',
  )
  expect(searchInput).not.toBeNull()
  searchInput?.focus()

  dispatchKeyboardShortcut("/", { metaKey: true })
  const dialog = await vi.waitFor(() => {
    const shortcutDialog = document.querySelector<HTMLDialogElement>(
      'dialog[aria-labelledby="keyboard-shortcut-reference-title"]',
    )
    expect(shortcutDialog).not.toBeNull()
    return shortcutDialog
  })

  expect(document.activeElement?.getAttribute("aria-label")).toBe("Close keyboard shortcuts")
  expect(dialog?.textContent).toContain("General")
  expect(dialog?.textContent).toContain("Review Search")
  expect(dialog?.textContent).toContain("Comments")
  expect(dialog?.textContent).toContain("Go anywhere")
  expect(dialog?.textContent).toContain("Review actions")
  expect(dialog?.textContent).toContain("Search review")
  expect(dialog?.textContent).toContain("Next match")
  expect(dialog?.textContent).toContain("Previous match")
  expect(dialog?.textContent).toContain("Toggle viewed file")
  expect(dialog?.textContent).toContain("Submit comment")
  expect(dialog?.textContent).toContain("Cmd")
  expect(dialog?.textContent).not.toContain("Ctrl")

  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
  )
  await vi.waitFor(() => {
    expect(
      document.querySelector('dialog[aria-labelledby="keyboard-shortcut-reference-title"]'),
    ).toBeNull()
    expect(document.activeElement).toBe(searchInput)
  })
})

scenario("shortcutReferenceReview", async () => {
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32")
  installDiffDashApi()
  renderApp()

  await openDefaultHostedReview()
  await vi.waitFor(() => expect(getViewedCheckbox("src/app.tsx")).not.toBeNull())
  await showWideReviewLayout()

  const filterInput = document.querySelector<HTMLInputElement>('input[placeholder="Filter files"]')
  expect(filterInput).not.toBeNull()
  filterInput?.focus()
  dispatchKeyboardShortcut("/", { ctrlKey: true })

  const dialog = await vi.waitFor(() => {
    const shortcutDialog = document.querySelector<HTMLDialogElement>(
      'dialog[aria-labelledby="keyboard-shortcut-reference-title"]',
    )
    expect(shortcutDialog).not.toBeNull()
    return shortcutDialog
  })
  expect(dialog?.textContent).toContain("Ctrl")
  expect(dialog?.textContent).not.toContain("Cmd")

  document
    .querySelector<HTMLButtonElement>('button[aria-label="Close keyboard shortcuts"]')
    ?.click()
  await vi.waitFor(() => {
    expect(
      document.querySelector('dialog[aria-labelledby="keyboard-shortcut-reference-title"]'),
    ).toBeNull()
    expect(document.activeElement).toBe(filterInput)
  })
})

scenario("shortcutReferenceTitlebarHome", async () => {
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel")
  installDiffDashApi()
  renderApp()

  await vi.waitFor(() => expect(document.body.textContent).toContain("Pinned projects"))
  const shortcutButton = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Keyboard shortcuts (Cmd + /)"]',
  )
  expect(shortcutButton).not.toBeNull()
  const shortcutChord = shortcutButton?.querySelector<HTMLElement>(
    "[data-workbench-shortcut-chord]",
  )
  if (shortcutChord === null || shortcutChord === undefined) {
    throw new Error("Keyboard shortcut chord was not found")
  }
  expect(shortcutChord?.textContent).toBe("Cmd + /")
  shortcutButton?.focus()
  shortcutButton?.click()

  await vi.waitFor(() => {
    expect(
      document.querySelector('dialog[aria-labelledby="keyboard-shortcut-reference-title"]'),
    ).not.toBeNull()
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close keyboard shortcuts")
  })
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
  )
  await vi.waitFor(() => {
    expect(
      document.querySelector('dialog[aria-labelledby="keyboard-shortcut-reference-title"]'),
    ).toBeNull()
    expect(document.activeElement).toBe(shortcutButton)
  })
})

scenario("shortcutReferenceTitlebarReview", async () => {
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32")
  installDiffDashApi()
  renderApp()

  await openDefaultHostedReview()
  await vi.waitFor(() => expect(getViewedCheckbox("src/app.tsx")).not.toBeNull())
  const shell = document.querySelector<HTMLElement>("[data-workbench-shell]")
  if (shell !== null) shell.style.width = "720px"
  const shortcutButton = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Keyboard shortcuts (Ctrl + /)"]',
  )
  expect(shortcutButton).not.toBeNull()
  const shortcutChord = shortcutButton?.querySelector<HTMLElement>(
    "[data-workbench-shortcut-chord]",
  )
  const commandCenter = document.querySelector<HTMLElement>("[data-workbench-command-center]")
  const reviewActions = document.querySelector<HTMLElement>('button[aria-label="Review actions"]')
  if (
    shortcutButton === null ||
    shortcutChord === null ||
    shortcutChord === undefined ||
    commandCenter === null ||
    reviewActions === null
  ) {
    throw new Error("Narrow Review titlebar controls were not found")
  }
  expect(shortcutChord.textContent).toBe("Ctrl + /")
  expect(getComputedStyle(shortcutChord).display).toBe("none")
  expect(commandCenter.getBoundingClientRect().right).toBeLessThan(
    reviewActions.getBoundingClientRect().left,
  )
  expect(reviewActions.getBoundingClientRect().right).toBeLessThan(
    shortcutButton.getBoundingClientRect().left,
  )
  shortcutButton?.focus()
  shortcutButton?.click()

  await vi.waitFor(() => {
    const dialog = document.querySelector<HTMLDialogElement>(
      'dialog[aria-labelledby="keyboard-shortcut-reference-title"]',
    )
    expect(dialog?.textContent).toContain("Ctrl")
    expect(dialog?.textContent).not.toContain("Cmd")
  })
  document
    .querySelector<HTMLButtonElement>('button[aria-label="Close keyboard shortcuts"]')
    ?.click()
  await vi.waitFor(() => {
    expect(
      document.querySelector('dialog[aria-labelledby="keyboard-shortcut-reference-title"]'),
    ).toBeNull()
    expect(document.activeElement).toBe(shortcutButton)
  })
})

scenario("homeToReview", async () => {
  const calls = installDiffDashApi()
  renderApp()

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Pinned projects")
    expect(document.body.textContent).toContain("Recent projects")
    expect(document.body.textContent).not.toContain("PR Preview")
    expect(document.body.textContent).not.toContain("Review Requests")
    expect(document.body.textContent).not.toContain("Recently Reviewed")
  })
  expect(
    [...document.querySelectorAll<HTMLElement>("[data-home-section]")].map(
      (section) => section.dataset.homeSection,
    ),
  ).toEqual(["pinned", "recent"])
  const homeFrame = document.querySelector<HTMLElement>('[data-workbench-frame-mode="route"]')
  const pinned = document.querySelector<HTMLElement>('[data-home-section="pinned"]')
  const versionBadge = document.querySelector<HTMLElement>("[data-home-version]")
  expect(homeFrame).not.toBeNull()
  expect(pinned).not.toBeNull()
  expect(versionBadge).not.toBeNull()
  if (versionBadge !== null) {
    const expectedVersionBadge = document.createElement("div")
    expectedVersionBadge.className = "border-primary/40 text-primary"
    document.body.append(expectedVersionBadge)
    expect(getComputedStyle(versionBadge).color).toBe(getComputedStyle(expectedVersionBadge).color)
    expect(getComputedStyle(versionBadge).borderTopColor).toBe(
      getComputedStyle(expectedVersionBadge).borderTopColor,
    )
    expectedVersionBadge.remove()
  }
  if (homeFrame !== null && pinned !== null) {
    const expectedBorder = document.createElement("div")
    expectedBorder.style.color = "var(--border)"
    document.body.append(expectedBorder)

    expect(getComputedStyle(homeFrame).backgroundColor).not.toBe(
      getComputedStyle(pinned).backgroundColor,
    )
    expect(getComputedStyle(pinned).borderTopColor).toBe(getComputedStyle(expectedBorder).color)
    expect(getComputedStyle(pinned).boxShadow).toBe("none")
    expectedBorder.remove()
  }

  const searchInput = document.querySelector<HTMLInputElement>(
    'input[placeholder="Search local and hosted projects"]',
  )
  expect(searchInput).not.toBeNull()
  if (searchInput !== null) {
    setInputValue(searchInput, "review")
    searchInput.dispatchEvent(new Event("input", { bubbles: true }))
  }

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Hosted")
    expect(document.body.textContent).toContain("fungsi/remote-review")
    expect(document.body.textContent).not.toContain("Search Results")
  })

  calls.listPullRequests.mockClear()
  await openDefaultProject()
  await vi.waitFor(() => {
    expect(calls.getProjectWorkspace).toHaveBeenCalledWith(ReviewProjectId.make(repo.id))
    expect(calls.listPullRequests).toHaveBeenCalledWith({
      repository: expect.objectContaining({
        providerId: "github",
        namespace: "fungsi",
        name: "diffdash",
      }),
    })
    expect(
      document.querySelector('button[aria-label="Reviews"][aria-pressed="true"]'),
    ).not.toBeNull()
    expect(document.body.textContent).toContain(
      "Local changes and hosted pull requests stay together in this workspace.",
    )
  })

  document.querySelector<HTMLButtonElement>('button[aria-label^="Open review #51:"]')?.click()

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
    expect(document.querySelector('button[aria-label="Files"][aria-pressed="true"]')).not.toBeNull()
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
  const gutterUtility = await revealGutterUtility(diffShadow!, lineNumber, addedLineIndex)
  clickGutterUtility(gutterUtility)
  await vi.waitFor(() => {
    expect(document.querySelector('textarea[aria-label="Thread message"]')).not.toBeNull()
  })
  const refreshedGutterUtility = await revealGutterUtility(diffShadow!, lineNumber, addedLineIndex)
  clickGutterUtility(refreshedGutterUtility)
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

  const actionsButton = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Review actions"]',
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
    expect(document.querySelector('dialog[aria-label="Review actions"]')).toBeNull()
    expect(calls.getHostedReviewSnapshot).toHaveBeenCalledWith({ review: expect.anything() })
    expect(calls.getPullRequestDetail).toHaveBeenCalledWith({ review: expect.anything() })
    expect(calls.getPullRequestDiff).toHaveBeenCalledWith({ review: expect.anything() })
    expect(getDiffCardPaths()).toEqual(["src/app.tsx", "docs/readme.md"])
  })

  const reviewPane = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
  expect(reviewPane).not.toBeNull()
  if (reviewPane !== null) {
    reviewPane.scrollTop = 0
    reviewPane.dispatchEvent(new Event("scroll", { bubbles: true }))
    await new Promise((resolve) => window.requestAnimationFrame(resolve))
  }
  dispatchKeyboardShortcut("v")
  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("with shortcut v.")
  })
  expect(document.body.textContent).toContain("Marked src/app.tsx as viewed")
  expect(getViewedCheckbox("src/app.tsx")?.checked).toBe(true)

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
      document.querySelector<HTMLInputElement>('dialog input[placeholder="Search files"]'),
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

  await vi.waitFor(() => expect(getDiffShadowRoot("docs/readme.md")).not.toBeNull())

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

  getViewedCheckbox("src/app.tsx")?.click()
  await vi.waitFor(() => expect(getViewedCheckbox("src/app.tsx")?.checked).toBe(false))

  const walkthroughTab = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Walkthrough"]',
  )
  expect(walkthroughTab).not.toBeNull()
  walkthroughTab?.click()

  await vi.waitFor(() => {
    expect(calls.getWalkthrough).toHaveBeenCalledWith({
      review: expect.anything(),
      baseRevision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      headRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    })
    expect(calls.generateWalkthrough).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain("Review focus")
    expect(document.body.textContent).not.toContain("Diff-only")
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
  const walkthroughStepTitle = document.querySelector<HTMLElement>("[data-walkthrough-step-title]")
  const walkthroughStepFileCount = document.querySelector<HTMLElement>(
    "[data-walkthrough-step-file-count]",
  )
  expect(walkthroughStepTitle).not.toBeNull()
  expect(getComputedStyle(walkthroughStepTitle!).overflowX).toBe("hidden")
  expect(getComputedStyle(walkthroughStepTitle!).textOverflow).toBe("ellipsis")
  expect(getComputedStyle(walkthroughStepTitle!).whiteSpace).toBe("nowrap")
  expect(walkthroughStepFileCount?.children).toHaveLength(2)
  expect(getComputedStyle(walkthroughStepFileCount!).flexDirection).toBe("column")
  const criticalHeader = document.querySelector<HTMLElement>(
    '[data-walkthrough-main-risk="critical"]',
  )
  const expectedCriticalBorder = document.createElement("div")
  expectedCriticalBorder.className = "border-risk-critical/25 border-l-risk-critical"
  document.body.append(expectedCriticalBorder)
  expect(criticalHeader).not.toBeNull()
  expect(getComputedStyle(criticalHeader!).borderTopColor).toBe(
    getComputedStyle(expectedCriticalBorder).borderTopColor,
  )
  expect(getComputedStyle(criticalHeader!).borderLeftColor).toBe(
    getComputedStyle(expectedCriticalBorder).borderLeftColor,
  )
  expectedCriticalBorder.remove()

  dispatchKeyboardShortcut("k", { metaKey: true })
  await vi.waitFor(() => {
    expect(
      document.querySelector<HTMLInputElement>(
        'dialog input[placeholder="Search walkthrough sections"]',
      ),
    ).not.toBeNull()
  })
  const walkthroughCommandInput = document.querySelector<HTMLInputElement>("dialog input")
  expect(walkthroughCommandInput).not.toBeNull()
  const walkthroughPaletteButtons = [
    ...document.querySelectorAll<HTMLButtonElement>("dialog button"),
  ]
  expect(walkthroughPaletteButtons.some((button) => button.textContent?.includes("File ·"))).toBe(
    false,
  )
  expect(document.body.textContent).toContain("Runtime > Entry point")
  expect(document.body.textContent).toContain("Section A > Ci.yml")
  expect(document.body.textContent).toContain("Section B > Ci.yml")
  expect(document.body.textContent).toContain("Support > Documentation")
  if (walkthroughCommandInput !== null) {
    setInputValue(walkthroughCommandInput, "Support > Documentation")
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
  const supportHeader = document.querySelector<HTMLElement>(
    '[data-walkthrough-main-risk="support"]',
  )
  const expectedSupportBorder = document.createElement("div")
  expectedSupportBorder.className = "border-risk-support/25 border-l-risk-support"
  document.body.append(expectedSupportBorder)
  expect(supportHeader).not.toBeNull()
  expect(getComputedStyle(supportHeader!).borderTopColor).toBe(
    getComputedStyle(expectedSupportBorder).borderTopColor,
  )
  expect(getComputedStyle(supportHeader!).borderLeftColor).toBe(
    getComputedStyle(expectedSupportBorder).borderLeftColor,
  )
  expectedSupportBorder.remove()

  const paletteTreeTab = document.querySelector<HTMLButtonElement>('button[aria-label="Files"]')
  expect(paletteTreeTab).not.toBeNull()
  paletteTreeTab?.click()
  dispatchKeyboardShortcut("k", { metaKey: true })
  await vi.waitFor(() => {
    expect(
      document.querySelector<HTMLInputElement>('dialog input[placeholder="Search files"]'),
    ).not.toBeNull()
  })
  const treePaletteText = document.querySelector("dialog")?.textContent ?? ""
  expect(treePaletteText).toContain("src/app.tsx")
  expect(treePaletteText).toContain("docs/readme.md")
  expect(treePaletteText).not.toContain("Runtime > Entry point")
  expect(treePaletteText).not.toContain("Support > Documentation")
  document
    .querySelector<HTMLButtonElement>('dialog button[aria-label="Close command palette"]')
    ?.click()
  const paletteWalkthroughTab = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Walkthrough"]',
  )
  expect(paletteWalkthroughTab).not.toBeNull()
  paletteWalkthroughTab?.click()

  let entryStepButton: HTMLButtonElement | undefined
  await vi.waitFor(() => {
    entryStepButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Entry point") ?? false,
    )
    expect(entryStepButton).toBeDefined()
  })
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
    expect(document.body.textContent).toContain("Sonnet 5")
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

  const walkthroughDiffCard = document.querySelector<HTMLElement>(
    '[data-diff-card-path="docs/readme.md"]',
  )
  const walkthroughViewedCheckbox =
    walkthroughDiffCard?.querySelector<HTMLInputElement>('input[type="checkbox"]')
  expect(walkthroughViewedCheckbox).not.toBeNull()
  expect(walkthroughDiffCard?.querySelector("[data-diff-card-body]")).not.toBeNull()
  walkthroughViewedCheckbox?.click()

  await vi.waitFor(() => {
    expect(walkthroughViewedCheckbox?.checked).toBe(true)
    expect(walkthroughDiffCard?.querySelector("[data-diff-card-body]")).toBeNull()
    expect(document.body.textContent).toContain("Mark complete")
  })

  walkthroughViewedCheckbox?.click()
  await vi.waitFor(() => {
    expect(walkthroughViewedCheckbox?.checked).toBe(false)
    expect(walkthroughDiffCard?.querySelector("[data-diff-card-body]")).not.toBeNull()
  })

  const markCompleteButton = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Mark complete",
  )
  expect(markCompleteButton).toBeDefined()
  markCompleteButton?.click()

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Complete")
  })

  const regenerateButton = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Refresh walkthrough"]',
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
    (button) => button.getAttribute("aria-label") === "Files",
  )
  expect(treeTab).toBeDefined()
  treeTab?.click()

  await vi.waitFor(() => {
    expect(getChangedFilesTreeItemPaths()).toContain("src/app.tsx")
    expect(getChangedFilesTreeItemPaths()).toContain("docs/readme.md")
    expect(getChangedFilesTreeItemPaths()).toContain("pnpm-lock.yaml")
    expect(getDiffCardPaths()).toEqual(["src/app.tsx", "docs/readme.md", "pnpm-lock.yaml"])
  })

  const firstDiffOpenButton = [
    ...document.querySelectorAll<HTMLButtonElement>('[data-diff-card-path="src/app.tsx"] button'),
  ].find((button) => button.textContent === "Open")
  const firstDiffViewedControl = getViewedCheckbox("src/app.tsx")?.closest("label") ?? null
  expect(firstDiffOpenButton).toBeDefined()
  expect(firstDiffViewedControl).not.toBeNull()
  if (firstDiffOpenButton !== undefined && firstDiffViewedControl !== null) {
    const openStyle = getComputedStyle(firstDiffOpenButton)
    const viewedStyle = getComputedStyle(firstDiffViewedControl)
    expect(firstDiffOpenButton.getBoundingClientRect().height).toBe(
      firstDiffViewedControl.getBoundingClientRect().height,
    )
    expect(openStyle.paddingLeft).toBe(viewedStyle.paddingLeft)
    expect(openStyle.paddingRight).toBe(viewedStyle.paddingRight)
    expect(openStyle.borderRadius).toBe(viewedStyle.borderRadius)
  }
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
    expect(document.body.textContent).toContain("Pinned projects")
    expect(document.body.textContent).not.toContain("Recently Reviewed")
    expect(document.body.textContent).not.toContain("PR Preview")
    expect(document.body.textContent).not.toContain("Opened PR #51")
  })

  dispatchSideMouseButton(4)

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Pinned projects")
    expect(document.body.textContent).not.toContain("Opened PR #51")
    expect(document.querySelector('button[aria-label="Back"]')).toBeNull()
  })
})

scenario("localReview", async () => {
  const calls = installDiffDashApi()
  renderApp()

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Pinned projects")
  })

  calls.openLocalReview()

  const localTarget = workingTreeReviewTarget(localReview.rootPath)

  await vi.waitFor(() => {
    expect(calls.openProject).toHaveBeenCalledWith(localReview.rootPath, undefined)
    expect(calls.getLocalReviewDetail).toHaveBeenCalledWith(localTarget)
    expect(calls.getLocalReviewDiff).toHaveBeenCalledWith(localTarget)
    expect(document.querySelector('button[aria-label="Files"][aria-pressed="true"]')).not.toBeNull()
  })

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Local changes")
    expect(document.body.textContent).toContain("src/local.ts")
    expect(document.body.textContent).not.toContain("Approve")
    expect(document.querySelector("[data-review-editor-header]")?.textContent).toContain(
      "Local (feature/local-review)",
    )
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

  const treeTab = document.querySelector<HTMLButtonElement>('button[aria-label="Files"]')
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
    pullRequests: [fixturePullRequest],
    reviewRequests: [fixturePullRequest],
  })
  renderApp()

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("hosted merge request")
  })
  await openDefaultProject()
  const openReview = document.querySelector<HTMLButtonElement>(
    'button[aria-label^="Open review #73"]',
  )
  expect(openReview).not.toBeNull()
  openReview?.click()

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Opened MR #73")
    expect(document.body.textContent).toContain("Fixture merge request flow")
  })
  const actions = document.querySelector<HTMLButtonElement>('button[aria-label="Review actions"]')
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

const getSelectedChangedFileTreeItems = () => [
  ...(document
    .querySelector("file-tree-container")
    ?.shadowRoot?.querySelectorAll<HTMLElement>("[data-item-selected]") ?? []),
]

const getDiffCardPaths = () =>
  [...document.querySelectorAll("[data-diff-card-path]")]
    .map((element) => element.getAttribute("data-diff-card-path"))
    .filter((path) => path !== null)

const getViewedCheckbox = (path: string) =>
  document.querySelector<HTMLInputElement>(`[data-diff-card-path="${path}"] input[type="checkbox"]`)

const getDiffShadowRoot = (path: string) =>
  document.querySelector(`[data-diff-card-path="${path}"] diffs-container`)?.shadowRoot ?? null

const getSyntaxTokenColor = (shadowRoot: ShadowRoot, text: string) => {
  const token = [...shadowRoot.querySelectorAll<HTMLElement>("span[style]")].find((candidate) => {
    const candidateText = candidate.textContent?.trim()
    if (candidateText === text) return true
    return (
      candidateText !== undefined &&
      candidateText.length >= 2 &&
      candidateText.slice(1, -1) === text &&
      (candidateText.startsWith('"') || candidateText.startsWith("'")) &&
      candidateText.at(-1) === candidateText[0]
    )
  })
  expect(token).not.toBeUndefined()
  if (token === undefined) throw new Error(`Missing syntax token: ${text}`)
  return getComputedStyle(token).color
}

const getMountedDiffLineCount = () =>
  [...document.querySelectorAll("diffs-container")].reduce(
    (count, element) => count + (element.shadowRoot?.querySelectorAll("[data-line]").length ?? 0),
    0,
  )

const getDiffLine = (shadowRoot: ShadowRoot, content: string) =>
  [...shadowRoot.querySelectorAll<HTMLElement>("[data-line]")].find(
    (element) => element.textContent?.trim() === content,
  )

const waitForAnimationFrames = (count: number) =>
  new Promise<void>((resolve) => {
    let remaining = count
    const wait = () => {
      remaining -= 1
      if (remaining <= 0) {
        resolve()
        return
      }
      window.requestAnimationFrame(wait)
    }
    window.requestAnimationFrame(wait)
  })

const runContinuousReviewScroll = (pane: HTMLElement, frameCount: number) =>
  new Promise<readonly number[]>((resolve) => {
    const frameDurations: number[] = []
    const targetScrollTop = Math.min(30_000, Math.max(0, pane.scrollHeight - pane.clientHeight))
    let frame = 0
    let previousTime = performance.now()
    const scrollFrame = (time: number) => {
      frameDurations.push(time - previousTime)
      previousTime = time
      frame += 1
      pane.scrollTop = targetScrollTop * (frame / frameCount)
      pane.dispatchEvent(new Event("scroll", { bubbles: true }))
      if (frame < frameCount) {
        window.requestAnimationFrame(scrollFrame)
        return
      }
      window.requestAnimationFrame(() => resolve(frameDurations))
    }
    window.requestAnimationFrame(scrollFrame)
  })

const showResponsiveDiffPane = async () => {
  await vi.waitFor(() => expect(document.querySelector("[data-review-layout]")).not.toBeNull())
  await waitForAnimationFrames(2)
  await vi.waitFor(() => {
    const pane = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
    expect(pane).not.toBeNull()
    expect(pane?.getBoundingClientRect().width).toBeGreaterThan(0)
    expect(pane?.getBoundingClientRect().height).toBeGreaterThan(0)
  })
  await waitForAnimationFrames(2)
}

const openOnlyReviewThreadInDiff = async (path: string, lineLabel: string) => {
  const threadsButton = await vi.waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Threads"]')
    expect(button).not.toBeNull()
    return button!
  })
  threadsButton.click()
  const threadButton = await vi.waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>(
      `button[aria-label="Open thread details for ${path} ${lineLabel}"]`,
    )
    expect(button).not.toBeNull()
    return button!
  })
  threadButton.click()
  const goToDiff = await vi.waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>(
      '[data-review-thread-detail] button[aria-label="Go to thread in diff"]',
    )
    expect(button).not.toBeNull()
    return button!
  })
  goToDiff.click()
  await waitForAnimationFrames(4)
}

const showWideReviewLayout = async () => {
  const layout = await vi.waitFor(() => {
    const element = document.querySelector<HTMLElement>("[data-review-layout]")
    expect(element).not.toBeNull()
    return element!
  })
  layout.style.width = "1200px"
  layout.style.flex = "none"
  await vi.waitFor(() => expect(layout.dataset.reviewPaneMode).toBe("wide"))
  await waitForAnimationFrames(2)
}

const alignReviewCardAtVisibleTop = async (path: string) => {
  const { card, pane, sticky } = await vi.waitFor(() => {
    const nextPane = document.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
    const nextSticky = document.querySelector<HTMLElement>("[data-review-sticky-chrome]")
    const nextCard = document.querySelector<HTMLElement>(`[data-diff-card-path="${path}"]`)
    expect(nextPane).not.toBeNull()
    expect(nextSticky).not.toBeNull()
    expect(nextCard).not.toBeNull()
    return { card: nextCard!, pane: nextPane!, sticky: nextSticky! }
  })
  const visibleTop = pane.getBoundingClientRect().top + sticky.offsetHeight
  await vi.waitFor(
    () => {
      let cardRect = card.getBoundingClientRect()
      if (Math.abs(cardRect.top - visibleTop) > 1) {
        pane.scrollTop += cardRect.top - visibleTop
        pane.dispatchEvent(new Event("scroll", { bubbles: true }))
        cardRect = card.getBoundingClientRect()
      }
      expect(cardRect.top).toBeLessThanOrEqual(visibleTop + 1)
      expect(cardRect.bottom).toBeGreaterThan(visibleTop)
    },
    { timeout: 10_000 },
  )
}

const scrollDiffCardAboveViewport = async (
  diffPane: HTMLElement,
  diffCard: HTMLElement,
  visibleTop: number,
) => {
  const targetScrollTop =
    diffPane.scrollTop + diffCard.getBoundingClientRect().top - visibleTop + 300
  await vi.waitFor(() => {
    expect(diffPane.scrollHeight - diffPane.clientHeight).toBeGreaterThanOrEqual(targetScrollTop)
  })
  diffPane.scrollTop = targetScrollTop
  diffPane.dispatchEvent(new Event("scroll", { bubbles: true }))
  await vi.waitFor(() => {
    expect(diffCard.getBoundingClientRect().top).toBeLessThan(visibleTop - 250)
  })
}

const revealGutterUtility = async (
  shadowRoot: ShadowRoot,
  lineNumber: string | null | undefined,
  lineIndex: string | null | undefined,
) => {
  const gutterNumber = await vi.waitFor(() => {
    const element = [...shadowRoot.querySelectorAll<HTMLElement>("[data-column-number]")].find(
      (candidate) =>
        candidate.getAttribute("data-column-number") === lineNumber &&
        candidate.getAttribute("data-line-index") === lineIndex,
    )
    expect(element).toBeDefined()
    if (element === undefined) throw new Error("Missing diff gutter number")
    return element
  })
  gutterNumber
    .closest("pre")
    ?.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }))
  gutterNumber.dispatchEvent(
    new PointerEvent("pointermove", { bubbles: true, composed: true, pointerType: "mouse" }),
  )
  return vi.waitFor(() => {
    const utility = shadowRoot.querySelector<HTMLButtonElement>("[data-utility-button]")
    expect(utility).not.toBeNull()
    if (utility === null) throw new Error("Missing diff gutter utility")
    return utility
  })
}

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
  options: {
    readonly ctrlKey?: boolean
    readonly metaKey?: boolean
    readonly shiftKey?: boolean
  } = {},
) => {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: options.ctrlKey ?? false,
      key,
      metaKey: options.metaKey ?? false,
      shiftKey: options.shiftKey ?? false,
    }),
  )
}

const reloadReviewDiff = async () => {
  const actionsButton = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Review actions"]',
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

const stableBrowserCursorHash = (parts: readonly string[]) => {
  const value = parts.join("\u0000")
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

const installDiffDashApi = (
  options: {
    readonly appState?: AppState
    readonly agentProviderCatalog?: AgentProviderCatalog
    readonly beforeReviewSnapshotPage?: (
      request: Parameters<DiffDashApi["reviewSnapshots"]["getPage"]>[0],
    ) => Promise<void>
    readonly beforeReviewSnapshotSearch?: (
      request: Parameters<DiffDashApi["reviewSnapshots"]["search"]>[0],
    ) => Promise<void>
    readonly cliInstallResult?: { readonly path: string; readonly pathSetupCommand: string | null }
    readonly diagnostics?: AppPrerequisites
    readonly expireFirstSnapshotPage?: boolean
    readonly getAppState?: DiffDashApi["appState"]["get"]
    readonly getDiagnostics?: DiffDashApi["diagnostics"]
    readonly localReviewDiff?: LocalReviewDiff
    readonly openProject?: DiffDashApi["repositories"]["openProject"]
    readonly projectWorkspaceState?: ProjectWorkspaceState | null
    readonly pullRequestDetail?: HostedReviewDetail
    readonly pullRequestDiff?: HostedReviewDiff
    readonly pullRequests?: readonly HostedReviewSummary[]
    readonly providers?: readonly GitProviderDescriptor[]
    readonly repositories?: readonly Repo[]
    readonly reviewThreadDetails?: readonly ReviewThreadDetails[]
    readonly reviewRequests?: readonly HostedReviewSummary[]
    readonly snapshotPageFileLimit?: number
    readonly setViewedFile?: DiffDashApi["viewedFiles"]["set"]
    readonly setLocalViewedFile?: DiffDashApi["viewedFiles"]["setLocal"]
    readonly settings?: AISettings
    readonly selectLocalFolder?: string | null
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
  const reviewThreadDetails = options.reviewThreadDetails ?? []
  const initialUpdateState =
    options.updateState ??
    AppUpdateUnsupported.make({ currentVersion: "0.1.4", reason: "development" })
  let commandsAvailableListener: (() => void) | null = null
  let pendingCommands: CliNavigationCommand[] = []
  let updateStateListener: ((state: AppUpdateState) => void) | null = null
  let approved = false
  let expireNextSnapshotPage = options.expireFirstSnapshotPage ?? false
  const snapshots = new Map<string, ReviewSnapshot>()
  const projectWorkspaceStates = new Map<ReviewProjectId, ProjectWorkspaceState>()
  if (options.projectWorkspaceState !== undefined && options.projectWorkspaceState !== null) {
    projectWorkspaceStates.set(
      options.projectWorkspaceState.projectId,
      options.projectWorkspaceState,
    )
  }
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
    async (target) =>
      LocalReviewDiff.make({
        ...(options.localReviewDiff ?? localDiff),
        comparison: target.comparison,
      }),
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
      return makeReviewSnapshotManifest(snapshot, ReviewProjectId.make("local-repo-1"))
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
    getAppState: vi.fn<DiffDashApi["appState"]["get"]>(
      options.getAppState ?? (async () => appState),
    ),
    getDiagnostics: vi.fn<DiffDashApi["diagnostics"]>(
      options.getDiagnostics ?? (async () => diagnostics),
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
    listPullRequests: vi.fn<DiffDashApi["hostedReviews"]["list"]>(
      async () => options.pullRequests ?? options.reviewRequests ?? [pullRequest],
    ),
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
    selectLocalFolder: vi.fn<() => Promise<string | null>>(
      async () => options.selectLocalFolder ?? null,
    ),
    openProject: vi.fn<DiffDashApi["repositories"]["openProject"]>(
      options.openProject ??
        (async (localPath) => ProjectOpened.make({ repo: Repo.make({ ...repo, localPath }) })),
    ),
    repairRepositoryIdentities: vi.fn<DiffDashApi["repositories"]["repairIdentities"]>(async () =>
      RepositoryIdentityRepairSummary.make({
        resolvedCount: repositories.filter((repository) => repository.provider !== "local").length,
        unresolvedCount: 0,
        localAliasCount: 0,
      }),
    ),
    getProjectWorkspace: vi.fn<DiffDashApi["projectWorkspace"]["get"]>(
      async (projectId) => projectWorkspaceStates.get(projectId) ?? null,
    ),
    saveProjectWorkspace: vi.fn<DiffDashApi["projectWorkspace"]["save"]>(async (input) => {
      const state = ProjectWorkspaceState.make({
        ...input,
        updatedAt: "2026-07-01T00:00:00.000Z",
      })
      projectWorkspaceStates.set(input.projectId, state)
      return state
    }),
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
    activateWindow: vi.fn<() => Promise<void>>(async () => undefined),
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
      return makeReviewSnapshotManifest(snapshot, ReviewProjectId.make(repo.id))
    },
  )
  const getReviewSnapshotPage = vi.fn<DiffDashApi["reviewSnapshots"]["getPage"]>(
    async (request) => {
      await options.beforeReviewSnapshotPage?.(request)
      const snapshot = snapshots.get(request.snapshotId)
      if (expireNextSnapshotPage) {
        expireNextSnapshotPage = false
        snapshots.delete(request.snapshotId)
        return ReviewSnapshotExpired.make({ snapshotId: request.snapshotId, reason: "evicted" })
      }
      if (snapshot === undefined) {
        return ReviewSnapshotExpired.make({
          snapshotId: request.snapshotId,
          reason: "evicted",
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
      const pageFileLimit = options.snapshotPageFileLimit
      if (pageFileLimit !== undefined) {
        const selectionHash = stableBrowserCursorHash(selected.map((file) => file.fileId))
        const cursorMatch =
          request.cursor === null ? null : /^page:v1:([0-9]+):([0-9a-f]{8})$/u.exec(request.cursor)
        if (request.cursor !== null && cursorMatch?.[2] !== selectionHash) {
          return ReviewSnapshotExpired.make({
            snapshotId: request.snapshotId,
            reason: "mismatched",
          })
        }
        const offset = cursorMatch === null ? 0 : Number(cursorMatch[1])
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > selected.length) {
          return ReviewSnapshotExpired.make({
            snapshotId: request.snapshotId,
            reason: "mismatched",
          })
        }
        const nextOffset = Math.min(selected.length, offset + pageFileLimit)
        return ReviewSnapshotPageAvailable.make({
          snapshotId: request.snapshotId,
          files: selected.slice(offset, nextOffset),
          nextCursor:
            nextOffset < selected.length
              ? ReviewSnapshotPageCursor.make(`page:v1:${nextOffset}:${selectionHash}`)
              : null,
        })
      }
      if (request.cursor !== null) {
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
    await options.beforeReviewSnapshotSearch?.(request)
    const snapshot = snapshots.get(request.snapshotId)
    if (snapshot === undefined) {
      return ReviewSnapshotExpired.make({
        snapshotId: request.snapshotId,
        reason: "evicted",
      })
    }
    const index = buildReviewSearchIndex(snapshot.parsedDiff.files)
    const unanchoredOccurrences = searchReviewIndex(index, request.query)
    const searchAnchor = request.anchor
    const anchorFileIndex =
      searchAnchor === null
        ? -1
        : snapshot.parsedDiff.files.findIndex((file) => file.fileId === searchAnchor.fileId)
    if (searchAnchor !== null && anchorFileIndex < 0) {
      return ReviewSnapshotExpired.make({
        snapshotId: request.snapshotId,
        reason: "mismatched",
      })
    }
    const anchoredIndex =
      searchAnchor === null
        ? 0
        : unanchoredOccurrences.findIndex((occurrence) => {
            const fileIndex = snapshot.parsedDiff.files.findIndex(
              (file) => file.reviewKey === occurrence.reviewKey,
            )
            return fileIndex >= anchorFileIndex
          })
    const occurrences =
      anchoredIndex > 0
        ? [
            ...unanchoredOccurrences.slice(anchoredIndex),
            ...unanchoredOccurrences.slice(0, anchoredIndex),
          ]
        : unanchoredOccurrences
    const cursorHash = stableBrowserCursorHash([
      request.query,
      searchAnchor === null ? "" : `file:${searchAnchor.fileId}`,
    ])
    const cursorMatch =
      request.cursor === null ? null : /^search:v1:([0-9]+):([0-9a-f]{8})$/.exec(request.cursor)
    const offset = request.cursor === null ? 0 : Number(cursorMatch?.[1])
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > occurrences.length) {
      return ReviewSnapshotExpired.make({
        snapshotId: request.snapshotId,
        reason: "mismatched",
      })
    }
    if (request.cursor !== null && cursorMatch?.[2] !== cursorHash) {
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
          hunkFingerprint: ReviewHunkFingerprint.make(occurrence.hunkFingerprint),
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
          ? ReviewSnapshotSearchCursor.make(`search:v1:${end}:${cursorHash}`)
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
      activateWindow: calls.activateWindow,
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
    diagnostics: calls.getDiagnostics,
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
      openProject: calls.openProject,
      repairIdentities: calls.repairRepositoryIdentities,
      forget: async (projectId) => {
        const project = repositories.find((candidate) => candidate.id === projectId)
        if (project === undefined) throw new Error(`Repository not found: ${projectId}`)
        return Repo.make({ ...project, isFavorite: false, lastOpenedAt: null })
      },
      favoriteRemote: calls.favoriteRemoteRepository,
      list: calls.listRepositories,
      selectLocalFolder: calls.selectLocalFolder,
      setFavorite: calls.setRepositoryFavorite,
    },
    projectWorkspace: {
      get: calls.getProjectWorkspace,
      save: calls.saveProjectWorkspace,
    },
    reviewThreads: {
      list: async () => reviewThreadDetails.map((item) => item.thread),
      create: async () => {
        throw new Error("Review thread creation is not used by this fixture")
      },
      addUserMessage: async () => {
        throw new Error("Review thread messages are not used by this fixture")
      },
      get: async (threadId) => {
        const details = reviewThreadDetails.find((item) => item.thread.id === threadId)
        if (details === undefined) throw new Error(`Review thread not found: ${threadId}`)
        return details
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
      get: calls.getAppState,
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
    repairRepositoriesFromCli: () => {
      pendingCommands.push(RepairRepositoryIdentitiesCommand.make({}))
      commandsAvailableListener?.()
    },
  }
}

const plainAISettings = (settings: AISettings): AISettings =>
  AISettings.make({
    version: settings.version,
    appearance: settings.appearance,
    themes: ThemePreferences.make({
      light: settings.themes.light,
      dark: settings.themes.dark,
    }),
    codeThemes: CodeThemePreferences.make({
      light: settings.codeThemes.light,
      dark: settings.codeThemes.dark,
    }),
    diffViewMode: settings.diffViewMode,
    layout: RendererLayoutSettings.make({
      review: ReviewPaneSettings.make({
        contextWidth: settings.layout.review.contextWidth,
        threadDetailWidth: settings.layout.review.threadDetailWidth,
      }),
    }),
    routes: {
      walkthrough: settings.routes.walkthrough,
      reviewThread: settings.routes.reviewThread,
    },
    telemetryEnabled: settings.telemetryEnabled,
    autoQuality: settings.autoQuality,
    models: { ...settings.models },
  })
