import {
  HostedRepositorySource,
  makeHostedRepositoryLocator,
  type HostedRepositoryLocator,
} from "@diffdash/domain/git-provider"
import {
  ProjectOpened,
  type ProjectOpenResult,
  ProjectRemoteCandidate,
  ProjectRemoteSelectionRequired,
  ProjectWorkspaceState,
  type ProjectWorkspaceStateInput,
} from "@diffdash/domain/project-workspace"
import { LinkedCheckout, Repo, RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { Option } from "effect"
import { describe, expect, it, vi } from "vitest"

import { REVIEW_COMMENTS_ACTIVITY_ID } from "../review-comments/review-comments-extension"
import { PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID } from "../review/review-identities"
import {
  encodeReviewNavigationState,
  reviewNavigationContribution,
} from "../review/review-navigation"
import { PROJECT_WORKSPACE_CODE_ACTIVITY_ID } from "./code-extension"
import {
  CodeProjectSession,
  CodeProjectSessionOpenResult,
  CodeProjectSessionRestoreResult,
} from "./code-project-session"
import { codeNavigationContribution, createDefaultCodeNavigationState } from "./code-navigation"
import { ProjectWorkspacePersistenceCoordinator } from "../project-workspace-persistence"

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
  lastOpenedAt: "2026-08-25T00:00:00.000Z",
  lastSyncedAt: null,
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
})

const makePersistence = (
  persistWorkspace: (input: ProjectWorkspaceStateInput) => Promise<void> = async () => undefined,
) => new ProjectWorkspacePersistenceCoordinator(persistWorkspace).createGeneration()

const makeDependencies = () => ({
  availableNavigation: () => [codeNavigationContribution],
  availableActivities: () => [
    {
      id: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
      supportedSurfaces: ["code" as const],
      defaultForSurfaces: ["code" as const],
    },
    {
      id: REVIEW_COMMENTS_ACTIVITY_ID,
      supportedSurfaces: ["code" as const, "review" as const],
      defaultForSurfaces: [],
    },
  ],
  loadWorkspace: async () => Option.none<ProjectWorkspaceState>(),
  openProject: async () => ProjectOpened.make({ repo }),
  persistence: makePersistence(),
})

