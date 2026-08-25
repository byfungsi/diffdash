import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

import { HostedRepositorySource, makeHostedReviewLocator } from "./git-provider"
import { BranchComparison, LocalReviewTarget, workingTreeReviewTarget } from "./local-review"
import {
  ProjectOpened,
  ProjectOpenResult,
  ProjectRemoteCandidate,
  ProjectRemoteSelectionRequired,
  ProjectWorkspaceActivityId,
  ProjectWorkspaceNavigationContributionId,
  ProjectWorkspaceNavigationEnvelope,
  ProjectWorkspaceNavigationLocation,
  ProjectWorkspaceState,
  ProjectWorkspaceStateInput,
  resolveProjectWorkspaceActivity,
  selectProjectWorkspaceActivity,
} from "./project-workspace"
import { LinkedCheckout, Repo, RepositoryCheckoutPath } from "./repository"
import { RepositoryComparisonRef } from "./repository-comparison"
import { ReviewProjectId, ReviewRevision } from "./review-identity"
import { HostedReviewTarget } from "./review-thread"

const projectId = ReviewProjectId.make("github:fungsi/diffdash")
const reviewsActivityId = ProjectWorkspaceActivityId.make("diffdash.fixture.reviews")
const filesActivityId = ProjectWorkspaceActivityId.make("diffdash.fixture.files")
const codeActivityId = ProjectWorkspaceActivityId.make("diffdash.fixture.code")
const commentsActivityId = ProjectWorkspaceActivityId.make("diffdash.fixture.comments")

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

    expect(decode("diffdash.fixture.comments")).toBe(commentsActivityId)
    expect(() => decode("comments")).toThrow(/namespaced project workspace activity ID/)
    expect(() => decode("DiffDash.core.reviews")).toThrow(
      /namespaced project workspace activity ID/,
    )
    expect(() => decode(`diffdash.extension.${"a".repeat(110)}`)).toThrow(/at most 128/)
  })

  it("selects or preserves the source surface according to activity policy", () => {
    const reviewSelection = {
      activeSurface: "review" as const,
      activeActivity: reviewsActivityId,
    }

    expect(selectProjectWorkspaceActivity(reviewSelection, codeActivityId, "code")).toEqual({
      activeSurface: "code",
      activeActivity: codeActivityId,
    })
    expect(selectProjectWorkspaceActivity(reviewSelection, filesActivityId, "review")).toEqual({
      activeSurface: "review",
      activeActivity: filesActivityId,
    })
    expect(selectProjectWorkspaceActivity(reviewSelection, commentsActivityId, "preserve")).toEqual(
      {
        activeSurface: "review",
        activeActivity: commentsActivityId,
      },
    )
  })

  it("repairs unavailable activities based on the retained source surface", () => {
    const availableActivities = [
      {
        id: reviewsActivityId,
        supportedSurfaces: ["review" as const],
        defaultForSurfaces: ["review" as const],
      },
      {
        id: codeActivityId,
        supportedSurfaces: ["code" as const],
        defaultForSurfaces: ["code" as const],
      },
      {
        id: commentsActivityId,
        supportedSurfaces: ["review" as const, "code" as const],
        defaultForSurfaces: [],
      },
    ]
    const availableSelection = {
      activeSurface: "review" as const,
      activeActivity: commentsActivityId,
    }

    expect(resolveProjectWorkspaceActivity(availableSelection, availableActivities)).toEqual({
      _tag: "available",
      selection: availableSelection,
    })
    expect(
      resolveProjectWorkspaceActivity(
        {
          activeSurface: "code",
          activeActivity: ProjectWorkspaceActivityId.make("example.extension.missing"),
        },
        availableActivities,
      ),
    ).toEqual({
      _tag: "repaired",
      selection: {
        activeSurface: "code",
        activeActivity: codeActivityId,
      },
      unavailableActivity: "example.extension.missing",
    })
    expect(
      resolveProjectWorkspaceActivity(
        {
          activeSurface: "review",
          activeActivity: ProjectWorkspaceActivityId.make("example.extension.missing"),
        },
        availableActivities,
      ),
    ).toEqual({
      _tag: "repaired",
      selection: {
        activeSurface: "review",
        activeActivity: reviewsActivityId,
      },
      unavailableActivity: "example.extension.missing",
    })
    expect(
      resolveProjectWorkspaceActivity(
        {
          activeSurface: "review",
          activeActivity: ProjectWorkspaceActivityId.make("example.extension.missing"),
        },
        [
          {
            id: filesActivityId,
            supportedSurfaces: ["review"],
            defaultForSurfaces: [],
          },
        ],
      ),
    ).toEqual({
      _tag: "repaired",
      selection: {
        activeSurface: "review",
        activeActivity: filesActivityId,
      },
      unavailableActivity: "example.extension.missing",
    })
    expect(
      resolveProjectWorkspaceActivity(
        {
          activeSurface: "code",
          activeActivity: ProjectWorkspaceActivityId.make("example.extension.missing"),
        },
        [
          {
            id: reviewsActivityId,
            supportedSurfaces: ["review"],
            defaultForSurfaces: ["review"],
          },
        ],
      ),
    ).toEqual({
      _tag: "repaired",
      selection: {
        activeSurface: "review",
        activeActivity: reviewsActivityId,
      },
      unavailableActivity: "example.extension.missing",
    })
    expect(
      resolveProjectWorkspaceActivity(
        {
          activeSurface: "review",
          activeActivity: ProjectWorkspaceActivityId.make("example.extension.missing"),
        },
        [],
      ),
    ).toEqual({
      _tag: "unresolved",
      unavailableActivity: "example.extension.missing",
    })
  })

  it("round trips bounded opaque navigation without interpreting owner fields", () => {
    const decodeInput = Schema.decodeUnknownSync(ProjectWorkspaceStateInput)
    const navigation = {
      contributionId: "example.extension.navigation",
      location: { transformed: ["opaque", null, { nested: true }] },
    }
    const input = decodeInput({
      projectId,
      activeSurface: "review",
      activeActivity: reviewsActivityId,
      navigation,
    })
    expect(Schema.encodeSync(ProjectWorkspaceStateInput)(input)).toEqual({
      projectId,
      activeSurface: "review",
      activeActivity: reviewsActivityId,
      navigation,
    })

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

  it("bounds serialized navigation locations by UTF-8 bytes", () => {
    const decode = Schema.decodeUnknownSync(ProjectWorkspaceNavigationLocation)
    const serializedEmptyPayloadBytes = JSON.stringify({ payload: "" }).length
    const asciiBoundary = {
      payload: "x".repeat(1_048_576 - serializedEmptyPayloadBytes),
    }
    const multibyteOversized = {
      payload: "🚀".repeat(Math.floor((1_048_576 - serializedEmptyPayloadBytes) / 4) + 1),
    }

    expect(JSON.stringify(asciiBoundary)).toHaveLength(1_048_576)
    expect(decode(asciiBoundary)).toEqual(asciiBoundary)
    expect(JSON.stringify(multibyteOversized).length).toBeLessThan(1_048_576)
    expect(() => decode(multibyteOversized)).toThrow(
      /project workspace navigation location no larger than one MiB/,
    )
  })

  it("returns persisted state with its update timestamp", () => {
    const state = ProjectWorkspaceState.make({
      projectId,
      activeSurface: "review",
      activeActivity: commentsActivityId,
      navigation: ProjectWorkspaceNavigationEnvelope.make({
        contributionId: ProjectWorkspaceNavigationContributionId.make(
          "example.extension.navigation",
        ),
        location: { selectedReview: null },
      }),
      updatedAt: "2026-08-02T00:00:00.000Z",
    })

    expect(state.updatedAt).toBe("2026-08-02T00:00:00.000Z")
  })
})
