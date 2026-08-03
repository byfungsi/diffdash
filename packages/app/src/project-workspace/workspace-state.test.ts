import { makeHostedReviewLocator } from "@diffdash/domain/git-provider"
import { workingTreeReviewTarget } from "@diffdash/domain/local-review"
import { ProjectWorkspaceState } from "@diffdash/domain/project-workspace"
import { ProjectWorkspaceStateInput } from "@diffdash/domain/project-workspace"
import { Repo } from "@diffdash/domain/repository"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { HostedReviewTarget } from "@diffdash/domain/review-thread"
import { describe, expect, it } from "vitest"

import {
  enqueueProjectWorkspaceSave,
  projectIdForRepo,
  resolveProjectWorkspaceState,
  selectedReviewTargetForPersistence,
} from "./workspace-state"

const repo = Repo.make({
  id: "github:fungsi/diffdash",
  provider: "github",
  owner: "fungsi",
  name: "diffdash",
  remoteUrl: "https://github.com/fungsi/diffdash",
  localPath: "/workspace/diffdash",
  isFavorite: true,
  lastOpenedAt: "2026-08-02T00:00:00.000Z",
  lastSyncedAt: null,
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
})
const ignoreSaveFailure = () => undefined

describe("project workspace state", () => {
  it("defaults a first open to Reviews without a selection", () => {
    expect(resolveProjectWorkspaceState(repo, null)).toEqual({
      activeRibbon: "reviews",
      notice: null,
      selectedReview: null,
    })
  })

  it("restores hosted and local targets losslessly", () => {
    const hosted = HostedReviewTarget.make({
      kind: "hosted",
      review: makeHostedReviewLocator("github", "fungsi", "diffdash", 51),
    })
    const local = workingTreeReviewTarget("/workspace/diffdash")

    expect(
      resolveProjectWorkspaceState(
        repo,
        ProjectWorkspaceState.make({
          projectId: projectIdForRepo(repo),
          activeRibbon: "threads",
          selectedReviewTarget: hosted,
          updatedAt: "2026-08-02T00:00:00.000Z",
        }),
      ),
    ).toEqual({
      activeRibbon: "threads",
      notice: null,
      selectedReview: { kind: "hosted", review: hosted.review },
    })
    expect(selectedReviewTargetForPersistence({ kind: "localDiff", target: local })).toEqual(local)
  })

  it("falls back visibly for malformed, mismatched, and foreign targets", () => {
    const malformed = resolveProjectWorkspaceState(repo, { activeRibbon: "files" })
    const mismatched = resolveProjectWorkspaceState(
      repo,
      ProjectWorkspaceState.make({
        projectId: ReviewProjectId.make("github:other/project"),
        activeRibbon: "files",
        selectedReviewTarget: null,
        updatedAt: "2026-08-02T00:00:00.000Z",
      }),
    )
    const foreign = resolveProjectWorkspaceState(
      repo,
      ProjectWorkspaceState.make({
        projectId: projectIdForRepo(repo),
        activeRibbon: "files",
        selectedReviewTarget: HostedReviewTarget.make({
          kind: "hosted",
          review: makeHostedReviewLocator("github", "other", "project", 1),
        }),
        updatedAt: "2026-08-02T00:00:00.000Z",
      }),
    )

    for (const resolved of [malformed, mismatched, foreign]) {
      expect(resolved.activeRibbon).toBe("reviews")
      expect(resolved.selectedReview).toBeNull()
      expect(resolved.notice).not.toBeNull()
    }
  })

  it("serializes workspace writes so the latest requested selection commits last", async () => {
    const firstGate: { release: () => void } = { release: () => undefined }
    const firstWait = new Promise<void>((resolve) => {
      firstGate.release = resolve
    })
    const committed: string[] = []
    const save = async (input: ProjectWorkspaceStateInput) => {
      if (input.activeRibbon === "files") await firstWait
      committed.push(input.activeRibbon)
    }
    const files = ProjectWorkspaceStateInput.make({
      projectId: projectIdForRepo(repo),
      activeRibbon: "files",
      selectedReviewTarget: null,
    })
    const threads = ProjectWorkspaceStateInput.make({
      projectId: projectIdForRepo(repo),
      activeRibbon: "threads",
      selectedReviewTarget: null,
    })

    const first = enqueueProjectWorkspaceSave(Promise.resolve(), files, save, ignoreSaveFailure)
    const second = enqueueProjectWorkspaceSave(first, threads, save, ignoreSaveFailure)
    await Promise.resolve()
    expect(committed).toEqual([])
    firstGate.release()
    await second
    expect(committed).toEqual(["files", "threads"])
  })
})
