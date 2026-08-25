import {
  HostedRepositorySource,
  LocalRepositorySource,
  makeHostedRepositoryLocator,
  makeHostedReviewLocator,
} from "@diffdash/domain/git-provider"
import { LocalReviewTarget, RevisionRangeComparison } from "@diffdash/domain/local-review"
import {
  ProjectOpened,
  ProjectRemoteCandidate,
  ProjectRemoteSelectionRequired,
  ProjectWorkspaceState,
  type ProjectWorkspaceStateInput,
} from "@diffdash/domain/project-workspace"
import {
  LinkedCheckout,
  RemoteOnly,
  Repo,
  RepositoryCheckoutPath,
} from "@diffdash/domain/repository"
import { ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { OpenRepositoryComparisonCommand } from "@diffdash/protocol/cli-navigation"
import { ResolvedRepositoryComparison } from "@diffdash/protocol/review-snapshot"
import { Option } from "effect"
import { describe, expect, it, vi } from "vitest"

import { PROJECT_WORKSPACE_CODE_ACTIVITY_ID } from "@/extensions/code/code-extension"
import {
  PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
  PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
} from "@/extensions/review/review-extension"
import { REVIEW_COMMENTS_ACTIVITY_ID } from "@/extensions/review-comments/review-comments-extension"
import { PROJECT_WORKSPACE_WALKTHROUGH_ACTIVITY_ID } from "@/extensions/walkthrough/walkthrough-extension"
import {
  ProjectSession,
  ProjectSessionOpenResult,
  ProjectSessionRestoreResult,
} from "./review-project-session"
import { reviewNavigationContribution } from "./review-navigation"
import { ProjectWorkspacePersistenceCoordinator } from "../project-workspace-persistence"
import {
  codeNavigationContribution,
  createDefaultCodeNavigationState,
} from "../code/code-navigation"

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

const makePersistence = (
  persistWorkspace: (input: ProjectWorkspaceStateInput) => Promise<void> = async () => undefined,
) => new ProjectWorkspacePersistenceCoordinator(persistWorkspace).createGeneration()

const makeDependencies = () => ({
  availableNavigation: () => [reviewNavigationContribution, codeNavigationContribution],
  availableActivities: () => [
    {
      id: PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
      supportedSurfaces: ["review" as const],
      defaultForSurfaces: ["review" as const],
    },
    {
      id: PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
      supportedSurfaces: ["review" as const],
      defaultForSurfaces: [],
    },
    {
      id: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
      supportedSurfaces: ["code" as const],
      defaultForSurfaces: ["code" as const],
    },
    {
      id: PROJECT_WORKSPACE_WALKTHROUGH_ACTIVITY_ID,
      supportedSurfaces: ["review" as const],
      defaultForSurfaces: [],
    },
    {
      id: REVIEW_COMMENTS_ACTIVITY_ID,
      supportedSurfaces: ["code" as const, "review" as const],
      defaultForSurfaces: [],
    },
  ],
  defaultActivity: (surface: "code" | "review") => {
    if (surface === "code") return Option.some(PROJECT_WORKSPACE_CODE_ACTIVITY_ID)
    return Option.some(PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID)
  },
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
  persistence: makePersistence(),
})

describe("ProjectSession", () => {
  it("orders a replacement generation after an old in-flight save and skips old queued saves", async () => {
    const firstGate: { release: () => void } = { release: () => undefined }
    const firstWait = new Promise<void>((resolve) => {
      firstGate.release = resolve
    })
    const committed: string[] = []
    let persistedActivity = PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID
    const coordinator = new ProjectWorkspacePersistenceCoordinator(async (input) => {
      if (input.activeActivity === PROJECT_WORKSPACE_FILES_ACTIVITY_ID) await firstWait
      committed.push(input.activeActivity)
      persistedActivity = input.activeActivity
    })
    const dependencies = makeDependencies()
    const oldSession = new ProjectSession({
      ...dependencies,
      persistence: coordinator.createGeneration(),
    })

    const first = oldSession.persist(
      oldSession.project(
        repo,
        "review",
        PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
        Option.none(),
        Option.none(),
      ),
      () => true,
    )
    const stale = oldSession.persist(
      oldSession.project(repo, "review", REVIEW_COMMENTS_ACTIVITY_ID, Option.none(), Option.none()),
      () => true,
    )
    await Promise.resolve()
    expect(committed).toEqual([])
    oldSession.dispose()
    const newSession = new ProjectSession({
      ...dependencies,
      persistence: coordinator.createGeneration(),
    })
    const current = newSession.persist(
      newSession.project(repo, "review", REVIEW_COMMENTS_ACTIVITY_ID, Option.none(), Option.none()),
      () => true,
    )
    firstGate.release()
    await expect(Promise.all([first, stale, current])).resolves.toEqual([true, false, true])
    expect(committed).toEqual([PROJECT_WORKSPACE_FILES_ACTIVITY_ID, REVIEW_COMMENTS_ACTIVITY_ID])
    expect(persistedActivity).toBe(REVIEW_COMMENTS_ACTIVITY_ID)
  })

  it("persists an opaque Code location without inspecting or retaining Review state", async () => {
    const saved: ProjectWorkspaceState[] = []
    const session = new ProjectSession({
      ...makeDependencies(),
      persistence: makePersistence(async (input) => {
        saved.push(
          ProjectWorkspaceState.make({
            ...input,
            updatedAt: "2026-08-25T00:00:00.000Z",
          }),
        )
      }),
    })
    const selection = {
      kind: "hosted" as const,
      review: makeHostedReviewLocator("github", "fungsi", "diffdash", 42),
    }
    await session.persist(
      session.project(
        repo,
        "review",
        PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
        Option.some(selection),
        Option.none(),
      ),
      () => true,
    )
    await session.persist(
      {
        repo,
        contributionId: codeNavigationContribution.id,
        activeSurface: "code",
        activeActivity: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
        state: createDefaultCodeNavigationState(repo.id),
        notice: Option.none(),
      },
      () => true,
    )

    expect(saved[1]).toMatchObject({
      activeSurface: "code",
      activeActivity: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
      navigation: {
        contributionId: codeNavigationContribution.id,
        location: createDefaultCodeNavigationState(repo.id),
      },
    })
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
    session.project(repo, "review", REVIEW_COMMENTS_ACTIVITY_ID, Option.none(), Option.none())
    release?.(Option.none())

    await expect(restoration).resolves.toEqual({ _tag: "stale" })
  })

  it("repairs Comments from the current activity registry when disposal races restoration", async () => {
    let availableActivities = makeDependencies().availableActivities()
    let release: ((state: Option.Option<ProjectWorkspaceState>) => void) | undefined
    const saveWorkspace = vi.fn<() => Promise<void>>(async () => undefined)
    const session = new ProjectSession({
      ...makeDependencies(),
      availableActivities: () => availableActivities,
      loadWorkspace: () =>
        new Promise((resolve) => {
          release = resolve
        }),
      persistence: makePersistence(saveWorkspace),
    })
    const persisted = ProjectWorkspaceState.make({
      projectId: repo.id,
      activeSurface: "code",
      activeActivity: REVIEW_COMMENTS_ACTIVITY_ID,
      navigation: {
        contributionId: codeNavigationContribution.id,
        location: createDefaultCodeNavigationState(repo.id),
      },
      updatedAt: "2026-08-20T00:00:00.000Z",
    })

    const restoration = session.restore(repo)
    availableActivities = availableActivities.filter(
      (activity) => activity.id !== REVIEW_COMMENTS_ACTIVITY_ID,
    )
    release?.(Option.some(persisted))
    const restored = await restoration
    const restoredProjection = ProjectSessionRestoreResult.$match(restored, {
      restored: ({ projection }) => projection,
      stale: () => {
        throw new Error("Expected restored project session, received stale result")
      },
      unavailable: () => {
        throw new Error("Expected restored project session, received unavailable result")
      },
    })
    if (
      ProjectSessionRestoreResult.$match(restored, {
        restored: ({ requiresPersistence }) => requiresPersistence,
        stale: () => false,
        unavailable: () => false,
      })
    ) {
      await session.persist(restoredProjection, () => true)
    }

    expect(restoredProjection).toMatchObject({
      activeSurface: "code",
      activeActivity: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
    })
    expect(restoredProjection.notice).toEqual(
      Option.some(
        "The saved workspace activity is unavailable. A registered activity was restored instead.",
      ),
    )
    expect(saveWorkspace).toHaveBeenCalledOnce()
  })

  it("leaves restoration unavailable without persisting when no activity is registered", async () => {
    const saveWorkspace = vi.fn<() => Promise<void>>(async () => undefined)
    const session = new ProjectSession({
      ...makeDependencies(),
      availableActivities: () => [],
      defaultActivity: () => Option.none(),
      persistence: makePersistence(saveWorkspace),
    })

    expect(session.initial(repo)).toEqual(Option.none())
    await expect(session.restore(repo)).resolves.toEqual({ _tag: "unavailable" })
    expect(saveWorkspace).not.toHaveBeenCalled()
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
    const pending = await session.openPullRequest("/workspace/diffdash", 42)
    expect(pending).toMatchObject({
      _tag: "remoteSelectionRequired",
      pending: { selection: remoteSelection },
    })
    const opened = await ProjectSessionOpenResult.$match(pending, {
      remoteSelectionRequired: ({ pending: selection }) => selection.resume(github),
      opened: () => {
        throw new Error("Expected remote selection, project was already opened")
      },
      unavailable: () => {
        throw new Error("Expected remote selection, project was unavailable")
      },
    })
    expect(opened).toMatchObject({
      _tag: "opened",
      projection: {
        activeSurface: "review",
        activeActivity: PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
        selectedReview: { kind: "hosted" },
      },
      analyticsEvent: Option.some({ event: "review_opened", reviewType: "pull_request" }),
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
      analyticsEvent: Option.some({ event: "review_opened", reviewType: "local_diff" }),
    })
  })

  it("returns unavailable when local review intent opens a project without a checkout", async () => {
    const hostedOnlyRepo = Repo.make({
      ...repo,
      checkout: RemoteOnly.make({ remoteUrl: "https://github.com/fungsi/diffdash" }),
    })
    const resolveLastCommit = vi
      .fn<(localPath: string) => Promise<LocalReviewTarget>>()
      .mockImplementation(makeDependencies().resolveLastCommit)
    const session = new ProjectSession({
      ...makeDependencies(),
      openProject: async () => ProjectOpened.make({ repo: hostedOnlyRepo }),
      resolveLastCommit,
    })

    await expect(session.openLastCommit("/workspace/diffdash")).resolves.toEqual({
      _tag: "unavailable",
    })
    expect(resolveLastCommit).not.toHaveBeenCalled()
  })

  it("returns unavailable when pull-request intent opens an unhosted project", async () => {
    const localRepo = Repo.make({
      ...repo,
      id: ReviewProjectId.make("local:workspace/diffdash"),
      source: LocalRepositorySource.make(),
    })
    const session = new ProjectSession({
      ...makeDependencies(),
      openProject: async () => ProjectOpened.make({ repo: localRepo }),
    })

    await expect(session.openPullRequest("/workspace/diffdash", 42)).resolves.toEqual({
      _tag: "unavailable",
    })
  })
})
