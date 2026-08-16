import {
  AIAgentSelection,
  AISettings,
  CodeThemePreferences,
  DEFAULT_AI_SETTINGS,
  ThemePreferences,
} from "@diffdash/domain/ai-settings"
import {
  RendererLayoutSettings,
  ReviewPaneSettings,
} from "@diffdash/domain/renderer-layout-settings"
import { AppState } from "@diffdash/domain/app-state"
import {
  GitProviderCapabilities,
  GitProviderDescriptor,
  GitProviderId,
  GitProviderKind,
  GitProviderTerminology,
  HostedRepository,
  HostedRepositorySource,
  makeHostedRepositoryLocator,
  sameHostedRepository,
} from "@diffdash/domain/git-provider"
import { localReviewTargetKey, type LocalReviewTarget } from "@diffdash/domain/local-review"
import {
  ProjectOpened,
  ProjectWorkspaceState,
  type ProjectWorkspaceStateInput,
} from "@diffdash/domain/project-workspace"
import {
  LinkedCheckout,
  RemoteOnly,
  Repo,
  RepositoryCheckoutPath,
  RepositoryIdentityRepairSummary,
} from "@diffdash/domain/repository"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import {
  AgentRunId,
  ReviewAgentProgress,
  ReviewAgentProviderId,
} from "@diffdash/domain/review-agent"
import { AgentPromptVersion, CompletedAgentRun, RunningAgentRun } from "@diffdash/domain/agent-run"
import type { ReviewSnapshotManifest } from "@diffdash/domain/review-context"
import {
  ReviewProjectId,
  type ReviewFilePatchHash,
  type ReviewKey,
} from "@diffdash/domain/review-identity"
import {
  CurrentReviewAnchor,
  CompletedAgentReviewThreadMessage,
  CompletedAgentReviewTurn,
  MarkdownBody,
  PendingAgentReviewThreadMessage,
  PendingAgentReviewTurn,
  ReviewThread,
  ReviewThreadDetails,
  ReviewThreadId,
  ReviewThreadMessageId,
  UserReviewThreadMessage,
  UserReviewTurn,
  type ReviewThreadTarget,
} from "@diffdash/domain/review-thread"
import { WebUrl } from "@diffdash/domain/web-url"
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
import {
  AppPrerequisites,
  CodingAgentName,
  DiffDashCliInstallResult,
} from "@diffdash/protocol/prerequisites"
import { ExecutablePath } from "@diffdash/domain/executable-path"
import {
  DisposedReviewSession,
  ReadyReviewSession,
  ReviewSessionId,
  ReviewSessionIdentity,
  ReviewSessionProcessId,
  ReviewSessionSearchPublication,
  ReviewSessionStateVersion,
} from "@diffdash/protocol/review-session"
import type { MaterializedDemoScenario } from "./demo-scenario"
import { createDemoLocalReviewFixtures, type DemoLocalReviewFixture } from "./local-review-fixtures"

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
  const localReviewFixtures = createDemoLocalReviewFixtures(scenario)
  const localFixtureByTarget = new Map(
    localReviewFixtures.map((fixture) => [localReviewTargetKey(fixture.target), fixture]),
  )

  const progressListeners = new Set<(progress: ReviewAgentProgress) => void>()
  const updateListeners = new Set<(state: AppUpdateState) => void>()
  const navigationListeners = new Set<() => void>()
  const actions: DemoAction[] = []
  const pendingRuns = new Map<string, PendingAgentRun>()
  const manifestCache = new Map<string, ReviewSnapshotManifest>()
  const projectWorkspaceStates = new Map<ReviewProjectId, ProjectWorkspaceState>()
  let repositories: Repo[] = []
  let currentRevision = firstRevision
  let approved = false
  let hostedViewedFiles = new Map<ReviewKey, ReviewFilePatchHash>()
  let localViewedFiles = new Map<string, Map<ReviewKey, ReviewFilePatchHash>>()
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
    manifestCache.clear()
    projectWorkspaceStates.clear()
    manifestCache.set(currentRevision.manifest.snapshotId, currentRevision.manifest)
    repositories = [scenario.repository]
    approved = false
    settings = cloneSettings(DEFAULT_AI_SETTINGS)
    appState = AppState.make({ onboardingCompleted: true })
    updateState = AppUpdateUnsupported.make({
      currentVersion: scenario.manifest.appVersion.replace(/^v/, ""),
      reason: "development",
    })
    hostedViewedFiles = new Map(
      currentRevision.parsedDiff.files
        .filter((file) => scenario.manifest.initiallyViewedFilePaths.includes(file.path))
        .map((file) => [file.reviewKey, file.patchHash]),
    )
    localViewedFiles = new Map(
      localReviewFixtures.map((fixture) => [
        localReviewTargetKey(fixture.target),
        new Map(
          fixture.parsedDiff.files
            .filter((file) => fixture.initiallyViewedFileKeys.includes(file.reviewKey))
            .map((file) => [file.reviewKey, file.patchHash]),
        ),
      ]),
    )
    threadDetails = new Map([
      ...scenario.threads.map((details) => {
        const initialConversation = details.conversation.filter(
          (turn) => turn.message.sequence <= 1,
        )
        return [
          details.thread.id,
          ReviewThreadDetails.make({
            thread: ReviewThread.make({
              ...details.thread,
              currentBaseRevision: firstRevision.manifest.baseRevision,
              currentHeadRevision: firstRevision.manifest.headRevision,
              currentAnchor: CurrentReviewAnchor.cases.Active.make({
                anchor: details.thread.originalAnchor,
              }),
              updatedAt: initialConversation.at(-1)?.message.updatedAt ?? details.thread.createdAt,
            }),
            conversation: initialConversation,
          }),
        ] as const
      }),
      ...localReviewFixtures.flatMap((fixture) =>
        fixture.threads.map((details) => [details.thread.id, details] as const),
      ),
    ])
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
      owner !== scenario.manifest.repository.owner ||
      name !== scenario.manifest.repository.name ||
      number !== scenario.manifest.pullRequest.number
    ) {
      throw new Error(`Unknown demo pull request: ${owner}/${name}#${number}`)
    }
  }

  const requireTarget = (target: ReviewThreadTarget) => {
    if (target.kind === "local") return requireLocalFixture(target)
    if (target.kind === "repositoryComparison") {
      throw new Error("Repository comparisons are unavailable in the demo runtime")
    }
    requireReview(
      target.review.repository.namespace,
      target.review.repository.name,
      target.review.number,
    )
    return null
  }

  const requireLocalFixture = (target: LocalReviewTarget): DemoLocalReviewFixture => {
    const fixture = localFixtureByTarget.get(localReviewTargetKey(target))
    if (fixture === undefined) throw new Error("Unknown demo local review target")
    return fixture
  }

  const targetReviewKey = (target: ReviewThreadTarget) =>
    target.kind === "hosted"
      ? scenario.reviewKey
      : target.kind === "local"
        ? requireLocalFixture(target).manifest.reviewKey
        : (() => {
            throw new Error("Repository comparisons are unavailable in the demo runtime")
          })()

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
        manifestCache.set(currentRevision.manifest.snapshotId, currentRevision.manifest)
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
              }),
              conversation: current.conversation,
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
          OpenWorkingTreeCommand.make({
            localPath: RepositoryCheckoutPath.make("/Users/demo/emberline-dispatch"),
          }),
        )
        return
      }
      if (checkpointId === "navigation-branch-diff") {
        enqueueNavigation(
          OpenBranchDiffCommand.make({
            localPath: RepositoryCheckoutPath.make("/Users/demo/emberline-dispatch"),
            branchName: RepositoryComparisonRef.make("dev"),
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
      const sourceTurn = scenario.threads
        .flatMap((details) => details.conversation)
        .find(
          (entry) =>
            entry._tag === "Completed" && entry.message.bodyMarkdown === turn.response.bodyMarkdown,
        )
      const pendingTurn = current.conversation.find((entry) => entry._tag === "Pending")
      if (pendingTurn?._tag !== "Pending") {
        pending.reject(new Error(`Pending agent message is missing for ${checkpointId}`))
        pendingRuns.delete(checkpointId)
        return
      }
      const completedMessage = CompletedAgentReviewThreadMessage.make({
        id: pendingTurn.message.id,
        threadId: pendingTurn.message.threadId,
        sequence: pendingTurn.message.sequence,
        agentRunId: pendingTurn.message.agentRunId,
        bodyMarkdown: MarkdownBody.make(turn.response.bodyMarkdown),
        createdAt: pendingTurn.message.createdAt,
        updatedAt: sourceTurn?.message.updatedAt ?? current.thread.updatedAt,
      })
      const completedTurn = CompletedAgentReviewTurn.make({
        message: completedMessage,
        run: CompletedAgentRun.make({
          id: pendingTurn.run.id,
          threadId: pendingTurn.run.threadId,
          reviewKey: pendingTurn.run.reviewKey,
          baseRevision: pendingTurn.run.baseRevision,
          headRevision: pendingTurn.run.headRevision,
          provider: pendingTurn.run.provider,
          model: pendingTurn.run.model,
          promptVersion: pendingTurn.run.promptVersion,
          startedAt: pendingTurn.run.startedAt,
          completedAt: completedMessage.updatedAt,
        }),
      })
      const result = replaceThread(
        ReviewThreadDetails.make({
          thread: ReviewThread.make({
            ...current.thread,
            updatedAt: completedMessage.updatedAt,
          }),
          conversation: current.conversation.map((entry) =>
            entry.message.id === pendingTurn.message.id ? completedTurn : entry,
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
        .filter((file) => hostedViewedFiles.get(file.reviewKey) === file.patchHash)
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
      activateWindow: async () => undefined,
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
            demoAgentProvider("claude", "Claude", "claude-sonnet-5", "Sonnet 5", "balanced"),
            demoAgentProvider("codex", "Codex", "gpt-5.6-terra", "GPT 5.6 Terra", "balanced"),
            demoAgentProvider(
              "opencode",
              "OpenCode",
              "openai/gpt-5.6-terra",
              "GPT 5.6 Terra",
              "balanced",
            ),
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
        path: ExecutablePath.make("/usr/local/bin/diffdash"),
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
          : repositories.filter((repo) => repo.displayIdentity.toLowerCase().includes(normalized))
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
          id: ReviewProjectId.make(
            `${remote.locator.providerId}:${remote.locator.namespace}/${remote.locator.name}`,
          ),
          source: HostedRepositorySource.make({ locator: remote.locator }),
          checkout: RemoteOnly.make({ remoteUrl: remote.url }),
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
      openProject: async (localPath, selectedRepository) => {
        const demoRepository = makeHostedRepositoryLocator(
          provider.id,
          scenario.manifest.repository.owner,
          scenario.manifest.repository.name,
        )
        if (
          selectedRepository !== undefined &&
          !sameHostedRepository(selectedRepository, demoRepository)
        ) {
          throw new Error("Unknown demo project remote selection")
        }
        const linked = linkLocalPath(localPath)
        record("repositories.openProject", { localPath })
        return ProjectOpened.make({ repo: linked })
      },
      repairIdentities: async () =>
        RepositoryIdentityRepairSummary.make({
          resolvedCount: repositories.filter((repo) => repo.hostedLocator !== null).length,
          unresolvedCount: 0,
          localAliasCount: 0,
        }),
      forget: async (projectId) => {
        const current = repositories.find((repo) => repo.id === projectId)
        if (current === undefined) throw new Error(`Unknown demo repository: ${projectId}`)
        const forgotten = Repo.make({
          ...current,
          isFavorite: false,
          lastOpenedAt: null,
          updatedAt: scenario.manifest.pullRequest.createdAt,
        })
        repositories = repositories.map((repo) => (repo.id === projectId ? forgotten : repo))
        record("repositories.forget", { projectId })
        return forgotten
      },
      selectLocalFolder: async () => null,
    },
    projectWorkspace: {
      get: async (projectId) => projectWorkspaceStates.get(projectId) ?? null,
      save: async (input: ProjectWorkspaceStateInput) => {
        if (!repositories.some((repo) => repo.id === input.projectId)) {
          throw new Error(`Unknown demo repository: ${input.projectId}`)
        }
        const state = ProjectWorkspaceState.make({
          ...input,
          updatedAt: scenario.manifest.pullRequest.createdAt,
        })
        projectWorkspaceStates.set(input.projectId, state)
        record("projectWorkspace.save", {
          projectId: input.projectId,
          activeRibbon: input.activeRibbon,
        })
        return state
      },
    },
    reviewThreads: {
      list: async (target) => {
        requireTarget(target)
        const reviewKey = targetReviewKey(target)
        return [...threadDetails.values()]
          .filter((details) => details.thread.reviewKey === reviewKey)
          .map((details) => details.thread)
      },
      create: async (input) => {
        requireTarget(input.target)
        const id = ReviewThreadId.make(`thread-captured-${createdThreadCounter}`)
        createdThreadCounter += 1
        const now = `2026-07-10T09:${String(createdThreadCounter).padStart(2, "0")}:00Z`
        const thread = ReviewThread.make({
          id,
          repoId: scenario.repository.id,
          reviewKey: targetReviewKey(input.target),
          prNumber: input.target.kind === "hosted" ? input.target.review.number : null,
          baseRevision: input.expectedBaseRevision,
          headRevision: input.expectedHeadRevision,
          currentBaseRevision: input.expectedBaseRevision,
          currentHeadRevision: input.expectedHeadRevision,
          originalAnchor: input.anchor,
          currentAnchor: CurrentReviewAnchor.cases.Active.make({ anchor: input.anchor }),
          createdAt: now,
          updatedAt: now,
        })
        const details = ReviewThreadDetails.make({
          thread,
          conversation: [
            UserReviewTurn.make({
              message: UserReviewThreadMessage.make({
                id: ReviewThreadMessageId.make(`message-captured-${createdMessageCounter}`),
                threadId: id,
                sequence: 0,
                bodyMarkdown: input.bodyMarkdown,
                createdAt: now,
                updatedAt: now,
              }),
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
            (message) => message._tag === "User" && message.sequence === current.messages.length,
          )
        const now = sourceMessage?.createdAt ?? current.thread.updatedAt
        const message = UserReviewThreadMessage.make({
          id: ReviewThreadMessageId.make(
            sourceMessage?.id ?? `message-captured-${createdMessageCounter}`,
          ),
          threadId: input.threadId,
          sequence: current.messages.length,
          bodyMarkdown: input.bodyMarkdown,
          createdAt: now,
          updatedAt: now,
        })
        createdMessageCounter += 1
        record("reviewThreads.addUserMessage", { threadId: input.threadId })
        return replaceThread(
          ReviewThreadDetails.make({
            thread: ReviewThread.make({ ...current.thread, updatedAt: now }),
            conversation: [...current.conversation, UserReviewTurn.make({ message })],
          }),
        )
      },
      get: async (threadId) => requireThread(threadId),
      runAgent: async (input) => {
        requireTarget(input.target)
        const current = requireThread(input.threadId)
        const completedAgentTurns = current.conversation.filter(
          (turn) => turn._tag === "Completed",
        ).length
        const turns = Object.entries(scenario.agentTurns)
        const selected = turns[completedAgentTurns] ?? turns.at(-1)
        if (selected === undefined) throw new Error("Demo scenario has no scripted agent turns")
        const [turnId, turn] = selected
        if (pendingRuns.has(turnId)) throw new Error(`Agent turn ${turnId} is already pending`)
        const sourceTurn = scenario.threads
          .flatMap((details) => details.conversation)
          .find(
            (entry) =>
              entry._tag === "Completed" &&
              entry.message.bodyMarkdown === turn.response.bodyMarkdown,
          )
        const messageId = ReviewThreadMessageId.make(
          sourceTurn?.message.id ?? `message-captured-${createdMessageCounter}`,
        )
        createdMessageCounter += 1
        const pendingTimestamp = sourceTurn?.message.createdAt ?? current.thread.updatedAt
        const runId =
          sourceTurn?._tag === "Completed"
            ? sourceTurn.run.id
            : AgentRunId.make(`run-captured-${createdMessageCounter}`)
        const pendingMessage = PendingAgentReviewThreadMessage.make({
          id: messageId,
          threadId: input.threadId,
          sequence: current.messages.length,
          agentRunId: runId,
          createdAt: pendingTimestamp,
          updatedAt: pendingTimestamp,
        })
        const pendingTurn = PendingAgentReviewTurn.make({
          message: pendingMessage,
          run: RunningAgentRun.make({
            id: runId,
            threadId: current.thread.id,
            reviewKey: current.thread.reviewKey,
            baseRevision: current.thread.baseRevision,
            headRevision: current.thread.headRevision,
            provider: ReviewAgentProviderId.make("demo"),
            model: "demo-model",
            promptVersion: AgentPromptVersion.make("demo-v1"),
            startedAt: pendingTimestamp,
          }),
        })
        replaceThread(
          ReviewThreadDetails.make({
            thread: current.thread,
            conversation: [...current.conversation, pendingTurn],
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
        record("settings.update", {
          provider: AIAgentSelection.guards.Automatic(next.selections.walkthrough)
            ? "auto"
            : next.selections.walkthrough.providerId,
        })
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
        const matchesQuery =
          `${scenario.manifest.repository.owner}/${scenario.manifest.repository.name}`
            .toLowerCase()
            .includes(request.query.trim().toLowerCase())
        const matchesOwner =
          request.namespaces.length === 0 ||
          request.namespaces.includes(scenario.manifest.repository.owner)
        return matchesQuery && matchesOwner
          ? [
              HostedRepository.make({
                locator: makeHostedRepositoryLocator(
                  provider.id,
                  scenario.manifest.repository.owner,
                  scenario.manifest.repository.name,
                ),
                url: WebUrl.make(scenario.repository.remoteUrl),
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
        return [currentRevision.detail.summary]
      },
      listAssigned: async () => [currentRevision.detail.summary],
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
      resolveBranch: async (localPath, branchName) => {
        const branch = localReviewFixtures[1]
        if (localPath !== branch.target.rootPath || (branchName !== null && branchName !== "dev")) {
          throw new Error(`Unknown demo branch comparison: ${branchName ?? "<default>"}`)
        }
        return branch.target
      },
      resolveLastCommit: async () => {
        throw new Error("Last-commit review is unavailable in the demo fixture")
      },
    },
    repositoryComparisons: {
      resolve: async () => {
        throw new Error("Repository comparisons are unavailable in the demo runtime")
      },
      openFile: async () => {
        throw new Error("Repository comparisons are unavailable in the demo runtime")
      },
    },
    reviewSnapshots: {
      acquireHosted: async (request) => {
        requireReview(
          request.review.repository.namespace,
          request.review.repository.name,
          request.review.number,
        )
        manifestCache.set(currentRevision.manifest.snapshotId, currentRevision.manifest)
        return currentRevision.manifest
      },
      acquireLocal: async (target) => {
        const manifest = requireLocalFixture(target).manifest
        manifestCache.set(manifest.snapshotId, manifest)
        return manifest
      },
      acquireRepositoryComparison: async () => {
        throw new Error("Repository comparisons are unavailable in the demo runtime")
      },
    },
    progressiveReviews: {
      openSession: async (request) =>
        ReadyReviewSession.make({
          identity: ReviewSessionIdentity.make({
            ...request,
            processId: ReviewSessionProcessId.make("demo-process"),
            sessionId: ReviewSessionId.make(`demo:${request.snapshotId}`),
            stateVersion: ReviewSessionStateVersion.make(1),
          }),
        }),
      currentSession: async (request) => ReadyReviewSession.make({ identity: request.identity }),
      closeSession: async (request) =>
        DisposedReviewSession.make({ identity: request.identity, reason: "closed" }),
      inventory: async (request) => {
        const manifest = manifestCache.get(request.identity.snapshotId)
        if (manifest === undefined) throw new Error("Demo review snapshot is unavailable")
        const files = manifest.files.slice(request.offset, request.offset + request.limit)
        const nextOffset = request.offset + files.length
        return {
          identity: request.identity,
          files: files.map((file, index) => ({
            ordinal: request.offset + index,
            fileId: file.fileId,
            path: file.path,
            oldPath: file.oldPath,
            additions: file.additions,
            deletions: file.deletions,
            status: file.status,
            visibility: file.visibility,
            patchHash: file.patchHash,
            hunkCount: file.hunkCount,
          })),
          nextOffset: nextOffset < manifest.files.length ? nextOffset : null,
        }
      },
      readRange: async (request) => {
        const manifest = manifestCache.get(request.identity.snapshotId)
        if (manifest === undefined) throw new Error("Demo review snapshot is unavailable")
        const hostedRevision = scenario.revisions.find(
          (revision) => revision.manifest.snapshotId === request.identity.snapshotId,
        )
        const localFixture = localReviewFixtures.find(
          (fixture) => fixture.manifest.snapshotId === request.identity.snapshotId,
        )
        const parsedDiff = hostedRevision?.parsedDiff ?? localFixture?.parsedDiff
        const file = parsedDiff?.files.find(({ fileId }) => fileId === request.fileId)
        const ordinal = manifest.files.findIndex(({ fileId }) => fileId === request.fileId)
        if (file === undefined || ordinal < 0) throw new Error("Demo review file is unavailable")
        const bytes = new TextEncoder().encode(file.patch)
        return {
          identity: request.identity,
          file: {
            ordinal,
            fileId: file.fileId,
            path: file.path,
            oldPath: file.oldPath,
            additions: file.additions,
            deletions: file.deletions,
            status: file.status,
            visibility: file.visibility,
            patchHash: file.patchHash,
            hunkCount: file.hunks.length,
          },
          blocks: [
            {
              id: `demo:${file.fileId}`,
              hunkId: null,
              ordinal: 0,
              firstLine: 0,
              lineCount: Math.max(1, file.patch.split("\n").length),
              bytes,
            },
          ],
          byteCount: bytes.byteLength,
          complete: true,
        }
      },
      waitForRange: async (request) => api.progressiveReviews.readRange(request),
      resolveTarget: async (request) => {
        const page = await api.progressiveReviews.inventory({
          identity: request.identity,
          offset: 0,
          limit: 8,
        })
        const file = page.files.find(({ fileId }) => fileId === request.fileId)
        if (file === undefined) throw new Error("Demo review target is unavailable")
        return { identity: request.identity, file, blockOrdinal: 0, line: request.line }
      },
      search: async (request, onPublication) => {
        onPublication(
          ReviewSessionSearchPublication.cases.Final.make({
            identity: request.identity,
            totalMatches: 0,
            matches: [],
            previousCursor: null,
            nextCursor: null,
            wrapped: false,
          }),
        )
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
        return [...hostedViewedFiles].map(([reviewKey, patchHash]) => ({ reviewKey, patchHash }))
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
        if (request.viewed) hostedViewedFiles.set(request.reviewKey, request.patchHash)
        else hostedViewedFiles.delete(request.reviewKey)
        record("viewedFiles.set", {
          reviewKey: request.reviewKey,
          viewed: request.viewed,
        })
      },
      listLocal: async (request) => {
        requireLocalFixture(request.target)
        const viewed = localViewedFiles.get(localReviewTargetKey(request.target))
        return [...(viewed ?? new Map())].map(([reviewKey, patchHash]) => ({
          reviewKey,
          patchHash,
        }))
      },
      setLocal: async (request) => {
        requireLocalFixture(request.target)
        const key = localReviewTargetKey(request.target)
        const viewed = localViewedFiles.get(key)
        if (viewed === undefined) throw new Error("Demo local viewed-file scope is missing")
        if (request.viewed) viewed.set(request.reviewKey, request.patchHash)
        else viewed.delete(request.reviewKey)
        record("viewedFiles.setLocal", {
          reviewKey: request.reviewKey,
          viewed: request.viewed,
        })
      },
      listRepositoryComparison: async () => [],
      setRepositoryComparison: async () => undefined,
    },
    walkthroughs: {
      get: async (request) => {
        requireReview(
          request.review.repository.namespace,
          request.review.repository.name,
          request.review.number,
        )
        return request.baseRevision === currentRevision.manifest.baseRevision &&
          request.headRevision === currentRevision.manifest.headRevision
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
      get: async (target, baseSha, headSha) => {
        const fixture = requireLocalFixture(target)
        return baseSha === fixture.manifest.baseRevision &&
          headSha === fixture.manifest.headRevision
          ? fixture.walkthrough
          : null
      },
      generate: async (target) => requireLocalFixture(target).walkthrough,
      regenerate: async (target) => requireLocalFixture(target).walkthrough,
    },
    repositoryComparisonWalkthroughs: {
      get: async () => null,
      generate: async () => {
        throw new Error("Repository comparisons are unavailable in the demo runtime")
      },
      regenerate: async () => {
        throw new Error("Repository comparisons are unavailable in the demo runtime")
      },
    },
  }

  function linkLocalPath(localPath: string) {
    const linked = Repo.make({
      ...scenario.repository,
      checkout: LinkedCheckout.make({
        remoteUrl: scenario.repository.remoteUrl,
        path: RepositoryCheckoutPath.make(localPath),
      }),
    })
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
    capabilities: {
      walkthrough: AgentProviderCapabilityStatus.cases.Ready.make({ runtimeVersion: "demo" }),
      "review-thread": AgentProviderCapabilityStatus.cases.Ready.make({
        runtimeVersion: "demo",
      }),
    },
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
    installedCodingAgents: ["codex", "claude", "opencode"].map((name) =>
      CodingAgentName.make(name),
    ),
    diffDashCliInstalled: true,
    diffDashCliInPath: true,
    diffDashCliPath: ExecutablePath.make("/usr/local/bin/diffdash"),
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
    themes: ThemePreferences.make({ ...settings.themes }),
    codeThemes: CodeThemePreferences.make({ ...settings.codeThemes }),
    layout: RendererLayoutSettings.make({
      review: ReviewPaneSettings.make({ ...settings.layout.review }),
    }),
    selections: { ...settings.selections },
  })