describe("CodeProjectSession", () => {
  it("continues remote selection and persists the default Code destination without Review state", async () => {
    const saveWorkspace = vi.fn<(input: ProjectWorkspaceStateInput) => Promise<void>>(
      async () => undefined,
    )
    const openProject = vi
      .fn<
        (
          localPath: string,
          selectedRepository: Option.Option<HostedRepositoryLocator>,
        ) => Promise<ProjectOpenResult>
      >()
      .mockResolvedValueOnce(
        ProjectRemoteSelectionRequired.make({
          rootPath: RepositoryCheckoutPath.make("/workspace/diffdash"),
          candidates: [
            ProjectRemoteCandidate.make({ remoteName: "origin", repository: github }),
            ProjectRemoteCandidate.make({ remoteName: "upstream", repository: gitlab }),
          ],
        }),
      )
      .mockResolvedValueOnce(ProjectOpened.make({ repo }))
    const session = new CodeProjectSession({
      ...makeDependencies(),
      openProject,
      persistence: makePersistence(saveWorkspace),
    })

    const first = await session.openProject("/workspace/diffdash")
    const opened = await CodeProjectSessionOpenResult.$match(first, {
      remoteSelectionRequired: ({ resume }) => resume(github),
      opened: (result) => Promise.resolve(CodeProjectSessionOpenResult.opened(result)),
      unavailable: () => Promise.resolve(CodeProjectSessionOpenResult.unavailable()),
    })
    const projection = CodeProjectSessionOpenResult.$match(opened, {
      opened: ({ projection: openedProjection }) => openedProjection,
      remoteSelectionRequired: () => {
        throw new Error("Expected Code project to open after remote selection")
      },
      unavailable: () => {
        throw new Error("Expected Code project to be available")
      },
    })
    await session.persist(projection, () => true)

    expect(openProject).toHaveBeenNthCalledWith(1, "/workspace/diffdash", Option.none())
    expect(openProject).toHaveBeenNthCalledWith(2, "/workspace/diffdash", Option.some(github))
    expect(projection).toMatchObject({
      repo,
      activeSurface: "code",
      activeActivity: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
    })
    expect(saveWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        activeSurface: "code",
        activeActivity: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
        navigation: expect.objectContaining({ contributionId: codeNavigationContribution.id }),
      }),
    )
  })

  it("repairs a persisted Review destination to Code and saves the repaired state", async () => {
    const saveWorkspace = vi.fn<(input: ProjectWorkspaceStateInput) => Promise<void>>(
      async () => undefined,
    )
    const persisted = ProjectWorkspaceState.make({
      projectId: repo.id,
      activeSurface: "review",
      activeActivity: PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
      navigation: {
        contributionId: reviewNavigationContribution.id,
        location: encodeReviewNavigationState({ selectedReview: Option.none() }),
      },
      updatedAt: "2026-08-25T00:00:00.000Z",
    })
    const session = new CodeProjectSession({
      ...makeDependencies(),
      availableActivities: () => [
        ...makeDependencies().availableActivities(),
        {
          id: PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
          supportedSurfaces: ["review" as const],
          defaultForSurfaces: ["review" as const],
        },
      ],
      availableNavigation: () => [codeNavigationContribution, reviewNavigationContribution],
      loadWorkspace: async () => Option.some(persisted),
      persistence: makePersistence(saveWorkspace),
    })

    const result = await session.restore(repo)
    const restored = CodeProjectSessionRestoreResult.$match(result, {
      restored: (value) => value,
      stale: () => {
        throw new Error("Expected repaired Code restoration")
      },
      unavailable: () => {
        throw new Error("Expected Code restoration to be available")
      },
    })
    if (restored.requiresPersistence) await session.persist(restored.projection, () => true)

    expect(restored.projection).toMatchObject({
      activeSurface: "code",
      activeActivity: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
      state: createDefaultCodeNavigationState(repo.id),
    })
    expect(saveWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        navigation: {
          contributionId: codeNavigationContribution.id,
          location: createDefaultCodeNavigationState(repo.id),
        },
      }),
    )
  })

  it("orders a replacement generation after an old in-flight save and invalidates old queued work", async () => {
    let releaseRestore: ((state: Option.Option<ProjectWorkspaceState>) => void) | undefined
    let releaseFirstSave: (() => void) | undefined
    const firstSave = new Promise<void>((resolve) => {
      releaseFirstSave = resolve
    })
    const committed: string[] = []
    let persistedActivity = PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID
    const coordinator = new ProjectWorkspacePersistenceCoordinator(async (input) => {
      if (committed.length === 0) await firstSave
      committed.push(input.activeActivity)
      persistedActivity = input.activeActivity
    })
    const oldSession = new CodeProjectSession({
      ...makeDependencies(),
      loadWorkspace: () =>
        new Promise((resolve) => {
          releaseRestore = resolve
        }),
      persistence: coordinator.createGeneration(),
    })
    const firstProjection = Option.getOrThrow(oldSession.initial(repo))
    const first = oldSession.persist(firstProjection, () => true)
    const stale = oldSession.persist(
      {
        ...firstProjection,
        activeActivity: REVIEW_COMMENTS_ACTIVITY_ID,
      },
      () => true,
    )
    const restoration = oldSession.restore(repo)
    await Promise.resolve()
    oldSession.dispose()
    const newSession = new CodeProjectSession({
      ...makeDependencies(),
      persistence: coordinator.createGeneration(),
    })
    const current = newSession.persist(
      {
        ...Option.getOrThrow(newSession.initial(repo)),
        activeActivity: REVIEW_COMMENTS_ACTIVITY_ID,
      },
      () => true,
    )
    releaseRestore?.(Option.none())
    releaseFirstSave?.()

    await expect(Promise.all([first, stale, current])).resolves.toEqual([true, false, true])
    await expect(restoration).resolves.toEqual({ _tag: "stale" })
    expect(committed).toEqual([PROJECT_WORKSPACE_CODE_ACTIVITY_ID, REVIEW_COMMENTS_ACTIVITY_ID])
    expect(persistedActivity).toBe(REVIEW_COMMENTS_ACTIVITY_ID)
  })

  it("does not persist a valid Code payload attributed to another navigation contribution", async () => {
    const saveWorkspace = vi.fn<(input: ProjectWorkspaceStateInput) => Promise<void>>(
      async () => undefined,
    )
    const session = new CodeProjectSession({
      ...makeDependencies(),
      persistence: makePersistence(saveWorkspace),
    })
    const projection = Option.getOrThrow(session.initial(repo))

    await session.persist(
      { ...projection, contributionId: reviewNavigationContribution.id },
      () => true,
    )

    expect(saveWorkspace).not.toHaveBeenCalled()
  })
})
