import { EMPTY_AGENT_PROVIDER_CATALOG } from "@diffdash/domain/agent-provider"
import type { ParsedDiff, ParsedDiffFile } from "@diffdash/domain/diff"
import { findProjectedDiffHunkLine, projectDiffHunkLines } from "@diffdash/domain/diff-hunk-lines"
import {
  CloudDiffParseError,
  parseCloudUnifiedDiff,
  streamCloudUnifiedDiff,
} from "./cloud-diff-parser"
import { makeHostedRepositoryKey } from "@diffdash/domain/git-provider"
import { AppPrerequisites } from "@diffdash/domain/prerequisites"
import { RepositoryIdentityRepairSummary } from "@diffdash/domain/repository"
import {
  makeReviewDiffIdentity,
  makeReviewKey,
  makeReviewSnapshotId,
  ReviewProjectId,
  type ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import {
  HostedReviewSnapshotManifest,
  RepositoryComparisonSnapshotManifest,
} from "@diffdash/domain/review-context"
import {
  makeRepositoryComparisonReviewKey,
  repositoryComparisonBaseRevision,
  repositoryComparisonHeadRevision,
} from "@diffdash/domain/repository-comparison"
import type { DiffDashApi, DiffDashBridgeApi } from "@diffdash/protocol/api"
import { AppUpdateUnsupported } from "@diffdash/protocol/app-update"
import { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import {
  type BridgeResult,
  type EncodedBridgeResult,
  type InvokeResponse,
  eventPayloadSchema,
  invokeResponseSchema,
} from "@diffdash/protocol/ipc"
import {
  DisposedReviewSession,
  ReadyReviewSession,
  ReviewSessionId,
  ReviewSessionIdentity,
  ReviewSessionProcessId,
  ReviewSessionStateVersion,
  type ReviewSessionFile,
} from "@diffdash/protocol/review-session"
import { toTransportError } from "@diffdash/protocol/transport-error"
import { Match, Schema } from "effect"

import { CloudStorage } from "./cloud-storage"
import { captureCloudEvent, captureCloudRendererEvent } from "./cloud-analytics"
import { CloudCommentNotes } from "./cloud-comment-notes"
import { GithubClient, githubCloudProvider } from "./github-client"

type CloudSnapshot = {
  readonly manifest: HostedReviewSnapshotManifest | RepositoryComparisonSnapshotManifest
  readonly parsedDiff: ParsedDiff
  readonly acquisition:
    | { readonly status: "complete" }
    | {
        readonly status: "streaming"
        readonly files: AsyncGenerator<ParsedDiffFile>
        readonly abort: AbortController
      }
    | { readonly status: "failed"; readonly error: CloudDiffParseError }
}

const unsupported = (): Promise<never> =>
  Promise.reject(new Error("This capability is unavailable in DiffDash Cloud."))

const noSubscription = (): (() => void) => () => undefined

/** Creates the browser-local implementation of the complete renderer platform contract. */
export const createCloudApi = (github: GithubClient, storage: CloudStorage): DiffDashApi => {
  const snapshots = new Map<ReviewSnapshotId, CloudSnapshot>()
  const notes = new CloudCommentNotes()
  const sessions = new Map<ReviewSnapshotId, typeof ReviewSessionIdentity.Type>()
  let sessionSequence = 0

  const getSnapshot = (snapshotId: ReviewSnapshotId): CloudSnapshot => {
    const snapshot = snapshots.get(snapshotId)
    if (snapshot === undefined) throw new Error("The review snapshot is no longer available.")
    return snapshot
  }

  const sessionFile = (file: ParsedDiffFile, ordinal: number): ReviewSessionFile => ({
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
  })

  const acquireHosted: DiffDashApi["reviewSnapshots"]["acquireHosted"] = async ({ review }) => {
    const { namespace, name } = review.repository
    const [detail, response] = await Promise.all([
      github.getPullRequestInventorySummary(namespace, name, review.number),
      github.openPullRequestDiff(namespace, name, review.number),
    ])
    const baseRevision = detail.summary.base.revision
    const headRevision = detail.summary.head.revision
    if (baseRevision === null || headRevision === null) {
      throw new Error("GitHub did not provide immutable pull-request revisions.")
    }
    const reviewKey = makeReviewKey(review)
    const abort = new AbortController()
    const pendingFiles = streamCloudUnifiedDiff(response, abort.signal)
    const first = await pendingFiles.next()
    const files = first.done ? [] : [first.value]
    // A Cloud reservation has a unique acquisition identity. It is never reused as
    // content-addressed evidence before its stream is complete.
    const snapshotId = makeReviewSnapshotId({
      reviewKey,
      baseRevision,
      headRevision,
      diffIdentity: makeReviewDiffIdentity(crypto.randomUUID()),
    })
    const manifest = HostedReviewSnapshotManifest.make({
      projectId: ReviewProjectId.make(makeHostedRepositoryKey(review.repository)),
      snapshotId,
      reviewKey,
      baseRevision,
      headRevision,
      fileCount: detail.fileCount ?? files.length,
      detail: { summary: detail.summary },
    })
    snapshots.set(snapshotId, {
      manifest,
      parsedDiff: { files },
      acquisition: first.done
        ? { status: "complete" }
        : { status: "streaming", files: pendingFiles, abort },
    })
    return manifest
  }

  const api: DiffDashApi = {
    analytics: {
      start: async () => undefined,
      capture: async (event) => captureCloudRendererEvent(event),
    },
    updates: {
      getState: async () =>
        AppUpdateUnsupported.make({ currentVersion: "cloud-v0", reason: "platform" }),
      check: async () => undefined,
      download: async () => undefined,
      restartAndInstall: async () => undefined,
      onStateChanged: noSubscription,
    },
    navigation: {
      activateWindow: async () => undefined,
      drainCommands: async () => [],
      onCommandsAvailable: noSubscription,
    },
    diagnostics: async () =>
      AppPrerequisites.make({
        checkedAt: new Date().toISOString(),
        codingAgentInstalled: false,
        diffDashCliInstalled: false,
        diffDashCliInPath: false,
        diffDashCliPath: null,
        gitInstalled: false,
        ghAuthenticated: true,
        ghInstalled: false,
        ghSearchRepositoriesAvailable: true,
        ghSupported: true,
        ghVersion: null,
        installedCodingAgents: [],
        providerDiagnostics: [],
        setupRequirements: [],
      }),
    agentProviders: { getCatalog: async () => EMPTY_AGENT_PROVIDER_CATALOG },
    ai: {
      listOpenCodeSessions: unsupported,
      connectOpenCodeSession: unsupported,
      submitComment: unsupported,
    },
    commentNotes: {
      list: (request) => notes.list(request),
      create: async (request) => {
        const note = await notes.create(request)
        void captureCloudEvent({ event: "note_created" })
        return note
      },
      delete: async (request) => {
        await notes.delete(request)
        void captureCloudEvent({ event: "note_deleted" })
      },
      clear: async (request) => {
        await notes.clear(request)
        void captureCloudEvent({ event: "notes_cleared" })
      },
      send: unsupported,
    },
    installDiffDashCli: unsupported,
    openExternalUrl: async (url) => {
      window.open(url, "_blank", "noopener,noreferrer")
    },
    openRepositoryFile: async ({ review, filePath, headRefName, headRevision }) => {
      const revision = headRevision ?? headRefName
      const encodedPath = filePath.split("/").map(encodeURIComponent).join("/")
      const url = `https://github.com/${encodeURIComponent(review.repository.namespace)}/${encodeURIComponent(review.repository.name)}/blob/${encodeURIComponent(revision)}/${encodedPath}`
      window.open(url, "_blank", "noopener,noreferrer")
    },
    openLocalRepositoryFile: unsupported,
    repositories: {
      list: (query) => storage.listRepositories(query),
      setFavorite: (id, isFavorite) => storage.setRepositoryFavorite(id, isFavorite),
      favoriteRemote: (repository) => storage.saveHostedRepository(repository, true),
      install: unsupported,
      link: unsupported,
      openProject: unsupported,
      repairIdentities: async () =>
        RepositoryIdentityRepairSummary.make({
          resolvedCount: 0,
          unresolvedCount: 0,
          localAliasCount: 0,
        }),
      forget: (projectId) => storage.forgetRepository(projectId),
      selectLocalFolder: async () => null,
    },
    codeWorkspace: {
      open: unsupported,
      heartbeat: unsupported,
      release: unsupported,
      listDirectory: unsupported,
      search: unsupported,
      readFile: unsupported,
      definitions: unsupported,
      references: unsupported,
      changes: unsupported,
      lineChanges: unsupported,
    },
    projectWorkspace: {
      get: (projectId) => storage.getProjectWorkspace(projectId),
      save: (input) => storage.saveProjectWorkspace(input),
    },
    reviewThreads: {
      list: async () => [],
      create: unsupported,
      addUserMessage: unsupported,
      get: unsupported,
      runAgent: unsupported,
      onAgentProgress: noSubscription,
    },
    settings: {
      get: async () => storage.loadSettings(),
      update: async (settings) => storage.saveSettings(settings),
    },
    appState: {
      get: async () => storage.loadAppState(),
      update: async (state) => storage.saveAppState(state),
    },
    providers: { list: async () => [githubCloudProvider] },
    hostedRepositories: {
      searchRepositories: (request) => github.searchRepositories(request),
      listSearchScopes: async () => [],
    },
    hostedReviews: {
      list: ({ repository }) => github.listPullRequests(repository.namespace, repository.name),
      listAssigned: async () => [],
      getDecision: async () => "none",
      getDetail: ({ review }) =>
        github.getPullRequestDetail(
          review.repository.namespace,
          review.repository.name,
          review.number,
        ),
      getChecks: async () => [],
      submitDecision: unsupported,
      close: unsupported,
      merge: unsupported,
      updateBranch: unsupported,
    },
    localReviews: {
      resolveBranch: unsupported,
      resolveLastCommit: unsupported,
    },
    repositoryComparisons: {
      resolve: unsupported,
      openFile: unsupported,
    },
    reviewSnapshots: {
      acquireHosted,
      acquireLocal: unsupported,
      acquireRepositoryComparison: async (target) => {
        const diff = await github.getComparisonDiff(target)
        const parsedDiff = await parseCloudUnifiedDiff(diff)
        const reviewKey = makeRepositoryComparisonReviewKey(target)
        const baseRevision = repositoryComparisonBaseRevision(target)
        const headRevision = repositoryComparisonHeadRevision(target)
        const snapshotId = makeReviewSnapshotId({
          reviewKey,
          baseRevision,
          headRevision,
          diffIdentity: makeReviewDiffIdentity(diff),
        })
        const manifest = RepositoryComparisonSnapshotManifest.make({
          projectId: ReviewProjectId.make(makeHostedRepositoryKey(target.repository)),
          snapshotId,
          reviewKey,
          baseRevision,
          headRevision,
          fileCount: parsedDiff.files.length,
          detail: {
            target,
            title: `${target.baseRef}...${target.headRef}`,
            fetchedAt: new Date().toISOString(),
          },
        })
        snapshots.set(snapshotId, { manifest, parsedDiff, acquisition: { status: "complete" } })
        return manifest
      },
    },
    progressiveReviews: {
      openSession: async (request) => {
        getSnapshot(request.snapshotId)
        sessionSequence += 1
        const identity = ReviewSessionIdentity.make({
          ...request,
          processId: ReviewSessionProcessId.make("diffdash-cloud-browser"),
          sessionId: ReviewSessionId.make(`cloud-session-${sessionSequence}`),
          stateVersion: ReviewSessionStateVersion.make(1),
        })
        sessions.set(request.snapshotId, identity)
        return ReadyReviewSession.make({ identity })
      },
      currentSession: async ({ identity }) => {
        getSnapshot(identity.snapshotId)
        return ReadyReviewSession.make({ identity })
      },
      closeSession: async ({ identity }) => {
        if (sessions.get(identity.snapshotId)?.sessionId !== identity.sessionId)
          return DisposedReviewSession.make({ identity, reason: "closed" })
        sessions.delete(identity.snapshotId)
        const snapshot = getSnapshot(identity.snapshotId)
        snapshots.delete(identity.snapshotId)
        if (snapshot.acquisition.status === "streaming") {
          snapshot.acquisition.abort.abort()
          await snapshot.acquisition.files.return(undefined)
        }
        return DisposedReviewSession.make({ identity, reason: "closed" })
      },
      inventory: async ({ identity, offset, limit }) => {
        const snapshot = getSnapshot(identity.snapshotId)
        if (snapshot.acquisition.status === "failed") throw snapshot.acquisition.error
        const files = snapshot.parsedDiff.files
        if (offset >= files.length && snapshot.acquisition.status === "streaming") {
          const batch: ParsedDiffFile[] = []
          let complete = false
          try {
            while (batch.length < Math.min(limit, 32) && !complete) {
              const next = await snapshot.acquisition.files.next()
              complete = next.done === true
              if (!next.done) batch.push(next.value)
            }
          } catch {
            const error = new CloudDiffParseError({
              message: "The review diff stream stopped before all files were loaded.",
            })
            if (snapshots.has(identity.snapshotId))
              snapshots.set(identity.snapshotId, {
                ...snapshot,
                acquisition: { status: "failed", error },
              })
            throw error
          }
          // Snapshot files retain arrival order for stable progressive ordinals.
          snapshots.set(identity.snapshotId, {
            ...snapshot,
            parsedDiff: { files: [...files, ...batch] },
            acquisition: complete ? { status: "complete" } : snapshot.acquisition,
          })
          return api.progressiveReviews.inventory({ identity, offset, limit })
        }
        const page = files.slice(offset, offset + limit)
        const nextOffset = offset + page.length
        return {
          identity,
          files: page.map((file, index) => sessionFile(file, offset + index)),
          nextOffset:
            nextOffset < files.length || snapshot.acquisition.status === "streaming"
              ? nextOffset
              : null,
        }
      },
      readRange: async ({ identity, fileId }) => {
        const snapshot = getSnapshot(identity.snapshotId)
        const ordinal = snapshot.parsedDiff.files.findIndex((file) => file.fileId === fileId)
        const file = snapshot.parsedDiff.files[ordinal]
        if (file === undefined) throw new Error("The changed file is not available.")
        const bytes = new TextEncoder().encode(file.patch)
        return {
          identity,
          file: sessionFile(file, ordinal),
          blocks: [
            {
              id: `cloud-block-${ordinal}`,
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
      resolveTarget: async ({ identity, fileId, target }) => {
        const snapshot = getSnapshot(identity.snapshotId)
        const ordinal = snapshot.parsedDiff.files.findIndex((file) => file.fileId === fileId)
        const file = snapshot.parsedDiff.files[ordinal]
        if (file === undefined) throw new Error("The changed file is not available.")
        const hunk =
          target.hunkId === null ? undefined : file.hunks.find(({ id }) => id === target.hunkId)
        const line = Match.valueTags(target, {
          HunkLine: ({ line: hunkLine }) => hunkLine,
          SideLine: ({ side, lineNumber }) => {
            if (hunk === undefined) return -1
            return (
              findProjectedDiffHunkLine(projectDiffHunkLines(hunk), { side, lineNumber })?.index ??
              -1
            )
          },
        })
        if (line < 0 || (hunk !== undefined && line >= hunk.lines.length)) {
          throw new Error("The requested diff line is not available.")
        }
        return {
          identity,
          file: sessionFile(file, ordinal),
          blockOrdinal: 0,
          firstLine: 0,
          line,
        }
      },
      search: async ({ identity }, onPublication) => {
        onPublication({
          _tag: "Final",
          identity,
          totalMatches: 0,
          matches: [],
          previousCursor: null,
          nextCursor: null,
          wrapped: false,
        })
      },
    },
    viewedFiles: {
      list: (request) => storage.listViewedFiles(request),
      set: (request) => storage.setViewedFile(request),
      listLocal: async () => [],
      setLocal: async () => undefined,
      listRepositoryComparison: async () => [],
      setRepositoryComparison: async () => undefined,
    },
    walkthroughOperations: {
      start: unsupported,
      getOperation: unsupported,
      cancel: unsupported,
      getStored: unsupported,
      onHint: noSubscription,
    },
  }
  return api
}

const bridgeSuccess = <Value>(value: Value): BridgeResult<Value> => ({ _tag: "Success", value })

const invokeCloudBridge = async <Channel extends InvokeChannel>(
  channel: Channel,
  operation: () => Promise<InvokeResponse<Channel>>,
): Promise<EncodedBridgeResult> => {
  try {
    const value = await operation()
    return bridgeSuccess(Schema.encodeUnknownSync(invokeResponseSchema(channel))(value))
  } catch (error) {
    return {
      _tag: "Failure",
      error: toTransportError(
        Schema.is(Schema.Json)(error) || Schema.is(Schema.ErrorInstance())(error)
          ? error
          : undefined,
        channel,
      ),
    }
  }
}

/** Wraps semantic browser operations in the renderer bridge result protocol. */
export const createCloudBridge = (api: DiffDashApi): DiffDashBridgeApi => ({
  analytics: {
    start: () => invokeCloudBridge(InvokeChannel.analyticsStart, api.analytics.start),
    capture: (event) =>
      invokeCloudBridge(InvokeChannel.analyticsCapture, () => api.analytics.capture(event)),
  },
  updates: {
    getState: () => invokeCloudBridge(InvokeChannel.updatesGetState, api.updates.getState),
    check: () => invokeCloudBridge(InvokeChannel.updatesCheck, api.updates.check),
    download: () => invokeCloudBridge(InvokeChannel.updatesDownload, api.updates.download),
    restartAndInstall: () =>
      invokeCloudBridge(InvokeChannel.updatesRestartAndInstall, api.updates.restartAndInstall),
    onStateChanged: (listener) =>
      api.updates.onStateChanged((event) =>
        listener(
          bridgeSuccess(
            Schema.encodeSync(eventPayloadSchema(EventChannel.updateStateChanged))(event),
          ),
        ),
      ),
  },
  navigation: {
    activateWindow: () =>
      invokeCloudBridge(InvokeChannel.appActivateWindow, api.navigation.activateWindow),
    drainCommands: () =>
      invokeCloudBridge(InvokeChannel.drainNavigationCommands, api.navigation.drainCommands),
    onCommandsAvailable: (listener) =>
      api.navigation.onCommandsAvailable(() => listener(bridgeSuccess({}))),
  },
  diagnostics: () => invokeCloudBridge(InvokeChannel.appDiagnostics, api.diagnostics),
  agentProviders: {
    getCatalog: () =>
      invokeCloudBridge(InvokeChannel.agentProvidersGetCatalog, api.agentProviders.getCatalog),
  },
  ai: {
    listOpenCodeSessions: (request) =>
      invokeCloudBridge(InvokeChannel.aiListOpenCodeSessions, () =>
        api.ai.listOpenCodeSessions(request),
      ),
    connectOpenCodeSession: (request) =>
      invokeCloudBridge(InvokeChannel.aiConnectOpenCodeSession, () =>
        api.ai.connectOpenCodeSession(request),
      ),
    submitComment: (request) =>
      invokeCloudBridge(InvokeChannel.aiSubmitComment, () => api.ai.submitComment(request)),
  },
  commentNotes: {
    list: (request) =>
      invokeCloudBridge(InvokeChannel.listCommentNotes, () => api.commentNotes.list(request)),
    create: (request) =>
      invokeCloudBridge(InvokeChannel.createCommentNote, () => api.commentNotes.create(request)),
    delete: (request) =>
      invokeCloudBridge(InvokeChannel.deleteCommentNote, () => api.commentNotes.delete(request)),
    clear: (request) =>
      invokeCloudBridge(InvokeChannel.clearCommentNotes, () => api.commentNotes.clear(request)),
    send: (request) =>
      invokeCloudBridge(InvokeChannel.sendCommentNotes, () => api.commentNotes.send(request)),
  },
  installDiffDashCli: () =>
    invokeCloudBridge(InvokeChannel.appInstallDiffDashCli, api.installDiffDashCli),
  openExternalUrl: (url) =>
    invokeCloudBridge(InvokeChannel.appOpenExternalUrl, () => api.openExternalUrl(url)),
  openRepositoryFile: (request) =>
    invokeCloudBridge(InvokeChannel.appOpenRepositoryFile, () => api.openRepositoryFile(request)),
  openLocalRepositoryFile: (...args) =>
    invokeCloudBridge(InvokeChannel.appOpenLocalRepositoryFile, () =>
      api.openLocalRepositoryFile(...args),
    ),
  repositories: {
    list: (query) =>
      invokeCloudBridge(InvokeChannel.listRepositories, () => api.repositories.list(query)),
    setFavorite: (...args) =>
      invokeCloudBridge(InvokeChannel.setRepositoryFavorite, () =>
        api.repositories.setFavorite(...args),
      ),
    favoriteRemote: (repository) =>
      invokeCloudBridge(InvokeChannel.favoriteRemoteRepository, () =>
        api.repositories.favoriteRemote(repository),
      ),
    install: (path) =>
      invokeCloudBridge(InvokeChannel.installRepository, () => api.repositories.install(path)),
    link: (request) =>
      invokeCloudBridge(InvokeChannel.linkRepository, () => api.repositories.link(request)),
    openProject: (...args) =>
      invokeCloudBridge(InvokeChannel.openProject, () => api.repositories.openProject(...args)),
    repairIdentities: () =>
      invokeCloudBridge(
        InvokeChannel.repairRepositoryIdentities,
        api.repositories.repairIdentities,
      ),
    forget: (projectId) =>
      invokeCloudBridge(InvokeChannel.forgetRepository, () => api.repositories.forget(projectId)),
    selectLocalFolder: () =>
      invokeCloudBridge(InvokeChannel.selectLocalFolder, api.repositories.selectLocalFolder),
  },
  codeWorkspace: {
    open: (request) =>
      invokeCloudBridge(InvokeChannel.openCodeWorkspace, () => api.codeWorkspace.open(request)),
    heartbeat: (request) =>
      invokeCloudBridge(InvokeChannel.heartbeatCodeWorkspace, () =>
        api.codeWorkspace.heartbeat(request),
      ),
    release: (request) =>
      invokeCloudBridge(InvokeChannel.releaseCodeWorkspace, () =>
        api.codeWorkspace.release(request),
      ),
    listDirectory: (request) =>
      invokeCloudBridge(InvokeChannel.listCodeWorkspaceDirectory, () =>
        api.codeWorkspace.listDirectory(request),
      ),
    search: (request) =>
      invokeCloudBridge(InvokeChannel.searchCodeWorkspace, () => api.codeWorkspace.search(request)),
    readFile: (request) =>
      invokeCloudBridge(InvokeChannel.readCodeWorkspaceFile, () =>
        api.codeWorkspace.readFile(request),
      ),
    definitions: (request) =>
      invokeCloudBridge(InvokeChannel.codeWorkspaceDefinitions, () =>
        api.codeWorkspace.definitions(request),
      ),
    references: (request) =>
      invokeCloudBridge(InvokeChannel.codeWorkspaceReferences, () =>
        api.codeWorkspace.references(request),
      ),
    changes: (request) =>
      invokeCloudBridge(InvokeChannel.codeWorkspaceChanges, () =>
        api.codeWorkspace.changes(request),
      ),
    lineChanges: (request) =>
      invokeCloudBridge(InvokeChannel.codeWorkspaceLineChanges, () =>
        api.codeWorkspace.lineChanges(request),
      ),
  },
  projectWorkspace: {
    get: (projectId) =>
      invokeCloudBridge(InvokeChannel.projectWorkspaceGet, () =>
        api.projectWorkspace.get(projectId),
      ),
    save: (request) =>
      invokeCloudBridge(InvokeChannel.projectWorkspaceSave, () =>
        api.projectWorkspace.save(request),
      ),
  },
  reviewThreads: {
    list: (request) =>
      invokeCloudBridge(InvokeChannel.listReviewThreads, () => api.reviewThreads.list(request)),
    create: (request) =>
      invokeCloudBridge(InvokeChannel.createReviewThread, () => api.reviewThreads.create(request)),
    addUserMessage: (request) =>
      invokeCloudBridge(InvokeChannel.addReviewThreadUserMessage, () =>
        api.reviewThreads.addUserMessage(request),
      ),
    get: (threadId) =>
      invokeCloudBridge(InvokeChannel.getReviewThread, () => api.reviewThreads.get(threadId)),
    runAgent: (request) =>
      invokeCloudBridge(InvokeChannel.runReviewThreadAgent, () =>
        api.reviewThreads.runAgent(request),
      ),
    onAgentProgress: (listener) =>
      api.reviewThreads.onAgentProgress((event) =>
        listener(
          bridgeSuccess(
            Schema.encodeSync(eventPayloadSchema(EventChannel.reviewThreadAgentProgress))(event),
          ),
        ),
      ),
  },
  settings: {
    get: () => invokeCloudBridge(InvokeChannel.settingsGet, api.settings.get),
    update: (request) =>
      invokeCloudBridge(InvokeChannel.settingsUpdate, () => api.settings.update(request)),
  },
  appState: {
    get: () => invokeCloudBridge(InvokeChannel.appStateGet, api.appState.get),
    update: (request) =>
      invokeCloudBridge(InvokeChannel.appStateUpdate, () => api.appState.update(request)),
  },
  providers: { list: () => invokeCloudBridge(InvokeChannel.listProviders, api.providers.list) },
  hostedRepositories: {
    searchRepositories: (request) =>
      invokeCloudBridge(InvokeChannel.searchHostedRepositories, () =>
        api.hostedRepositories.searchRepositories(request),
      ),
    listSearchScopes: (request) =>
      invokeCloudBridge(InvokeChannel.listHostedRepositorySearchScopes, () =>
        api.hostedRepositories.listSearchScopes(request),
      ),
  },
  hostedReviews: {
    list: (request) =>
      invokeCloudBridge(InvokeChannel.listHostedReviews, () => api.hostedReviews.list(request)),
    listAssigned: (request) =>
      invokeCloudBridge(InvokeChannel.listAssignedHostedReviews, () =>
        api.hostedReviews.listAssigned(request),
      ),
    getDecision: (request) =>
      invokeCloudBridge(InvokeChannel.getHostedReviewDecision, () =>
        api.hostedReviews.getDecision(request),
      ),
    getDetail: (request) =>
      invokeCloudBridge(InvokeChannel.getHostedReviewDetail, () =>
        api.hostedReviews.getDetail(request),
      ),
    getChecks: (request) =>
      invokeCloudBridge(InvokeChannel.getHostedReviewChecks, () =>
        api.hostedReviews.getChecks(request),
      ),
    submitDecision: (request) =>
      invokeCloudBridge(InvokeChannel.submitHostedReviewDecision, () =>
        api.hostedReviews.submitDecision(request),
      ),
    close: (request) =>
      invokeCloudBridge(InvokeChannel.closeHostedReview, () => api.hostedReviews.close(request)),
    merge: (request) =>
      invokeCloudBridge(InvokeChannel.mergeHostedReview, () => api.hostedReviews.merge(request)),
    updateBranch: (request) =>
      invokeCloudBridge(InvokeChannel.updateHostedReviewBranch, () =>
        api.hostedReviews.updateBranch(request),
      ),
  },
  localReviews: {
    resolveBranch: (...args) =>
      invokeCloudBridge(InvokeChannel.resolveLocalBranch, () =>
        api.localReviews.resolveBranch(...args),
      ),
    resolveLastCommit: (path) =>
      invokeCloudBridge(InvokeChannel.resolveLastCommit, () =>
        api.localReviews.resolveLastCommit(path),
      ),
  },
  repositoryComparisons: {
    resolve: (request) =>
      invokeCloudBridge(InvokeChannel.resolveRepositoryComparison, () =>
        api.repositoryComparisons.resolve(request),
      ),
    openFile: (request) =>
      invokeCloudBridge(InvokeChannel.appOpenRepositoryComparisonFile, () =>
        api.repositoryComparisons.openFile(request),
      ),
  },
  reviewSnapshots: {
    acquireHosted: (request) =>
      invokeCloudBridge(InvokeChannel.acquireHostedReviewSnapshot, () =>
        api.reviewSnapshots.acquireHosted(request),
      ),
    acquireLocal: (request) =>
      invokeCloudBridge(InvokeChannel.acquireLocalReviewSnapshot, () =>
        api.reviewSnapshots.acquireLocal(request),
      ),
    acquireRepositoryComparison: (request) =>
      invokeCloudBridge(InvokeChannel.acquireRepositoryComparisonSnapshot, () =>
        api.reviewSnapshots.acquireRepositoryComparison(request),
      ),
  },
  progressiveReviews: {
    openSession: (request) =>
      invokeCloudBridge(InvokeChannel.openProgressiveReviewSession, () =>
        api.progressiveReviews.openSession(request),
      ),
    currentSession: (request) =>
      invokeCloudBridge(InvokeChannel.getProgressiveReviewSession, () =>
        api.progressiveReviews.currentSession(request),
      ),
    closeSession: (request) =>
      invokeCloudBridge(InvokeChannel.closeProgressiveReviewSession, () =>
        api.progressiveReviews.closeSession(request),
      ),
    inventory: (request) =>
      invokeCloudBridge(InvokeChannel.getProgressiveReviewInventory, () =>
        api.progressiveReviews.inventory(request),
      ),
    readRange: (request) =>
      invokeCloudBridge(InvokeChannel.readProgressiveReviewRange, () =>
        api.progressiveReviews.readRange(request),
      ),
    waitForRange: (request) =>
      invokeCloudBridge(InvokeChannel.waitForProgressiveReviewRange, () =>
        api.progressiveReviews.waitForRange(request),
      ),
    resolveTarget: (request) =>
      invokeCloudBridge(InvokeChannel.resolveProgressiveReviewTarget, () =>
        api.progressiveReviews.resolveTarget(request),
      ),
    search: async (...args) => {
      try {
        await api.progressiveReviews.search(...args)
        return bridgeSuccess(null)
      } catch (error) {
        return {
          _tag: "Failure",
          error: toTransportError(
            Schema.is(Schema.Json)(error) || Schema.is(Schema.ErrorInstance())(error)
              ? error
              : undefined,
            InvokeChannel.searchProgressiveReview,
          ),
        }
      }
    },
  },
  viewedFiles: {
    list: (request) =>
      invokeCloudBridge(InvokeChannel.listViewedFiles, () => api.viewedFiles.list(request)),
    set: (request) =>
      invokeCloudBridge(InvokeChannel.setViewedFile, () => api.viewedFiles.set(request)),
    listLocal: (request) =>
      invokeCloudBridge(InvokeChannel.listLocalViewedFiles, () =>
        api.viewedFiles.listLocal(request),
      ),
    setLocal: (request) =>
      invokeCloudBridge(InvokeChannel.setLocalViewedFile, () => api.viewedFiles.setLocal(request)),
    listRepositoryComparison: (request) =>
      invokeCloudBridge(InvokeChannel.listRepositoryComparisonViewedFiles, () =>
        api.viewedFiles.listRepositoryComparison(request),
      ),
    setRepositoryComparison: (request) =>
      invokeCloudBridge(InvokeChannel.setRepositoryComparisonViewedFile, () =>
        api.viewedFiles.setRepositoryComparison(request),
      ),
  },
  walkthroughOperations: {
    start: (request) =>
      invokeCloudBridge(InvokeChannel.startWalkthroughOperation, () =>
        api.walkthroughOperations.start(request),
      ),
    getOperation: (request) =>
      invokeCloudBridge(InvokeChannel.getWalkthroughOperation, () =>
        api.walkthroughOperations.getOperation(request),
      ),
    cancel: (request) =>
      invokeCloudBridge(InvokeChannel.cancelWalkthroughOperation, () =>
        api.walkthroughOperations.cancel(request),
      ),
    getStored: (request) =>
      invokeCloudBridge(InvokeChannel.getStoredWalkthrough, () =>
        api.walkthroughOperations.getStored(request),
      ),
    onHint: (listener) =>
      api.walkthroughOperations.onHint((event) =>
        listener(
          bridgeSuccess(
            Schema.encodeSync(eventPayloadSchema(EventChannel.walkthroughOperationHint))(event),
          ),
        ),
      ),
  },
})
