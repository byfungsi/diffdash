import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

import { HostedRepositorySource, makeHostedReviewLocator } from "./git-provider"
import { BranchComparison, LocalReviewTarget, workingTreeReviewTarget } from "./local-review"
import {
  PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
  PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
  PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
  PROJECT_WORKSPACE_WALKTHROUGH_ACTIVITY_ID,
  ProjectOpened,
  ProjectOpenResult,
  ProjectRemoteCandidate,
  ProjectRemoteSelectionRequired,
  ProjectWorkspaceActivityId,
  ProjectWorkspaceState,
  ProjectWorkspaceStateInput,
  REVIEW_COMMENTS_ACTIVITY_ID,
  resolveProjectWorkspaceActivity,
  selectProjectWorkspaceActivity,
} from "./project-workspace"
import { LinkedCheckout, Repo, RepositoryCheckoutPath } from "./repository"
import { RepositoryComparisonRef } from "./repository-comparison"
import { ReviewProjectId, ReviewRevision } from "./review-identity"
import { HostedReviewTarget } from "./review-thread"

const projectId = ReviewProjectId.make("github:fungsi/diffdash")

const targets = [
  HostedReviewTarget.make({
    kind: "hosted",
    review: makeHostedReviewLocator("github", "fungsi", "diffdash", 147),
  }),
  workingTreeReviewTarget(RepositoryCheckoutPath.make("/workspace/diffdash")),
  LocalReviewTarget.make({
    kind: "local",
    rootPath: RepositoryCheckoutPath.make("/workspace/diffdash"),
    comparison: BranchComparison.make({
      branchName: RepositoryComparisonRef.make("main"),
      baseRef: RepositoryComparisonRef.make("refs/heads/main"),
      baseSha: ReviewRevision.make("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
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
      id: projectId,
      source: HostedRepositorySource.make({ locator: repository }),
      checkout: LinkedCheckout.make({
        remoteUrl: "git@github.com:fungsi/diffdash.git",
        path: RepositoryCheckoutPath.make("/workspace/diffdash"),
      }),
      isFavorite: false,
      lastOpenedAt: "2026-08-02T00:00:00.000Z",
      lastSyncedAt: "2026-08-02T00:00:00.000Z",
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    })

    const opened = ProjectOpened.make({ repo })
    expect(
      Schema.decodeUnknownSync(ProjectOpenResult)(Schema.encodeSync(ProjectOpenResult)(opened)),
    ).toEqual(opened)
    expect(
      Schema.encodeSync(ProjectOpenResult)(
        ProjectRemoteSelectionRequired.make({
          rootPath: RepositoryCheckoutPath.make("/workspace/diffdash"),
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
    ).toThrow(/at least 2/)
  })

  it("accepts bounded namespaced project activity IDs", () => {
    const decode = Schema.decodeUnknownSync(ProjectWorkspaceActivityId)

    expect(decode("diffdash.builtin.review-comments.comments")).toBe(REVIEW_COMMENTS_ACTIVITY_ID)
    expect(() => decode("comments")).toThrow(/namespaced project workspace activity ID/)
    expect(() => decode("DiffDash.core.reviews")).toThrow(
      /namespaced project workspace activity ID/,
    )
    expect(() => decode(`diffdash.extension.${"a".repeat(110)}`)).toThrow(/at most 128/)
  })

  it("provides stable IDs for built-in project activities", () => {
    expect([
      PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
      PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
      PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
      PROJECT_WORKSPACE_WALKTHROUGH_ACTIVITY_ID,
      REVIEW_COMMENTS_ACTIVITY_ID,
    ]).toEqual([
      "diffdash.core.reviews",
      "diffdash.core.files",
      "diffdash.core.code",
      "diffdash.core.walkthrough",
      "diffdash.builtin.review-comments.comments",
    ])
  })

  it("selects or preserves the source surface according to activity policy", () => {
    const reviewSelection = {
      activeSurface: "review" as const,
      activeActivity: PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
    }

    expect(
      selectProjectWorkspaceActivity(reviewSelection, PROJECT_WORKSPACE_CODE_ACTIVITY_ID, "code"),
    ).toEqual({
      activeSurface: "code",
      activeActivity: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
    })
    expect(
      selectProjectWorkspaceActivity(
        reviewSelection,
        PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
        "review",
      ),
    ).toEqual({
      activeSurface: "review",
      activeActivity: PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
    })
    expect(
      selectProjectWorkspaceActivity(reviewSelection, REVIEW_COMMENTS_ACTIVITY_ID, "preserve"),
    ).toEqual({
      activeSurface: "review",
      activeActivity: REVIEW_COMMENTS_ACTIVITY_ID,
    })
  })

  it("repairs unavailable activities based on the retained source surface", () => {
    const availableActivityIds = [
      PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
      PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
      REVIEW_COMMENTS_ACTIVITY_ID,
    ]
    const availableSelection = {
      activeSurface: "review" as const,
      activeActivity: REVIEW_COMMENTS_ACTIVITY_ID,
    }

    expect(resolveProjectWorkspaceActivity(availableSelection, availableActivityIds)).toEqual({
      _tag: "available",
      selection: availableSelection,
    })
    expect(
      resolveProjectWorkspaceActivity(
        {
          activeSurface: "code",
          activeActivity: ProjectWorkspaceActivityId.make("example.extension.missing"),
        },
        availableActivityIds,
      ),
    ).toEqual({
      _tag: "repaired",
      selection: {
        activeSurface: "code",
        activeActivity: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
      },
      unavailableActivity: "example.extension.missing",
    })
    expect(
      resolveProjectWorkspaceActivity(
        {
          activeSurface: "review",
          activeActivity: ProjectWorkspaceActivityId.make("example.extension.missing"),
        },
        availableActivityIds,
      ),
    ).toEqual({
      _tag: "repaired",
      selection: {
        activeSurface: "review",
        activeActivity: PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
      },
      unavailableActivity: "example.extension.missing",
    })
    expect(
      resolveProjectWorkspaceActivity(
        {
          activeSurface: "review",
          activeActivity: ProjectWorkspaceActivityId.make("example.extension.missing"),
        },
        [PROJECT_WORKSPACE_FILES_ACTIVITY_ID],
      ),
    ).toEqual({
      _tag: "repaired",
      selection: {
        activeSurface: "review",
        activeActivity: PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
      },
      unavailableActivity: "example.extension.missing",
    })
    expect(
      resolveProjectWorkspaceActivity(
        {
          activeSurface: "code",
          activeActivity: ProjectWorkspaceActivityId.make("example.extension.missing"),
        },
        [PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID],
      ),
    ).toEqual({
      _tag: "unresolved",
      selection: {
        activeSurface: "code",
        activeActivity: "example.extension.missing",
      },
      unavailableActivity: "example.extension.missing",
    })
  })

  it("models no selection and each complete hosted or local review target", () => {
    const decodeInput = Schema.decodeUnknownSync(ProjectWorkspaceStateInput)
    const selections = [null, ...targets]

    for (const selectedReviewTarget of selections) {
      const input = decodeInput({
        projectId,
        activeSurface: "review",
        activeActivity: PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
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
      activeSurface: "review",
      activeActivity: REVIEW_COMMENTS_ACTIVITY_ID,
      selectedReviewTarget: targets[0],
      updatedAt: "2026-08-02T00:00:00.000Z",
    })

    expect(state.updatedAt).toBe("2026-08-02T00:00:00.000Z")
  })
})
