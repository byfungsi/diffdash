import { AISettings, DEFAULT_AI_SETTINGS } from "@diffdash/domain/ai-settings"
import { AppState } from "@diffdash/domain/app-state"
import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { projectDiffHunkLines } from "@diffdash/domain/diff-hunk-lines"
import {
  GitProviderCapabilities,
  GitProviderDescriptor,
  GitProviderId,
  GitProviderKind,
  GitProviderTerminology,
  HostedRepository,
  makeHostedRepositoryLocator,
} from "@diffdash/domain/git-provider"
import {
  BranchComparison,
  LocalReviewDetail,
  LocalReviewDiff,
  LocalReviewTarget,
} from "@diffdash/domain/local-review"
import { Repo } from "@diffdash/domain/repository"
import { ReviewAgentProgress } from "@diffdash/domain/review-agent"
import {
  LocalReviewSnapshot,
  makeReviewSnapshotManifest,
  type ReviewSnapshot,
} from "@diffdash/domain/review-context"
import {
  makeReviewSnapshotId,
  type ReviewFilePatchHash,
  ReviewDiffIdentity,
  ReviewKey,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import {
  MarkdownBody,
  ReviewThread,
  ReviewThreadDetails,
  ReviewThreadId,
  ReviewThreadMessage,
  ReviewThreadMessageId,
  type ReviewThreadTarget,
} from "@diffdash/domain/review-thread"
import { StoredWalkthrough } from "@diffdash/domain/walkthrough"
import {
  AgentProviderAutoCandidates,
  AgentProviderCapabilityStatus,
  AgentProviderCatalog,
  AgentProviderDefaults,
  AgentProviderId,
  AgentModelId,
  AgentProviderModel,
  AgentProviderStatus,
} from "@diffdash/protocol/agent-providers"
import type { DiffDashApi } from "@diffdash/protocol/api"
import {
  type CliNavigationCommand,
  OpenBranchDiffCommand,
  OpenWorkingTreeCommand,
} from "@diffdash/protocol/cli-navigation"
import {
  AppUpdateAvailable,
  AppUpdateDownloaded,
  AppUpdateDownloading,
  type AppUpdateState,
  AppUpdateUnsupported,
} from "@diffdash/protocol/app-update"
import { AppPrerequisites, DiffDashCliInstallResult } from "@diffdash/protocol/prerequisites"
import {
  REVIEW_SNAPSHOT_PAGE_FILE_LIMIT,
  ReviewSnapshotExpired,
  ReviewSnapshotPageAvailable,
  ReviewSnapshotPageCursor,
  ReviewSnapshotSearchAvailable,
  ReviewSnapshotSearchMatch,
} from "@diffdash/protocol/review-snapshot"
import type { MaterializedDemoRevision, MaterializedDemoScenario } from "./demo-scenario"

/** One deterministic renderer action recorded by the demo runtime. */
export interface DemoAction {
  readonly sequence: number
  readonly type: string
  readonly detail: Readonly<Record<string, string | number | boolean | null>>
}

/** Serializable state exposed to capture automation without granting UI mutation. */
export interface DemoTimelineState {
  readonly scenarioId: string
  readonly revisionId: string
  readonly approved: boolean
  readonly viewedFileKeys: readonly string[]
  readonly pendingAgentTurnIds: readonly string[]
  readonly updateState: AppUpdateState["_tag"]
}

/** Narrow backend timeline used by deterministic capture automation. */
export interface DemoTimeline {
  readonly reset: (scenarioId: string) => Promise<void>
  readonly release: (checkpointId: string) => Promise<void>
  readonly getState: () => DemoTimelineState
  readonly getActionLog: () => readonly DemoAction[]
}

/** Complete scenario-backed renderer API and its capture-only timeline. */
export interface DemoRuntime {
  readonly api: DiffDashApi
  readonly timeline: DemoTimeline
}

interface PendingAgentRun {
  readonly turnId: string
  readonly threadId: ReviewThreadId
  readonly resolve: (details: ReviewThreadDetails) => void
  readonly reject: (cause: Error) => void
}

/** Creates a fresh, fully in-memory DiffDash runtime for one materialized scenario. */
export const createDemoRuntime = (scenario: MaterializedDemoScenario): DemoRuntime => {
  const firstRevision = scenario.revisions[0]
  if (firstRevision === undefined) throw new Error("Demo scenario requires at least one revision")

  const progressListeners = new Set<(progress: ReviewAgentProgress) => void>()
  const updateListeners = new Set<(state: AppUpdateState) => void>()
  const navigationListeners = new Set<() => void>()
  const actions: DemoAction[] = []
  const pendingRuns = new Map<string, PendingAgentRun>()
  const snapshotCache = new Map<string, ReviewSnapshot>()
  let repositories: Repo[] = []
  let currentRevision = firstRevision
  let approved = false
  let viewedFiles = new Map<string, ReviewFilePatchHash>()
  let settings = cloneSettings(DEFAULT_AI_SETTINGS)
  let appState = AppState.make({ onboardingCompleted: true })
  const diagnostics = readyDemoPrerequisites()
  let updateState: AppUpdateState = AppUpdateUnsupported.make({
    currentVersion: scenario.manifest.appVersion.replace(/^v/, ""),
    reason: "development",
  })
  let threadDetails = new Map<ReviewThreadId, ReviewThreadDetails>()
  let createdThreadCounter = 0
  let createdMessageCounter = 0
  let navigationCommands: CliNavigationCommand[] = []
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

  const record = (
    type: string,
    detail: Readonly<Record<string, string | number | boolean | null>> = {},
  ) => {
    actions.push({ sequence: actions.length, type, detail })
  }

  const resetState = () => {
    for (const pending of pendingRuns.values()) {
      pending.reject(new Error("Demo scenario reset while an agent turn was pending"))
    }
    pendingRuns.clear()
    currentRevision = firstRevision
    snapshotCache.clear()
    snapshotCache.set(currentRevision.snapshot.snapshotId, currentRevision.snapshot)
    repositories = [scenario.repository]
    approved = false
    settings = cloneSettings(DEFAULT_AI_SETTINGS)
    appState = AppState.make({ onboardingCompleted: true })
    updateState = AppUpdateUnsupported.make({
      currentVersion: scenario.manifest.appVersion.replace(/^v/, ""),
      reason: "development",
    })
    viewedFiles = new Map(
      currentRevision.parsedDiff.files
        .filter((file) => scenario.manifest.initiallyViewedFilePaths.includes(file.path))
        .map((file) => [file.reviewKey, file.patchHash]),
    )
    threadDetails = new Map(
      scenario.threads.map((details) => {
        const initialMessages = details.messages.filter((message) => message.sequence <= 1)
        return [
          details.thread.id,
          ReviewThreadDetails.make({
            thread: ReviewThread.make({
              ...details.thread,
              currentBaseRevision: firstRevision.snapshot.baseRevision,
              currentHeadRevision: firstRevision.snapshot.headRevision,
              currentAnchor: details.thread.originalAnchor,
              anchorStatus: "active",
              updatedAt: initialMessages.at(-1)?.updatedAt ?? details.thread.createdAt,
            }),
            messages: initialMessages,
          }),
        ]
      }),
    )
    createdThreadCounter = 0
    createdMessageCounter = 0
    navigationCommands = []
  }

  const setUpdateState = (state: AppUpdateState) => {
    updateState = state
    for (const listener of updateListeners) listener(state)
  }

  const enqueueNavigation = (command: CliNavigationCommand) => {
    navigationCommands.push(command)
    for (const listener of navigationListeners) listener()
  }

  const requireReview = (owner: string, name: string, number: number) => {
    if (
      owner !== scenario.repository.owner ||
      name !== scenario.repository.name ||
      number !== scenario.manifest.pullRequest.number
    ) {
      throw new Error(`Unknown demo pull request: ${owner}/${name}#${number}`)
    }
  }

  const requireTarget = (target: ReviewThreadTarget) => {
    if (target.kind === "local") return
    requireReview(
      target.review.repository.namespace,
      target.review.repository.name,
      target.review.number,
    )
  }

  const requireThread = (threadId: ReviewThreadId) => {
    const details = threadDetails.get(threadId)
    if (details === undefined) throw new Error(`Unknown demo review thread: ${threadId}`)
    return details
  }

  const replaceThread = (details: ReviewThreadDetails) => {
    threadDetails.set(details.thread.id, details)
    return details
  }

  const timeline: DemoTimeline = {
    reset: async (scenarioId) => {
      if (scenarioId !== scenario.manifest.id)
        throw new Error(`Unknown demo scenario: ${scenarioId}`)
      resetState()
      actions.length = 0
      record("timeline.reset", { scenarioId })
    },
    release: async (checkpointId) => {
      record("timeline.release", { checkpointId })
      if (checkpointId === "revision-updated") {
        currentRevision = scenario.currentRevision
        snapshotCache.set(currentRevision.snapshot.snapshotId, currentRevision.snapshot)
        for (const sourceDetails of scenario.threads) {
          const current = threadDetails.get(sourceDetails.thread.id)
          if (current === undefined) continue
          replaceThread(
            ReviewThreadDetails.make({
              thread: ReviewThread.make({
                ...current.thread,
                currentBaseRevision: sourceDetails.thread.currentBaseRevision,
                currentHeadRevision: sourceDetails.thread.currentHeadRevision,
                currentAnchor: sourceDetails.thread.currentAnchor,
                anchorStatus: sourceDetails.thread.anchorStatus,
              }),
              messages: current.messages,
            }),
          )
        }
        return
      }
      if (checkpointId === "update-available") {
        setUpdateState(
          AppUpdateAvailable.make({
            currentVersion: scenario.manifest.appVersion.replace(/^v/, ""),
            version: "0.4.4",
          }),
        )
        return
      }
      if (checkpointId === "update-downloaded") {
        setUpdateState(
          AppUpdateDownloaded.make({
            currentVersion: scenario.manifest.appVersion.replace(/^v/, ""),
            version: "0.4.4",
          }),
        )
        return
      }
      if (checkpointId === "navigation-working-tree") {
        enqueueNavigation(
          OpenWorkingTreeCommand.make({ localPath: "/Users/demo/emberline-dispatch" }),
        )
        return
      }
      if (checkpointId === "navigation-branch-diff") {
        enqueueNavigation(
          OpenBranchDiffCommand.make({
            localPath: "/Users/demo/emberline-dispatch",
            branchName: "dev",
          }),
        )
        return
      }

      const pending = pendingRuns.get(checkpointId)
      const turn = scenario.agentTurns[checkpointId]
      if (pending === undefined || turn === undefined) {
        throw new Error(`Nothing is waiting for demo checkpoint: ${checkpointId}`)
      }
      for (const progress of turn.progress) {
        const event = ReviewAgentProgress.make({
          threadId: pending.threadId,
          stage: progress.event.stage,
        })
        for (const listener of progressListeners) listener(event)
      }
      const current = requireThread(pending.threadId)
      const sourceMessage = scenario.threads
        .flatMap((details) => details.messages)
        .find(
          (message) =>
            message.agentRunId !== null && message.bodyMarkdown === turn.response.bodyMarkdown,
        )
      const pendingMessage = current.messages.find((message) => message.status === "pending")
      if (pendingMessage === undefined) {
        pending.reject(new Error(`Pending agent message is missing for ${checkpointId}`))
        pendingRuns.delete(checkpointId)
        return
      }
      const completed = ReviewThreadMessage.make({
        ...pendingMessage,
        bodyMarkdown: MarkdownBody.make(turn.response.bodyMarkdown),
        status: "complete",
        updatedAt: sourceMessage?.updatedAt ?? current.thread.updatedAt,
      })
      const result = replaceThread(
        ReviewThreadDetails.make({
          thread: ReviewThread.make({
            ...current.thread,
            updatedAt: completed.updatedAt,
          }),
          messages: current.messages.map((message) =>
            message.id === pendingMessage.id ? completed : message,
          ),
        }),
      )
      pendingRuns.delete(checkpointId)
      pending.resolve(result)
    },
    getState: () => ({
      scenarioId: scenario.manifest.id,
      revisionId: currentRevision.id,
      approved,
      viewedFileKeys: currentRevision.parsedDiff.files
        .filter((file) => viewedFiles.get(file.reviewKey) === file.patchHash)
        .map((file) => file.reviewKey),
      pendingAgentTurnIds: [...pendingRuns.keys()],
      updateState: updateState["_tag"],
    }),
    getActionLog: () => [...actions],
  }

  const api: DiffDashApi = {
    analytics: {
      start: async () => record("analytics.start"),
      capture: async (event) => record("analytics.capture", { event: event.event }),
    },
    updates: {
      getState: async () => updateState,
      check: async () => record("updates.check"),
      download: async () => {
        record("updates.download")
        setUpdateState(
          AppUpdateDownloading.make({
            currentVersion: scenario.manifest.appVersion.replace(/^v/, ""),
            version: "0.4.4",
            percent: 62,
          }),
        )
      },
      restartAndInstall: async () => record("updates.restartAndInstall"),
      onStateChanged: (listener) => listenerSubscription(updateListeners, listener),
    },
    navigation: {
      drainCommands: async () => navigationCommands.splice(0, navigationCommands.length),
      onCommandsAvailable: (listener) => {
        const unsubscribe = listenerSubscription(navigationListeners, listener)
        if (navigationCommands.length > 0) queueMicrotask(listener)
        return unsubscribe
      },
    },
    diagnostics: async () => diagnostics,
    agentProviders: {
      getCatalog: async () =>
        AgentProviderCatalog.make({
          providers: [
            demoAgentProvider("claude", "Claude", "claude-sonnet-5", "Sonnet 5.0", "best"),
            demoAgentProvider(
              "codex",
              "Codex",
              "gpt-5.3-codex-spark",
              "GPT 5.3 Codex Spark",
              "balanced",
            ),
            demoAgentProvider("opencode", "OpenCode", "opencode-gpt-5.3", "GPT 5.3", "balanced"),
          ],
          autoCandidates: AgentProviderAutoCandidates.make({
            walkthrough: [
              AgentProviderId.make("claude"),
              AgentProviderId.make("codex"),
              AgentProviderId.make("opencode"),
            ],
            reviewThread: [
              AgentProviderId.make("codex"),
              AgentProviderId.make("claude"),
              AgentProviderId.make("opencode"),
            ],
          }),
        }),
    },
    installDiffDashCli: async () => {
      record("app.installDiffDashCli")
      return DiffDashCliInstallResult.make({
        path: "/usr/local/bin/diffdash",
        pathSetupCommand: null,
      })
    },
    openExternalUrl: async (url) => record("app.openExternalUrl", { url }),
    openRepositoryFile: async (request) => {
      requireReview(
        request.review.repository.namespace,
        request.review.repository.name,
        request.review.number,
      )
      record("app.openRepositoryFile", {
        filePath: request.filePath,
        headRefName: request.headRefName,
        headRefOid: request.headRevision,
      })
    },
    openLocalRepositoryFile: async (rootPath, filePath) =>
      record("app.openLocalRepositoryFile", { rootPath, filePath }),
    repositories: {
      list: async (query) => {
        const normalized = query?.trim().toLowerCase() ?? ""
        return normalized.length === 0
          ? repositories
          : repositories.filter((repo) =>
              `${repo.owner}/${repo.name}`.toLowerCase().includes(normalized),
            )
      },
      setFavorite: async (id, isFavorite) => {
        const current = repositories.find((repo) => repo.id === id)
        if (current === undefined) throw new Error(`Unknown demo repository: ${id}`)
        const updated = Repo.make({ ...current, isFavorite })
        repositories = repositories.map((repo) => (repo.id === id ? updated : repo))
        record("repositories.setFavorite", { id, isFavorite })
        return updated
      },
      favoriteRemote: async (remote) => {
        const favorite = Repo.make({
          id: `${remote.locator.providerId}:${remote.locator.namespace}/${remote.locator.name}`,
          provider: remote.locator.providerId,
          owner: remote.locator.namespace,
          name: remote.locator.name,
          remoteUrl: remote.url,
          localPath: null,
          isFavorite: true,
          lastOpenedAt: null,
          lastSyncedAt: remote.updatedAt,
          createdAt: scenario.manifest.repository.createdAt,
          updatedAt: remote.updatedAt ?? scenario.manifest.repository.createdAt,
        })
        repositories = [...repositories.filter((repo) => repo.id !== favorite.id), favorite]
        record("repositories.favoriteRemote", { id: favorite.id })
        return favorite
      },
      install: async (localPath) => linkLocalPath(localPath),
      link: async (input) => {
        requireReview(
          input.repository.namespace,
          input.repository.name,
          scenario.manifest.pullRequest.number,
        )
        return linkLocalPath(input.localPath)
      },
      selectLocalFolder: async () => null,
    },
    reviewThreads: {
      list: async (target) => {
        requireTarget(target)
        return [...threadDetails.values()].map((details) => details.thread)
      },
      create: async (input) => {
        requireTarget(input.target)
        const id = ReviewThreadId.make(`thread-captured-${createdThreadCounter}`)
        createdThreadCounter += 1
        const now = `2026-07-10T09:${String(createdThreadCounter).padStart(2, "0")}:00Z`
        const details = ReviewThreadDetails.make({
          thread: ReviewThread.make({
            id,
            repoId: scenario.repository.id,
            reviewKey: scenario.reviewKey,
            prNumber: input.target.kind === "hosted" ? input.target.review.number : null,
            baseRevision: input.expectedBaseRevision,
            headRevision: input.expectedHeadRevision,
            currentBaseRevision: input.expectedBaseRevision,
            currentHeadRevision: input.expectedHeadRevision,
            originalAnchor: input.anchor,
            currentAnchor: input.anchor,
            anchorStatus: "active",
            createdAt: now,
            updatedAt: now,
          }),
          messages: [
            ReviewThreadMessage.make({
              id: ReviewThreadMessageId.make(`message-captured-${createdMessageCounter}`),
              threadId: id,
              sequence: 0,
              author: "user",
              bodyMarkdown: input.bodyMarkdown,
              status: "complete",
              agentRunId: null,
              createdAt: now,
              updatedAt: now,
            }),
          ],
        })
        createdMessageCounter += 1
        record("reviewThreads.create", { threadId: id })
        return replaceThread(details)
      },
      addUserMessage: async (input) => {
        const current = requireThread(input.threadId)
        const sourceMessage = scenario.threads
          .flatMap((details) => details.messages)
          .find(
            (message) => message.author === "user" && message.sequence === current.messages.length,
          )
        const now = sourceMessage?.createdAt ?? current.thread.updatedAt
        const message = ReviewThreadMessage.make({
          id: ReviewThreadMessageId.make(
            sourceMessage?.id ?? `message-captured-${createdMessageCounter}`,
          ),
          threadId: input.threadId,
          sequence: current.messages.length,
          author: "user",
          bodyMarkdown: input.bodyMarkdown,
          status: "complete",
          agentRunId: null,
          createdAt: now,
          updatedAt: now,
        })
        createdMessageCounter += 1
        record("reviewThreads.addUserMessage", { threadId: input.threadId })
        return replaceThread(
          ReviewThreadDetails.make({
            thread: ReviewThread.make({ ...current.thread, updatedAt: now }),
            messages: [...current.messages, message],
          }),
        )
      },
      get: async (threadId) => requireThread(threadId),
      runAgent: async (input) => {
        requireTarget(input.target)
        const current = requireThread(input.threadId)
        const completedAgentTurns = current.messages.filter(
          (message) => message.author === "agent" && message.status === "complete",
        ).length
        const turns = Object.entries(scenario.agentTurns)
        const selected = turns[completedAgentTurns] ?? turns.at(-1)
        if (selected === undefined) throw new Error("Demo scenario has no scripted agent turns")
        const [turnId, turn] = selected
        if (pendingRuns.has(turnId)) throw new Error(`Agent turn ${turnId} is already pending`)
        const sourceMessage = scenario.threads
          .flatMap((details) => details.messages)
          .find((message) => message.bodyMarkdown === turn.response.bodyMarkdown)
        const messageId = ReviewThreadMessageId.make(
          sourceMessage?.id ?? `message-captured-${createdMessageCounter}`,
        )
        createdMessageCounter += 1
        const pendingMessage = ReviewThreadMessage.make({
          id: messageId,
          threadId: input.threadId,
          sequence: current.messages.length,
          author: "agent",
          bodyMarkdown: MarkdownBody.make(""),
          status: "pending",
          agentRunId: sourceMessage?.agentRunId ?? `run-captured-${createdMessageCounter}`,
          createdAt: sourceMessage?.createdAt ?? current.thread.updatedAt,
          updatedAt: sourceMessage?.createdAt ?? current.thread.updatedAt,
        })
        replaceThread(
          ReviewThreadDetails.make({
            thread: current.thread,
            messages: [...current.messages, pendingMessage],
          }),
        )
        const firstProgress = turn.progress[0]
        if (firstProgress !== undefined) {
          const event = ReviewAgentProgress.make({
            threadId: input.threadId,
            stage: firstProgress.event.stage,
          })
          for (const listener of progressListeners) listener(event)
        }
        record("reviewThreads.runAgent", { threadId: input.threadId, turnId })
        return new Promise<ReviewThreadDetails>((resolve, reject) => {
          pendingRuns.set(turnId, { turnId, threadId: input.threadId, resolve, reject })
        })
      },
      onAgentProgress: (listener) => listenerSubscription(progressListeners, listener),
    },
    settings: {
      get: async () => settings,
      update: async (next) => {
        settings = cloneSettings(next)
        record("settings.update", { provider: next.routes.walkthrough })
        return settings
      },
    },
    appState: {
      get: async () => appState,
      update: async (next) => {
        appState = AppState.make(next)
        record("appState.update", { onboardingCompleted: next.onboardingCompleted })
        return appState
      },
    },
    providers: { list: async () => [provider] },
    hostedRepositories: {
      searchRepositories: async (request) => {
        const matchesQuery = `${scenario.repository.owner}/${scenario.repository.name}`
          .toLowerCase()
          .includes(request.query.trim().toLowerCase())
        const matchesOwner =
          request.namespaces.length === 0 || request.namespaces.includes(scenario.repository.owner)
        return matchesQuery && matchesOwner
          ? [
              HostedRepository.make({
                locator: makeHostedRepositoryLocator(
                  provider.id,
                  scenario.repository.owner,
                  scenario.repository.name,
                ),
                url: scenario.repository.remoteUrl,
                description: scenario.manifest.repository.description,
                isPrivate: false,
                updatedAt: currentRevision.detail.summary.updatedAt,
              }),
            ]
          : []
      },
      listSearchScopes: async () => scenario.searchScopes,
    },
    hostedReviews: {
      list: async (request) => {
        requireReview(
          request.repository.namespace,
          request.repository.name,
          scenario.manifest.pullRequest.number,
        )
        return [pullRequestSummary(currentRevision)]
      },
      listAssigned: async () => [pullRequestSummary(currentRevision)],
      getDecision: async (request) => {
        requireReview(
          request.review.repository.namespace,
          request.review.repository.name,
          request.review.number,
        )
        return approved ? "approved" : "none"
      },
      submitDecision: async (request) => {
        const { namespace: owner, name } = request.review.repository
        const { number } = request.review
        requireReview(owner, name, number)
        approved = true
        record("gitProvider.submitReviewDecision", { owner, name, number })
      },
    },
    localReviews: {
      resolveBranch: async (localPath, branchName) =>
        LocalReviewTarget.make({
          kind: "local",
          rootPath: localPath,
          comparison: BranchComparison.make({
            branchName: branchName ?? "main",
            baseRef: `refs/remotes/origin/${branchName ?? "main"}`,
            baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          }),
        }),
    },
    reviewSnapshots: {
      acquireHosted: async (request) => {
        requireReview(
          request.review.repository.namespace,
          request.review.repository.name,
          request.review.number,
        )
        snapshotCache.set(currentRevision.snapshot.snapshotId, currentRevision.snapshot)
        return makeReviewSnapshotManifest(currentRevision.snapshot)
      },
      acquireLocal: async (target) => {
        const detail = LocalReviewDetail.make({
          ...localReviewDetail(target.rootPath, currentRevision),
          title:
            target.comparison["_tag"] === "workingTree"
              ? "Local changes"
              : `Changes vs ${target.comparison.branchName}`,
          comparison: target.comparison,
        })
        const diff = LocalReviewDiff.make({
          ...localReviewDiff(target.rootPath, currentRevision),
          comparison: target.comparison,
        })
        const reviewKey = ReviewKey.make(`local:${target.rootPath}`)
        const baseRevision = ReviewRevision.make(diff.baseSha)
        const headRevision = ReviewRevision.make(diff.headSha)
        const snapshot = LocalReviewSnapshot.make({
          snapshotId: makeReviewSnapshotId({
            reviewKey,
            baseRevision,
            headRevision,
            diffIdentity: ReviewDiffIdentity.make(diff.diffHash),
          }),
          reviewKey,
          baseRevision,
          headRevision,
          detail,
          diff,
          parsedDiff: parseUnifiedDiff(diff.diff),
        })
        snapshotCache.set(snapshot.snapshotId, snapshot)
        return makeReviewSnapshotManifest(snapshot)
      },
      getPage: async (request) => {
        const snapshot = snapshotCache.get(request.snapshotId)
        if (snapshot === undefined) {
          return ReviewSnapshotExpired.make({
            snapshotId: request.snapshotId,
            reason: "evicted",
          })
        }
        const files =
          request.fileIds.length === 0
            ? snapshot.parsedDiff.files
            : request.fileIds.flatMap((fileId) => {
                const file = snapshot.parsedDiff.files.find(
                  (candidate) => candidate.fileId === fileId,
                )
                return file === undefined ? [] : [file]
              })
        if (request.fileIds.length > 0 && files.length !== request.fileIds.length) {
          return ReviewSnapshotExpired.make({
            snapshotId: request.snapshotId,
            reason: "mismatched",
          })
        }
        const cursorMatch =
          request.cursor === null ? null : /^page:v1:([0-9]+):00000000$/.exec(request.cursor)
        if (request.cursor !== null && cursorMatch === null) {
          return ReviewSnapshotExpired.make({
            snapshotId: request.snapshotId,
            reason: "mismatched",
          })
        }
        const offset = cursorMatch === null ? 0 : Number(cursorMatch[1])
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > files.length) {
          return ReviewSnapshotExpired.make({
            snapshotId: request.snapshotId,
            reason: "mismatched",
          })
        }
        const nextOffset = Math.min(files.length, offset + REVIEW_SNAPSHOT_PAGE_FILE_LIMIT)
        return ReviewSnapshotPageAvailable.make({
          snapshotId: request.snapshotId,
          files: files.slice(offset, nextOffset),
          nextCursor:
            nextOffset < files.length
              ? ReviewSnapshotPageCursor.make(`page:v1:${nextOffset}:00000000`)
              : null,
        })
      },
      search: async (request) => {
        const snapshot = snapshotCache.get(request.snapshotId)
        if (snapshot === undefined || request.cursor !== null) {
          return ReviewSnapshotExpired.make({
            snapshotId: request.snapshotId,
            reason: snapshot === undefined ? "evicted" : "mismatched",
          })
        }
        const matches = searchSnapshot(snapshot, request.query)
        return ReviewSnapshotSearchAvailable.make({
          snapshotId: request.snapshotId,
          matches: matches.slice(0, request.limit),
          totalMatches: matches.length,
          nextCursor: null,
        })
      },
    },
    viewedFiles: {
      list: async (request) => {
        requireReview(
          request.review.repository.namespace,
          request.review.repository.name,
          request.review.number,
        )
        if (request.baseRefName !== currentRevision.detail.summary.base.name) return []
        return [...viewedFiles].map(([reviewKey, patchHash]) => ({ reviewKey, patchHash }))
      },
      set: async (request) => {
        requireReview(
          request.review.repository.namespace,
          request.review.repository.name,
          request.review.number,
        )
        if (request.baseRefName !== currentRevision.detail.summary.base.name) {
          throw new Error(`Viewed-file base ${request.baseRefName} is not current`)
        }
        if (request.viewed) viewedFiles.set(request.reviewKey, request.patchHash)
        else viewedFiles.delete(request.reviewKey)
        record("viewedFiles.set", {
          reviewKey: request.reviewKey,
          viewed: request.viewed,
        })
      },
      listLocal: async () =>
        [...viewedFiles].map(([reviewKey, patchHash]) => ({ reviewKey, patchHash })),
      setLocal: async (request) => {
        if (request.viewed) viewedFiles.set(request.reviewKey, request.patchHash)
        else viewedFiles.delete(request.reviewKey)
        record("viewedFiles.setLocal", {
          reviewKey: request.reviewKey,
          viewed: request.viewed,
        })
      },
    },
    walkthroughs: {
      get: async (request) => {
        requireReview(
          request.review.repository.namespace,
          request.review.repository.name,
          request.review.number,
        )
        return request.baseRevision === currentRevision.snapshot.baseRevision &&
          request.headRevision === currentRevision.snapshot.headRevision
          ? currentRevision.walkthrough
          : null
      },
      generate: async (request) => {
        const { number } = request.review
        requireReview(request.review.repository.namespace, request.review.repository.name, number)
        record(request.regenerate ? "walkthroughs.regenerate" : "walkthroughs.generate", { number })
        return currentRevision.walkthrough
      },
    },
    localWalkthroughs: {
      get: async (_rootPath, baseSha, headSha) =>
        baseSha === currentRevision.snapshot.baseRevision &&
        headSha === currentRevision.snapshot.headRevision
          ? localStoredWalkthrough(currentRevision)
          : null,
      generate: async () => localStoredWalkthrough(currentRevision),
      regenerate: async () => localStoredWalkthrough(currentRevision),
    },
  }

  function linkLocalPath(localPath: string) {
    const linked = Repo.make({ ...scenario.repository, localPath })
    repositories = repositories.map((repo) => (repo.id === linked.id ? linked : repo))
    record("repositories.link", { localPath })
    return linked
  }

  resetState()
  return { api, timeline }
}

