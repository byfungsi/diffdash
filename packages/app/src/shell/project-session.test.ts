import {
  HostedRepositorySource,
  LocalRepositorySource,
  makeHostedRepositoryLocator,
} from "@diffdash/domain/git-provider"
import { LocalReviewTarget, RevisionRangeComparison } from "@diffdash/domain/local-review"
import {
  PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
  PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
  PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
  PROJECT_WORKSPACE_WALKTHROUGH_ACTIVITY_ID,
  ProjectOpened,
  ProjectRemoteCandidate,
  ProjectRemoteSelectionRequired,
  ProjectWorkspaceState,
  REVIEW_COMMENTS_ACTIVITY_ID,
} from "@diffdash/domain/project-workspace"
import { LinkedCheckout, Repo, RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { OpenRepositoryComparisonCommand } from "@diffdash/protocol/cli-navigation"
import { ResolvedRepositoryComparison } from "@diffdash/protocol/review-snapshot"
import { Option } from "effect"
import { describe, expect, it, vi } from "vitest"

import { ProjectSession } from "./project-session"

const github = makeHostedRepositoryLocator("github", "fungsi", "diffdash")
const gitlab = makeHostedRepositoryLocator("gitlab", "fungsi", "diffdash")
const repo = Repo.make({
  id: ReviewProjectId.make("github:fungsi/diffdash"),
  source: HostedRepositorySource.make({ locator: github }),
  checkout: LinkedCheckout.make({
    remoteUrl: "https://github.com/fungsi/diffdash",
    path: RepositoryCheckoutPath.make("/workspace/diffdash"),
  }),
  isFavorite: true,
  lastOpenedAt: "2026-08-02T00:00:00.000Z",
  lastSyncedAt: null,
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
})

const makeDependencies = () => ({
  availableActivityIds: () => [
    PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
    PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
    PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
    PROJECT_WORKSPACE_WALKTHROUGH_ACTIVITY_ID,
    REVIEW_COMMENTS_ACTIVITY_ID,
  ],
  loadWorkspace: async () => Option.none<ProjectWorkspaceState>(),
  openProject: async () => ProjectOpened.make({ repo }),
  resolveLocalReview: async () => {
    throw new Error("Not used by this test")
  },
  resolveLastCommit: async () => {
    throw new Error("Not used by this test")
  },
  resolveRepositoryComparison: async () => {
    throw new Error("Not used by this test")
  },
  saveWorkspace: async () => undefined,
})

describe("ProjectSession", () => {
  it("serializes workspace saves so the latest requested projection commits last", async () => {
    const firstGate: { release: () => void } = { release: () => undefined }
    const firstWait = new Promise<void>((resolve) => {
      firstGate.release = resolve
    })
    const committed: string[] = []
    const dependencies = makeDependencies()
    const session = new ProjectSession({
      ...dependencies,
      saveWorkspace: async (input) => {
        if (input.activeActivity === PROJECT_WORKSPACE_FILES_ACTIVITY_ID) await firstWait
        committed.push(input.activeActivity)
      },
    })

    const first = session.persist(
      session.project(repo, "review", PROJECT_WORKSPACE_FILES_ACTIVITY_ID, null),
    )
    const second = session.persist(
      session.project(repo, "review", REVIEW_COMMENTS_ACTIVITY_ID, null),
    )
    await Promise.resolve()
    expect(committed).toEqual([])
    firstGate.release()
    await Promise.all([first, second])
    expect(committed).toEqual([PROJECT_WORKSPACE_FILES_ACTIVITY_ID, REVIEW_COMMENTS_ACTIVITY_ID])
  })

  it("rejects a stale restoration after a newer project restoration starts", async () => {
    const releases: Array<(state: Option.Option<ProjectWorkspaceState>) => void> = []
    const dependencies = makeDependencies()
    const session = new ProjectSession({
      ...dependencies,
      loadWorkspace: () =>
        new Promise((resolve) => {
          releases.push(resolve)
        }),
    })

    const first = session.restore(repo)
    const second = session.restore(repo)
    releases[0]?.(Option.none())
    releases[1]?.(Option.none())

    await expect(first).resolves.toEqual({ _tag: "stale" })
    await expect(second).resolves.toMatchObject({ _tag: "restored", projection: { repo } })
  })

  it("rejects restoration after a user workspace mutation cancels it", async () => {
    let release: ((state: Option.Option<ProjectWorkspaceState>) => void) | undefined
    const dependencies = makeDependencies()
    const session = new ProjectSession({
      ...dependencies,
      loadWorkspace: () =>
        new Promise((resolve) => {
          release = resolve
        }),
    })

    const restoration = session.restore(repo)
    session.project(repo, "review", REVIEW_COMMENTS_ACTIVITY_ID, null)
    release?.(Option.none())

    await expect(restoration).resolves.toEqual({ _tag: "stale" })
  })

  it("repairs Comments from the current activity registry when disposal races restoration", async () => {
    let availableActivityIds = makeDependencies().availableActivityIds()
    let release: ((state: Option.Option<ProjectWorkspaceState>) => void) | undefined
    const saveWorkspace = vi.fn<() => Promise<void>>(async () => undefined)
    const session = new ProjectSession({
      ...makeDependencies(),
      availableActivityIds: () => availableActivityIds,
      loadWorkspace: () =>
        new Promise((resolve) => {
          release = resolve
        }),
      saveWorkspace,
    })
    const persisted = ProjectWorkspaceState.make({
      projectId: repo.id,
      activeSurface: "code",
      activeActivity: REVIEW_COMMENTS_ACTIVITY_ID,
      selectedReviewTarget: null,
      updatedAt: "2026-08-20T00:00:00.000Z",
    })

    const restoration = session.restore(repo)
    availableActivityIds = availableActivityIds.filter(
      (activityId) => activityId !== REVIEW_COMMENTS_ACTIVITY_ID,
    )
    release?.(Option.some(persisted))
    const restored = await restoration
    if (!("projection" in restored)) throw new Error("Expected restored project session")
    await restored.persistence

    expect(restored.projection).toMatchObject({
      activeSurface: "code",
      activeActivity: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
      notice:
        "The saved workspace activity is unavailable. A built-in activity was restored instead.",
    })
    expect(saveWorkspace).toHaveBeenCalledOnce()
  })

  it("continues remote selection with the original intent and selected repository", async () => {
    const remoteSelection = ProjectRemoteSelectionRequired.make({
      rootPath: RepositoryCheckoutPath.make("/workspace/diffdash"),
      candidates: [
        ProjectRemoteCandidate.make({ remoteName: "origin", repository: github }),
        ProjectRemoteCandidate.make({ remoteName: "mirror", repository: gitlab }),
      ],
    })
    const openProject = vi
      .fn<
        (
          localPath: string,
          selected: Option.Option<typeof github>,
        ) => Promise<ProjectOpened | ProjectRemoteSelectionRequired>
      >()
      .mockResolvedValueOnce(remoteSelection)
      .mockResolvedValueOnce(ProjectOpened.make({ repo }))
    const dependencies = makeDependencies()
    const session = new ProjectSession({ ...dependencies, openProject })
    const intent = { kind: "pullRequest", number: 42 } as const

    const pending = await session.open("/workspace/diffdash", intent)
    expect(pending).toEqual({
      _tag: "remoteSelectionRequired",
      pending: { intent, selection: remoteSelection },
    })
    if (!("pending" in pending)) throw new Error("Expected remote selection")

    const opened = await session.open(
      pending.pending.selection.rootPath,
      pending.pending.intent,
      github,
    )
    expect(opened).toMatchObject({
      _tag: "opened",
      projection: {
        activeSurface: "review",
        activeActivity: PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
        selectedReview: { kind: "hosted" },
      },
      reviewType: "pull_request",
    })
    expect(openProject).toHaveBeenLastCalledWith("/workspace/diffdash", Option.some(github))
  })

  it("projects a local repository comparison through the local review flow", async () => {
    const localRepo = Repo.make({
      ...repo,
      id: ReviewProjectId.make("local:workspace/diffdash"),
      source: LocalRepositorySource.make(),
    })
    const target = LocalReviewTarget.make({
      kind: "local",
      rootPath: RepositoryCheckoutPath.make("/workspace/diffdash"),
      comparison: RevisionRangeComparison.make({
        baseRef: RepositoryComparisonRef.make("main"),
        headRef: RepositoryComparisonRef.make("HEAD"),
        baseSha: ReviewRevision.make("a".repeat(40)),
        headSha: ReviewRevision.make("b".repeat(40)),
        mergeBaseSha: ReviewRevision.make("a".repeat(40)),
      }),
    })
    const dependencies = makeDependencies()
    const session = new ProjectSession({
      ...dependencies,
      resolveRepositoryComparison: async () =>
        ResolvedRepositoryComparison.make({ repo: localRepo, target }),
    })

    const opened = await session.openRepositoryComparison(
      OpenRepositoryComparisonCommand.make({
        localPath: RepositoryCheckoutPath.make("/workspace/diffdash"),
        repository: null,
        baseRef: RepositoryComparisonRef.make("main"),
        headRef: RepositoryComparisonRef.make("HEAD"),
      }),
    )

    expect(opened).toMatchObject({
      projection: { selectedReview: { kind: "localDiff", target } },
      reviewType: "local_diff",
    })
  })
})
