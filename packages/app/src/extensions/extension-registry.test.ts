import {
  PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
  ProjectWorkspaceActivityId,
} from "@diffdash/domain/project-workspace"
import { Option, Result } from "effect"
import { describe, expect, it } from "vitest"

import {
  type ProjectActivityContribution,
  type TrustedBuiltInExtension,
  DuplicateTrustedContributionError,
  DuplicateTrustedExtensionError,
  makeTrustedExtensionRegistry,
  TrustedExtensionContributionId,
  TrustedExtensionId,
  TrustedExtensionRegistry,
} from "./extension-registry"
import {
  REVIEW_COMMENTS_ACTIVITY,
  REVIEW_COMMENTS_CONNECTION_ACTION_ID,
  REVIEW_COMMENTS_EXTENSION_ID,
  REVIEW_COMMENTS_PROJECT_PROVIDER_ID,
  REVIEW_COMMENTS_REVIEW_DIFF_ID,
  reviewCommentsExtension,
} from "./review-comments/review-comments-extension"

const extension = (
  id: string,
  projectActivities: readonly ProjectActivityContribution[] = [],
): TrustedBuiltInExtension => ({
  id: TrustedExtensionId.make(id),
  projectActivities,
})

const compose = (extensions: readonly TrustedBuiltInExtension[]): TrustedExtensionRegistry =>
  Result.getOrThrow(makeTrustedExtensionRegistry(extensions))