const demoAgentProvider = (
  id: string,
  displayName: string,
  modelId: string,
  modelDisplayName: string,
  quality: "fast" | "balanced" | "best",
) =>
  AgentProviderStatus.make({
    id: AgentProviderId.make(id),
    displayName,
    description: `${displayName} demo runtime`,
    homepage: null,
    capabilities: [
      AgentProviderCapabilityStatus.make({
        capability: "walkthrough",
        status: "ready",
        runtimeVersion: "demo",
        reason: null,
      }),
      AgentProviderCapabilityStatus.make({
        capability: "review-thread",
        status: "ready",
        runtimeVersion: "demo",
        reason: null,
      }),
    ],
    models: [
      AgentProviderModel.make({
        id: AgentModelId.make(modelId),
        displayName: modelDisplayName,
        capabilities: ["walkthrough", "review-thread"],
        quality,
      }),
    ],
    defaults: AgentProviderDefaults.make({
      walkthroughModel: AgentModelId.make(modelId),
      reviewThreadModel: AgentModelId.make(modelId),
    }),
    setup: [],
  })

const readyDemoPrerequisites = () =>
  AppPrerequisites.make({
    gitInstalled: true,
    ghInstalled: true,
    ghVersion: "2.74.1",
    ghSearchRepositoriesAvailable: true,
    ghSupported: true,
    ghAuthenticated: true,
    codingAgentInstalled: true,
    installedCodingAgents: ["codex", "claude", "opencode"],
    diffDashCliInstalled: true,
    diffDashCliInPath: true,
    diffDashCliPath: "/usr/local/bin/diffdash",
    checkedAt: "2026-07-10T08:36:19Z",
  })

