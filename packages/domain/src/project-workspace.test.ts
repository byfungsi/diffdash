import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

import { makeHostedReviewLocator } from "./git-provider"
import { BranchComparison, LocalReviewTarget, workingTreeReviewTarget } from "./local-review"
import {
  ProjectOpened,
  ProjectOpenResult,
  ProjectRemoteCandidate,
  ProjectRemoteSelectionRequired,
  ProjectWorkspaceRibbon,
  ProjectWorkspaceState,
  ProjectWorkspaceStateInput,
} from "./project-workspace"
import { Repo } from "./repository"
import { ReviewProjectId } from "./review-identity"
import { HostedReviewTarget } from "./review-thread"

const projectId = ReviewProjectId.make("github:fungsi/diffdash")

const targets = [
  HostedReviewTarget.make({
    kind: "hosted",
    review: makeHostedReviewLocator("github", "fungsi", "diffdash", 147),
  }),
  workingTreeReviewTarget("/workspace/diffdash"),
  LocalReviewTarget.make({
    kind: "local",
    rootPath: "/workspace/diffdash",
    comparison: BranchComparison.make({
      branchName: "main",
      baseRef: "refs/heads/main",
      baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
  }),
] as const

describe("project workspace", () => {
  it("models safe opened and ambiguous project-opening results", () => {
    const repository = makeHostedReviewLocator("github", "fungsi", "diffdash", 147).repository
    const forkCandidate = ProjectRemoteCandidate.make({
      remoteName: "upstream",
      repository: makeHostedReviewLocator("github", "fungsi", "diffdash-fork", 147).repository,
    })
    const repo = Repo.make({
      id: "github:fungsi/diffdash",
      provider: "github",
      owner: "fungsi",
      name: "diffdash",
      remoteUrl: "git@github.com:fungsi/diffdash.git",
      localPath: "/workspace/diffdash",
      isFavorite: false,
      lastOpenedAt: "2026-08-02T00:00:00.000Z",
      lastSyncedAt: "2026-08-02T00:00:00.000Z",
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    })

    expect(Schema.decodeUnknownSync(ProjectOpenResult)(ProjectOpened.make({ repo }))).toEqual(
      ProjectOpened.make({ repo }),
    )
    expect(
      Schema.encodeSync(ProjectOpenResult)(
        ProjectRemoteSelectionRequired.make({
          rootPath: "/workspace/diffdash",
          candidates: [
            ProjectRemoteCandidate.make({ remoteName: "origin", repository }),
            forkCandidate,
          ],
        }),
      ),
    ).toEqual({
      _tag: "remoteSelectionRequired",
      rootPath: "/workspace/diffdash",
      candidates: [
        { remoteName: "origin", repository },
        { remoteName: "upstream", repository: forkCandidate.repository },
      ],
    })
    expect(() =>
      Schema.decodeUnknownSync(ProjectOpenResult)({
        _tag: "remoteSelectionRequired",
        rootPath: "/workspace/diffdash",
        candidates: [{ remoteName: "origin", repository, remoteUrl: "private" }],
      }),
    ).toThrow(/at least 2 item/)
  })

  it("accepts exactly the supported ribbon values", () => {
    const decode = Schema.decodeUnknownSync(ProjectWorkspaceRibbon)

    expect(["reviews", "files", "walkthrough", "threads"].map((value) => decode(value))).toEqual([
      "reviews",
      "files",
      "walkthrough",
      "threads",
    ])
    expect(() => decode("settings")).toThrow(/Expected/)
  })

  it("models no selection and each complete hosted or local review target", () => {
    const decodeInput = Schema.decodeUnknownSync(ProjectWorkspaceStateInput)
    const selections = [null, ...targets]

    for (const selectedReviewTarget of selections) {
      const input = decodeInput({
        projectId,
        activeRibbon: "reviews",
        selectedReviewTarget,
      })
      expect(input.selectedReviewTarget).toEqual(selectedReviewTarget)
    }

    const branch = targets[2]
    expect(branch.comparison).toEqual(
      expect.objectContaining({
        _tag: "branch",
        branchName: "main",
        baseRef: "refs/heads/main",
        baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    )
  })

  it("returns persisted state with its update timestamp", () => {
    const state = ProjectWorkspaceState.make({
      projectId,
      activeRibbon: "threads",
      selectedReviewTarget: targets[0],
      updatedAt: "2026-08-02T00:00:00.000Z",
    })

    expect(state.updatedAt).toBe("2026-08-02T00:00:00.000Z")
  })
})