describe("TrustedExtensionRegistry", () => {
  it("orders equal-priority contributions by ID independently of registration order", () => {
    const first = extension("example.first.extension", [
      {
        id: PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
        label: "Reviews",
        icon: "reviews",
        order: 500,
        supportedSurfaces: ["review"],
        surfacePolicy: "review",
      },
    ])
    const registry = compose([reviewCommentsExtension, first])

    expect(registry.snapshot().projectActivities).toEqual([
      expect.objectContaining({
        id: REVIEW_COMMENTS_ACTIVITY.id,
        ownerExtensionId: REVIEW_COMMENTS_EXTENSION_ID,
      }),
      expect.objectContaining({
        id: PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
        ownerExtensionId: first.id,
      }),
    ])
  })

  it("returns correlated duplicate failures without partial registration", () => {
    const registry = compose([reviewCommentsExtension])
    const duplicateExtension = registry.register(reviewCommentsExtension)
    const duplicateContribution = registry.register(
      extension("example.duplicate.extension", [
        {
          ...REVIEW_COMMENTS_ACTIVITY,
          label: "Duplicate",
        },
        {
          id: PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
          label: "Reviews",
          icon: "reviews",
          order: 100,
          supportedSurfaces: ["review"],
          surfacePolicy: "review",
        },
      ]),
    )

    expect(Option.getOrThrow(Result.getFailure(duplicateExtension))).toEqual(
      DuplicateTrustedExtensionError.make({
        extensionId: REVIEW_COMMENTS_EXTENSION_ID,
        message: `Trusted extension already registered: ${REVIEW_COMMENTS_EXTENSION_ID}`,
      }),
    )
    expect(Option.getOrThrow(Result.getFailure(duplicateContribution))).toEqual(
      DuplicateTrustedContributionError.make({
        extensionId: TrustedExtensionId.make("example.duplicate.extension"),
        contributionId: REVIEW_COMMENTS_ACTIVITY.id,
        message: `Trusted extension contribution already registered: ${REVIEW_COMMENTS_ACTIVITY.id}`,
      }),
    )
    expect(registry.snapshot().projectActivities).toHaveLength(1)
  })

  it("rejects duplicate IDs across slots in one extension", () => {
    const contributionId = TrustedExtensionContributionId.make("example.shared.contribution")
    const result = new TrustedExtensionRegistry().register({
      id: TrustedExtensionId.make("example.cross-slot.extension"),
      codeSourceContributions: [{ id: contributionId, order: 1, component: () => null }],
      titlebarActions: [{ id: contributionId, order: 2, component: () => null }],
    })

    expect(Result.isFailure(result)).toBe(true)
  })

  it("disposes every contribution slot without letting a stale disposer remove a replacement", () => {
    const fullExtension: TrustedBuiltInExtension = {
      id: TrustedExtensionId.make("example.full.extension"),
      projectActivities: [
        {
          id: ProjectWorkspaceActivityId.make("example.full.activity"),
          label: "Full",
          icon: "comments",
          order: 1,
          supportedSurfaces: ["code", "review"],
          surfacePolicy: "preserve",
        },
      ],
      codeSourceContributions: [
        {
          id: TrustedExtensionContributionId.make("example.full.code"),
          order: 1,
          component: () => null,
        },
      ],
      reviewDiffContributions: [
        {
          id: TrustedExtensionContributionId.make("example.full.review"),
          order: 1,
          component: () => null,
        },
      ],
      projectProviders: [
        {
          id: TrustedExtensionContributionId.make("example.full.provider"),
          order: 1,
          component: ({ children }) => children,
        },
      ],
      titlebarActions: [
        {
          id: TrustedExtensionContributionId.make("example.full.titlebar"),
          order: 1,
          component: () => null,
        },
      ],
    }
    const registry = new TrustedExtensionRegistry()
    const dispose = Result.getOrThrow(registry.register(fullExtension))

    dispose()
    dispose()
    expect(registry.snapshot()).toEqual({
      projectActivities: [],
      codeSourceContributions: [],
      reviewDiffContributions: [],
      projectProviders: [],
      titlebarActions: [],
    })

    Result.getOrThrow(registry.register(fullExtension))
    dispose()
    expect(registry.snapshot().projectActivities).toHaveLength(1)
    expect(registry.snapshot().codeSourceContributions).toHaveLength(1)
    expect(registry.snapshot().reviewDiffContributions).toHaveLength(1)
    expect(registry.snapshot().projectProviders).toHaveLength(1)
    expect(registry.snapshot().titlebarActions).toHaveLength(1)
  })

  it("retains an immutable copy when caller-owned definitions change", () => {
    const supportedSurfaces: Array<"code" | "review"> = ["review"]
    const activity = {
      id: ProjectWorkspaceActivityId.make("example.mutable.activity"),
      label: "Original",
      icon: "comments" as const,
      order: 1,
      supportedSurfaces,
      surfacePolicy: "preserve" as const,
    }
    const activities = [activity]
    const registry = compose([
      {
        id: TrustedExtensionId.make("example.mutable.extension"),
        projectActivities: activities,
      },
    ])

    activity.label = "Changed"
    supportedSurfaces.push("code")
    activities.length = 0

    expect(registry.snapshot().projectActivities[0]).toEqual(
      expect.objectContaining({ label: "Original", supportedSurfaces: ["review"] }),
    )
    expect(Object.isFrozen(registry.snapshot())).toBe(true)
    expect(Object.isFrozen(registry.snapshot().projectActivities)).toBe(true)
    expect(Object.isFrozen(registry.snapshot().projectActivities[0]?.supportedSurfaces)).toBe(true)
  })

  it("advertises Comments on Code and Review with preserve-surface selection", () => {
    const snapshot = compose([reviewCommentsExtension]).snapshot()
    const [comments] = snapshot.projectActivities

    expect(comments).toEqual(
      expect.objectContaining({
        label: "Comments",
        supportedSurfaces: ["code", "review"],
        surfacePolicy: "preserve",
      }),
    )
    expect(snapshot.titlebarActions).toEqual([
      expect.objectContaining({
        id: REVIEW_COMMENTS_CONNECTION_ACTION_ID,
        ownerExtensionId: REVIEW_COMMENTS_EXTENSION_ID,
      }),
    ])
    expect(snapshot.reviewDiffContributions).toEqual([
      expect.objectContaining({
        id: REVIEW_COMMENTS_REVIEW_DIFF_ID,
        ownerExtensionId: REVIEW_COMMENTS_EXTENSION_ID,
      }),
    ])
    expect(snapshot.projectProviders).toEqual([
      expect.objectContaining({
        id: REVIEW_COMMENTS_PROJECT_PROVIDER_ID,
        ownerExtensionId: REVIEW_COMMENTS_EXTENSION_ID,
      }),
    ])
  })

  it("isolates subscriber defects and notifies healthy subscribers for each ownership change", () => {
    const registry = new TrustedExtensionRegistry()
    let notifications = 0
    registry.subscribe(() => {
      throw new Error("Subscriber failed")
    })
    const unsubscribe = registry.subscribe(() => {
      notifications += 1
    })

    const dispose = Result.getOrThrow(registry.register(reviewCommentsExtension))
    dispose()
    unsubscribe()
    Result.getOrThrow(registry.register(reviewCommentsExtension))

    expect(notifications).toBe(2)
  })
})