const listenerSubscription = <A>(
  listeners: Set<(value: A) => void>,
  listener: (value: A) => void,
) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const cloneSettings = (settings: AISettings) =>
  AISettings.make({
    ...settings,
    routes: { ...settings.routes },
    models: { ...settings.models },
  })

const pullRequestSummary = (revision: MaterializedDemoRevision) => revision.detail.summary

const localReviewDetail = (rootPath: string, revision: MaterializedDemoRevision) =>
  LocalReviewDetail.make({
    rootPath,
    repoName: revision.detail.summary.locator.repository.name,
    branchName: revision.detail.summary.head.name,
    baseSha: revision.snapshot.baseRevision,
    headSha: revision.snapshot.headRevision,
    diffHash: revision.snapshot.headRevision,
    title: "Local changes",
    files: revision.detail.files,
    fetchedAt: revision.diff.fetchedAt,
  })

const localReviewDiff = (rootPath: string, revision: MaterializedDemoRevision) =>
  LocalReviewDiff.make({
    rootPath,
    baseSha: revision.snapshot.baseRevision,
    headSha: revision.snapshot.headRevision,
    diffHash: revision.snapshot.headRevision,
    diff: revision.diff.diff,
    fetchedAt: revision.diff.fetchedAt,
  })

const localStoredWalkthrough = (revision: MaterializedDemoRevision) =>
  StoredWalkthrough.make({
    ...revision.walkthrough,
    repoId: `local:${revision.detail.summary.locator.repository.name}`,
    prNumber: null,
    reviewKey: `local:${revision.detail.summary.locator.repository.name}`,
  })

const searchSnapshot = (snapshot: ReviewSnapshot, query: string) => {
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu")
  const matches: ReviewSnapshotSearchMatch[] = []
  for (const file of snapshot.parsedDiff.files) {
    for (const hunk of file.hunks) {
      for (const line of projectDiffHunkLines(hunk)) {
        if (line.kind === "metadata") continue
        expression.lastIndex = 0
        for (
          let match = expression.exec(line.content);
          match !== null;
          match = expression.exec(line.content)
        ) {
          matches.push(
            ReviewSnapshotSearchMatch.make({
              id: `${file.fileId}:${hunk.id}:${line.index}:${match.index}`,
              fileId: file.fileId,
              filePath: file.path,
              reviewKey: file.reviewKey,
              hunkId: hunk.id,
              hunkLineIndex: line.index,
              newLineNumber: line.newLineNumber,
              oldLineNumber: line.oldLineNumber,
              side:
                line.kind === "context"
                  ? "context"
                  : line.kind === "deletion"
                    ? "deletions"
                    : "additions",
              text: line.content,
              start: match.index,
              end: match.index + match[0].length,
            }),
          )
        }
      }
    }
  }
  return matches
}
