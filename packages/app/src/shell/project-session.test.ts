import { HostedRepositorySource, makeHostedRepositoryLocator } from "@diffdash/domain/git-provider"
import {
  ProjectOpened,
  ProjectRemoteCandidate,
  ProjectRemoteSelectionRequired,
  ProjectWorkspaceState,
} from "@diffdash/domain/project-workspace"
import { LinkedCheckout, Repo, RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
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
  loadWorkspace: async () => Option.none<ProjectWorkspaceState>(),
  openProject: async () => ProjectOpened.make({ repo }),
  resolveLocalReview: async () => {
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
        if (input.activeRibbon === "files") await firstWait
        committed.push(input.activeRibbon)
      },
    })

    const first = session.persist(session.project(repo, "files", null))
    const second = session.persist(session.project(repo, "threads", null))
    await Promise.resolve()
    expect(committed).toEqual([])
    firstGate.release()
    await Promise.all([first, second])
    expect(committed).toEqual(["files", "threads"])
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
    session.project(repo, "threads", null)
    release?.(Option.none())

    await expect(restoration).resolves.toEqual({ _tag: "stale" })
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
      projection: { activeRibbon: "files", selectedReview: { kind: "hosted" } },
      reviewType: "pull_request",
    })
    expect(openProject).toHaveBeenLastCalledWith("/workspace/diffdash", Option.some(github))
  })
})
