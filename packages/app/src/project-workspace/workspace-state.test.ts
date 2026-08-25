import {
  HostedRepositorySource,
  makeHostedRepositoryLocator,
  makeHostedReviewLocator,
} from "@diffdash/domain/git-provider"
import {
  ProjectWorkspaceNavigationContributionId,
  ProjectWorkspaceState,
} from "@diffdash/domain/project-workspace"
import { LinkedCheckout, Repo, RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { Option } from "effect"
import { describe, expect, it } from "vitest"

import {
  CODE_PROJECT_ACTIVITY,
  PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
} from "@/extensions/code/code-extension"
import {
  codeNavigationContribution,
  createDefaultCodeNavigationState,
} from "@/extensions/code/code-navigation"
import {
  PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
  REVIEW_PROJECT_ACTIVITIES,
} from "@/extensions/review/review-extension"
import {
  encodeReviewNavigationState,
  reviewNavigationContribution,
} from "@/extensions/review/review-navigation"
import { resolveProjectWorkspaceState } from "./workspace-state"

const availableActivities = [...REVIEW_PROJECT_ACTIVITIES, CODE_PROJECT_ACTIVITY].map(
  (activity) => ({
    id: activity.id,
    supportedSurfaces: activity.supportedSurfaces,
    defaultForSurfaces: activity.defaultForSurfaces ?? [],
  }),
)
const availableNavigation = [reviewNavigationContribution, codeNavigationContribution]
const repo = Repo.make({
  id: ReviewProjectId.make("github:fungsi/diffdash"),
  source: HostedRepositorySource.make({
    locator: makeHostedRepositoryLocator("github", "fungsi", "diffdash"),
  }),
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

const resolve = (persisted: ProjectWorkspaceState | null, navigation = availableNavigation) =>
  resolveProjectWorkspaceState(repo, persisted, availableActivities, navigation)

describe("project workspace state", () => {
  it("defaults a first open through the registered Review codec", () => {
    expect(resolve(null)).toEqual({
      _tag: "resolved",
      activeSurface: "review",
      activeActivity: PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
      navigationContributionId: reviewNavigationContribution.id,
      navigationLocation: encodeReviewNavigationState({ selectedReview: Option.none() }),
      notice: Option.none(),
    })
  })

  it("restores exact Review owner state", () => {
    const location = encodeReviewNavigationState({
      selectedReview: Option.some({
        kind: "hosted",
        review: makeHostedReviewLocator("github", "fungsi", "diffdash", 51),
      }),
    })
    const restored = resolve(
      ProjectWorkspaceState.make({
        projectId: repo.id,
        activeSurface: "review",
        activeActivity: PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
        navigation: { contributionId: reviewNavigationContribution.id, location },
        updatedAt: "2026-08-25T00:00:00.000Z",
      }),
    )
    expect(restored).toMatchObject({
      _tag: "resolved",
      navigationContributionId: reviewNavigationContribution.id,
      navigationLocation: location,
    })
  })

  it("restores exact opaque Code owner state", () => {
    const location = createDefaultCodeNavigationState(repo.id)
    const restored = resolve(
      ProjectWorkspaceState.make({
        projectId: repo.id,
        activeSurface: "code",
        activeActivity: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
        navigation: { contributionId: codeNavigationContribution.id, location },
        updatedAt: "2026-08-25T00:00:00.000Z",
      }),
    )
    expect(restored).toMatchObject({
      _tag: "resolved",
      navigationContributionId: codeNavigationContribution.id,
      navigationLocation: location,
    })
  })

  it("repairs a missing navigation owner through a registered default", () => {
    const restored = resolve(
      ProjectWorkspaceState.make({
        projectId: repo.id,
        activeSurface: "review",
        activeActivity: PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
        navigation: {
          contributionId: ProjectWorkspaceNavigationContributionId.make(
            "example.removed.navigation",
          ),
          location: { opaque: true },
        },
        updatedAt: "2026-08-25T00:00:00.000Z",
      }),
    )
    expect(restored).toMatchObject({
      _tag: "resolved",
      navigationContributionId: reviewNavigationContribution.id,
      navigationLocation: encodeReviewNavigationState({ selectedReview: Option.none() }),
    })
  })
})
