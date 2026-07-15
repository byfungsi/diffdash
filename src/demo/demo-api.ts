import { AIProviderModels, AISettings, DEFAULT_AI_SETTINGS } from "../shared/ai-settings"
import { AppState } from "../shared/app-state"
import {
  AppUpdateAvailable,
  AppUpdateDownloaded,
  AppUpdateDownloading,
  AppUpdateUnsupported,
  type AppUpdateState,
} from "../shared/app-update"
import type { DiffDashApi } from "../shared/diffdash-api"
import { parseUnifiedDiff } from "../shared/diff-parser"
import { LocalReviewDetail, LocalReviewDiff, Repo, RepositorySearchResult } from "../shared/domain"
import { BranchComparison, LocalReviewTarget } from "../shared/local-review"
import { AppPrerequisites, DiffDashCliInstallResult } from "../shared/prerequisites"
import { ReviewAgentProgress } from "../shared/review-agent"
import { LocalReviewSnapshot } from "../shared/review-context"
import { ReviewKey, ReviewRevision } from "../shared/review-identity"
import {
  MarkdownBody,
  ReviewThread,
  ReviewThreadDetails,
  ReviewThreadId,
  ReviewThreadMessage,
  ReviewThreadMessageId,
  type ReviewThreadTarget,
} from "../shared/review-thread"
import { StoredWalkthrough } from "../shared/walkthrough"
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
  const actions: DemoAction[] = []
  const pendingRuns = new Map<string, PendingAgentRun>()
  let repositories: Repo[] = []
  let currentRevision = firstRevision
  let approved = false
  let viewedFileKeys = new Set<string>()
  let settings = cloneSettings(DEFAULT_AI_SETTINGS)
  let appState = AppState.make({ onboardingCompleted: true })
  let updateState: AppUpdateState = AppUpdateUnsupported.make({
    currentVersion: scenario.manifest.appVersion.replace(/^v/, ""),
    reason: "development",
  })
  let threadDetails = new Map<ReviewThreadId, ReviewThreadDetails>()
  let createdThreadCounter = 0
  let createdMessageCounter = 0

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
    repositories = [scenario.repository]
    approved = false
    settings = cloneSettings(DEFAULT_AI_SETTINGS)
    appState = AppState.make({ onboardingCompleted: true })
    updateState = AppUpdateUnsupported.make({
      currentVersion: scenario.manifest.appVersion.replace(/^v/, ""),
      reason: "development",
    })
    viewedFileKeys = new Set(
      currentRevision.parsedDiff.files
        .filter((file) => scenario.manifest.initiallyViewedFilePaths.includes(file.path))
        .map((file) => file.reviewKey),
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
  }

  const setUpdateState = (state: AppUpdateState) => {
    updateState = state
    for (const listener of updateListeners) listener(state)
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
    requireReview(target.owner, target.name, target.number)
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
        viewedFileKeys.clear()
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
            version: "0.2.2",
          }),
        )
        return
      }
      if (checkpointId === "update-downloaded") {
        setUpdateState(
          AppUpdateDownloaded.make({
            currentVersion: scenario.manifest.appVersion.replace(/^v/, ""),
            version: "0.2.2",
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
      viewedFileKeys: [...viewedFileKeys],
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
            version: "0.2.2",
            percent: 62,
          }),
        )
      },
      restartAndInstall: async () => record("updates.restartAndInstall"),
      onStateChanged: (listener) => listenerSubscription(updateListeners, listener),
    },
    navigation: {
      drainCommands: async () => [],
      onCommandsAvailable: () => () => undefined,
    },
    diagnostics: async () =>
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
      }),
    installDiffDashCli: async () => {
      record("app.installDiffDashCli")
      return DiffDashCliInstallResult.make({
        path: "/usr/local/bin/diffdash",
        pathSetupCommand: null,
      })
    },
    openExternalUrl: async (url) => record("app.openExternalUrl", { url }),
    openRepositoryFile: async (owner, name, filePath, headRefName, headRefOid) => {
      requireReview(owner, name, scenario.manifest.pullRequest.number)
      record("app.openRepositoryFile", { filePath, headRefName, headRefOid })
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
          id: `github:${remote.owner}/${remote.name}`,
          provider: "github",
          owner: remote.owner,
          name: remote.name,
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
      addLocal: async (localPath) => linkLocalPath(localPath),
      install: async (localPath) => linkLocalPath(localPath),
      link: async (input) => {
        requireReview(input.owner, input.name, scenario.manifest.pullRequest.number)
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
            prNumber: input.target.kind === "pullRequest" ? input.target.number : null,
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
        record("settings.update", { provider: next.provider })
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
    gitProvider: {
      searchRepositories: async (request) => {
        const matchesQuery = `${scenario.repository.owner}/${scenario.repository.name}`
          .toLowerCase()
          .includes(request.query.trim().toLowerCase())
        const matchesOwner =
          request.owners.length === 0 || request.owners.includes(scenario.repository.owner)
        return matchesQuery && matchesOwner
          ? [
              RepositorySearchResult.make({
                owner: scenario.repository.owner,
                name: scenario.repository.name,
                nameWithOwner: `${scenario.repository.owner}/${scenario.repository.name}`,
                url: scenario.repository.remoteUrl,
                description: scenario.manifest.repository.description,
                isPrivate: false,
                updatedAt: currentRevision.detail.updatedAt,
              }),
            ]
          : []
      },
      listSearchScopes: async () => scenario.searchScopes,
      listPullRequests: async (owner, name) => {
        requireReview(owner, name, scenario.manifest.pullRequest.number)
        return [pullRequestSummary(currentRevision)]
      },
      listReviewRequests: async () => [pullRequestSummary(currentRevision)],
      getPullRequestDetail: async (owner, name, number) => {
        requireReview(owner, name, number)
        return currentRevision.detail
      },
      refreshPullRequestDetail: async (owner, name, number) => {
        requireReview(owner, name, number)
        record("gitProvider.refreshPullRequestDetail", { owner, name, number })
        return currentRevision.detail
      },
      getPullRequestDiff: async (owner, name, number) => {
        requireReview(owner, name, number)
        return currentRevision.diff
      },
      hasApprovedPullRequest: async (owner, name, number) => {
        requireReview(owner, name, number)
        return approved
      },
      approvePullRequest: async (owner, name, number) => {
        requireReview(owner, name, number)
        approved = true
        record("gitProvider.approvePullRequest", { owner, name, number })
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
      getDetail: async (target) => localReviewDetail(target.rootPath, currentRevision),
      getDiff: async (target) => localReviewDiff(target.rootPath, currentRevision),
      getSnapshot: async (target) => {
        const detail = LocalReviewDetail.make({
          ...localReviewDetail(target.rootPath, currentRevision),
          comparison: target.comparison,
        })
        const diff = LocalReviewDiff.make({
          ...localReviewDiff(target.rootPath, currentRevision),
          comparison: target.comparison,
        })
        return LocalReviewSnapshot.make({
          reviewKey: ReviewKey.make(`local:${target.rootPath}`),
          baseRevision: ReviewRevision.make(diff.baseSha),
          headRevision: ReviewRevision.make(diff.headSha),
          detail,
          diff,
          parsedDiff: parseUnifiedDiff(diff.diff),
        })
      },
    },
    viewedFiles: {
      list: async (owner, name, number, headSha) => {
        requireReview(owner, name, number)
        if (headSha !== currentRevision.snapshot.headRevision) return []
        return [...viewedFileKeys]
      },
      set: async (owner, name, number, headSha, reviewKey, filePath, viewed) => {
        requireReview(owner, name, number)
        if (headSha !== currentRevision.snapshot.headRevision) {
          throw new Error(`Viewed-file head ${headSha} is not current`)
        }
        if (viewed) viewedFileKeys.add(reviewKey)
        else viewedFileKeys.delete(reviewKey)
        record("viewedFiles.set", { reviewKey, filePath, viewed })
      },
      listLocal: async (_rootPath, headSha) =>
        headSha === currentRevision.snapshot.headRevision ? [...viewedFileKeys] : [],
      setLocal: async (_rootPath, headSha, reviewKey, filePath, viewed) => {
        if (headSha !== currentRevision.snapshot.headRevision) {
          throw new Error(`Viewed-file head ${headSha} is not current`)
        }
        if (viewed) viewedFileKeys.add(reviewKey)
        else viewedFileKeys.delete(reviewKey)
        record("viewedFiles.setLocal", { reviewKey, filePath, viewed })
      },
    },
    walkthroughs: {
      get: async (owner, name, number, baseSha, headSha) => {
        requireReview(owner, name, number)
        return baseSha === currentRevision.snapshot.baseRevision &&
          headSha === currentRevision.snapshot.headRevision
          ? currentRevision.walkthrough
          : null
      },
      generate: async (owner, name, number) => {
        requireReview(owner, name, number)
        record("walkthroughs.generate", { number })
        return currentRevision.walkthrough
      },
      regenerate: async (owner, name, number) => {
        requireReview(owner, name, number)
        record("walkthroughs.regenerate", { number })
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

const listenerSubscription = <A>(
  listeners: Set<(value: A) => void>,
  listener: (value: A) => void,
) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const cloneSettings = (settings: AISettings) =>
  AISettings.make({
    appearance: settings.appearance,
    provider: settings.provider,
    telemetryEnabled: settings.telemetryEnabled,
    models: AIProviderModels.make({
      auto: settings.models.auto,
      codex: settings.models.codex,
      claude: settings.models.claude,
      opencode: settings.models.opencode,
    }),
  })

const pullRequestSummary = (revision: MaterializedDemoRevision) => {
  const { files: _files, commits: _commits, ...summary } = revision.detail
  return summary
}

const localReviewDetail = (rootPath: string, revision: MaterializedDemoRevision) =>
  LocalReviewDetail.make({
    rootPath,
    repoName: revision.detail.repoName,
    branchName: revision.detail.headRefName,
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
    repoId: `local:${revision.detail.repoName}`,
    prNumber: null,
    reviewKey: `local:${revision.detail.repoName}`,
  })
