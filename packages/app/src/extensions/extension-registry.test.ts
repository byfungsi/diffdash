import { ProjectWorkspaceActivityId } from "@diffdash/domain/project-workspace"
import { Option, Result } from "effect"
import { describe, expect, it } from "vitest"

import {
  type ProjectActivityContribution,
  type TrustedBuiltInExtension,
  DuplicateTrustedContributionError,
  DuplicateTrustedExtensionError,
  DuplicateTrustedProjectSurfaceError,
  InvalidTrustedProjectCompositionError,
  makeTrustedExtensionRegistry,
  REQUIRED_HOME_NAVIGATION_ID,
  TrustedExtensionContributionId,
  TrustedExtensionId,
  TrustedExtensionRegistry,
} from "./extension-registry"
import {
  REVIEW_COMMENTS_ACTIVITY,
  REVIEW_COMMENTS_CONNECTION_ACTION_ID,
  REVIEW_COMMENTS_CONTEXT_PANE_ID,
  REVIEW_COMMENTS_ACTIVITY_ID,
  REVIEW_COMMENTS_EXTENSION_ID,
  REVIEW_COMMENTS_PROJECT_PROVIDER_ID,
  REVIEW_COMMENTS_CODE_SOURCE_ID,
  REVIEW_COMMENTS_REVIEW_DIFF_ID,
  reviewCommentsExtension,
} from "./review-comments/review-comments-extension"
import { codeExtension, PROJECT_WORKSPACE_CODE_ACTIVITY_ID } from "./code/code-extension"
import {
  PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
  PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
  reviewExtension,
  REVIEW_PROJECT_ACTIVITIES,
  REVIEW_PROJECT_SURFACE,
} from "./review/review-extension"
import {
  PROJECT_WORKSPACE_WALKTHROUGH_ACTIVITY_ID,
  walkthroughExtension,
} from "./walkthrough/walkthrough-extension"

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
  it("keeps extension-owned persisted activity identities stable", () => {
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

  it("always exposes a required host-owned Home fallback that cannot be unregistered", () => {
    const registry = new TrustedExtensionRegistry()
    const [home] = registry.snapshot().globalNavigation

    expect(home).toEqual(
      expect.objectContaining({ id: REQUIRED_HOME_NAVIGATION_ID, initialState: null }),
    )
    expect(home?.isValidState(null)).toBe(true)
    expect(home?.isValidState("home")).toBe(false)
    expect(home === undefined ? true : registry.unregister(home.ownerExtensionId)).toBe(false)
    expect(
      home === undefined
        ? true
        : Result.isFailure(registry.register({ id: home.ownerExtensionId })),
    ).toBe(true)
    expect(registry.snapshot().globalNavigation).toEqual([home])
  })

  it("removes an optional global destination without removing the required fallback", () => {
    const registry = new TrustedExtensionRegistry()
    const destinationId = TrustedExtensionContributionId.make("example.global.destination")
    const dispose = Result.getOrThrow(
      registry.register({
        id: TrustedExtensionId.make("example.global.extension"),
        globalNavigation: [
          {
            id: destinationId,
            order: 100,
            initialState: { view: "example" },
            isValidState: (state) => typeof state === "object" && state !== null,
            sameState: Object.is,
            component: () => null,
          },
        ],
      }),
    )

    expect(registry.snapshot().globalNavigation.map(({ id }) => id)).toEqual([
      REQUIRED_HOME_NAVIGATION_ID,
      destinationId,
    ])
    dispose()
    expect(registry.snapshot().globalNavigation.map(({ id }) => id)).toEqual([
      REQUIRED_HOME_NAVIGATION_ID,
    ])
  })

  it("orders equal-priority contributions by ID independently of registration order", () => {
    const first = extension("example.first.extension", [
      {
        id: ProjectWorkspaceActivityId.make("example.first.activity"),
        label: "Reviews",
        icon: () => null,
        order: 500,
        supportedSurfaces: ["review"],
        surfacePolicy: "review",
      },
    ])
    const registry = compose([reviewExtension, codeExtension, reviewCommentsExtension, first])

    expect(registry.snapshot().projectActivities.filter(({ order }) => order === 500)).toEqual([
      expect.objectContaining({
        id: REVIEW_COMMENTS_ACTIVITY.id,
        ownerExtensionId: REVIEW_COMMENTS_EXTENSION_ID,
      }),
      expect.objectContaining({
        id: ProjectWorkspaceActivityId.make("example.first.activity"),
        ownerExtensionId: first.id,
      }),
    ])
  })

  it("returns correlated duplicate failures without partial registration", () => {
    const registry = compose([reviewExtension, codeExtension, reviewCommentsExtension])
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
          icon: () => null,
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
    expect(registry.snapshot().projectActivities).toHaveLength(4)
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

  it("rejects duplicate activity pane IDs across contribution slots", () => {
    const contributionId = TrustedExtensionContributionId.make("example.shared.activity-pane")
    const result = new TrustedExtensionRegistry().register({
      id: TrustedExtensionId.make("example.activity-pane.extension"),
      projectActivities: [
        {
          id: ProjectWorkspaceActivityId.make("example.activity-pane.activity"),
          label: "Activity pane",
          icon: () => null,
          order: 1,
          supportedSurfaces: ["review"],
          surfacePolicy: "review",
          slots: {
            contextPane: { id: contributionId, order: 1, component: () => null },
            mainPane: { id: contributionId, order: 1, mode: "replace", component: () => null },
          },
        },
      ],
    })

    expect(Result.isFailure(result)).toBe(true)
  })

  it("keeps duplicate contribution checks strict during atomic cold composition", () => {
    const contributionId = TrustedExtensionContributionId.make("example.cold.shared-contribution")
    const result = makeTrustedExtensionRegistry([
      {
        id: TrustedExtensionId.make("example.cold.first-extension"),
        titlebarActions: [{ id: contributionId, order: 1, component: () => null }],
      },
      {
        id: TrustedExtensionId.make("example.cold.second-extension"),
        codeSourceContributions: [{ id: contributionId, order: 1, component: () => null }],
      },
    ])

    expect(Option.getOrThrow(Result.getFailure(result))).toBeInstanceOf(
      DuplicateTrustedContributionError,
    )
  })

  it.each([
    {
      reason: "default-activity-missing" as const,
      extension: {
        ...reviewExtension,
        id: TrustedExtensionId.make("example.missing-default.extension"),
        projectSurfaces: [
          {
            ...REVIEW_PROJECT_SURFACE,
            defaultActivityId: ProjectWorkspaceActivityId.make("example.missing.activity"),
          },
        ],
      },
    },
    {
      reason: "missing-navigation" as const,
      extension: {
        ...reviewExtension,
        id: TrustedExtensionId.make("example.missing-navigation.extension"),
        projectNavigation: [],
      },
    },
    {
      reason: "default-marker-mismatch" as const,
      extension: {
        ...reviewExtension,
        id: TrustedExtensionId.make("example.default-mismatch.extension"),
        projectActivities: REVIEW_PROJECT_ACTIVITIES.map((activity) =>
          Object.assign({}, activity, { defaultForSurfaces: [] }),
        ),
      },
    },
  ])("rejects an incomplete surface composition: $reason", ({ extension: definition, reason }) => {
    const registry = new TrustedExtensionRegistry()
    const result = registry.register(definition)

    expect(Option.getOrThrow(Result.getFailure(result))).toEqual(
      expect.objectContaining({
        _tag: "InvalidTrustedProjectCompositionError",
        reason,
        surface: "review",
      }),
    )
    expect(registry.snapshot().projectSurfaces).toEqual([])
  })

  it("keeps owned-surface completeness strict during atomic cold composition", () => {
    const result = makeTrustedExtensionRegistry([
      {
        ...reviewExtension,
        id: TrustedExtensionId.make("example.cold.incomplete-surface"),
        projectNavigation: [],
      },
      codeExtension,
    ])

    expect(Option.getOrThrow(Result.getFailure(result))).toEqual(
      expect.objectContaining({
        _tag: "InvalidTrustedProjectCompositionError",
        reason: "missing-navigation",
        surface: "review",
      }),
    )
  })

  it("rejects an activity targeting an unowned surface before publishing it", () => {
    const registry = new TrustedExtensionRegistry()
    const result = registry.register(
      extension("example.unowned-surface.extension", [
        {
          id: ProjectWorkspaceActivityId.make("example.unowned-surface.activity"),
          label: "Unowned",
          icon: () => null,
          order: 1,
          supportedSurfaces: ["review"],
          surfacePolicy: "review",
        },
      ]),
    )

    expect(Option.getOrThrow(Result.getFailure(result))).toBeInstanceOf(
      InvalidTrustedProjectCompositionError,
    )
    expect(registry.snapshot().projectActivities).toEqual([])
  })

  it("rejects a surface whose declared default activity does not support it", () => {
    const registry = compose([codeExtension])
    const result = registry.register({
      ...reviewExtension,
      id: TrustedExtensionId.make("example.unsupported-default.extension"),
      projectSurfaces: [
        {
          ...REVIEW_PROJECT_SURFACE,
          defaultActivityId: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
        },
      ],
    })

    expect(Option.getOrThrow(Result.getFailure(result))).toEqual(
      expect.objectContaining({
        _tag: "InvalidTrustedProjectCompositionError",
        reason: "default-activity-unsupported",
        surface: "review",
      }),
    )
    expect(registry.snapshot().projectSurfaces.map(({ surface }) => surface)).toEqual(["code"])
  })

  it("rejects a second owner for the same project source surface", () => {
    const second = extension("example.second.surface-owner")
    const registry = new TrustedExtensionRegistry()
    Result.getOrThrow(registry.register(reviewExtension))

    const result = registry.register({
      ...second,
      projectSurfaces: [
        {
          id: TrustedExtensionContributionId.make("example.second.review-surface"),
          order: 1,
          surface: "review",
          defaultActivityId: PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
          defaultMainPane: {
            ...REVIEW_PROJECT_SURFACE.defaultMainPane,
            id: TrustedExtensionContributionId.make("example.second.default-main-pane"),
          },
          component: () => null,
        },
      ],
      projectNavigation: [
        {
          id: TrustedExtensionContributionId.make("example.full.navigation"),
          order: 1,
          surface: "review",
          component: ({ children }) => children,
          createDefaultState: () => null,
          isValidState: () => true,
          sameState: Object.is,
        },
      ],
    })

    expect(Option.getOrThrow(Result.getFailure(result))).toEqual(
      DuplicateTrustedProjectSurfaceError.make({
        extensionId: second.id,
        surface: "review",
        message: "Trusted project surface already registered: review",
      }),
    )
  })

  it("rejects multiple navigation contributions owned with one project surface", () => {
    const result = new TrustedExtensionRegistry().register({
      ...reviewExtension,
      id: TrustedExtensionId.make("example.duplicate-navigation.owner"),
      projectNavigation: [
        ...(reviewExtension.projectNavigation ?? []),
        {
          id: TrustedExtensionContributionId.make("example.duplicate-navigation.second"),
          order: 101,
          surface: "review",
          component: ({ children }) => children,
          createDefaultState: () => null,
          isValidState: (state) => state === null,
          sameState: Object.is,
        },
      ],
    })

    expect(Option.getOrThrow(Result.getFailure(result))).toEqual(
      expect.objectContaining({
        _tag: "InvalidTrustedProjectCompositionError",
        reason: "duplicate-navigation",
        surface: "review",
      }),
    )
  })

  it("rejects a secondary extension navigation contribution targeting another owner's surface", () => {
    const secondary: TrustedBuiltInExtension = {
      id: TrustedExtensionId.make("example.secondary-navigation.extension"),
      projectNavigation: [
        {
          id: TrustedExtensionContributionId.make("example.secondary-navigation.contribution"),
          order: 1,
          surface: "review",
          component: ({ children }) => children,
          createDefaultState: () => null,
          isValidState: (state) => state === null,
          sameState: Object.is,
        },
      ],
    }
    const registry = compose([reviewExtension])

    const incremental = registry.register(secondary)
    const cold = makeTrustedExtensionRegistry([secondary, reviewExtension])

    expect(Option.getOrThrow(Result.getFailure(incremental))).toEqual(
      expect.objectContaining({
        _tag: "InvalidTrustedProjectCompositionError",
        reason: "duplicate-navigation",
        surface: "review",
      }),
    )
    expect(Option.getOrThrow(Result.getFailure(cold))).toEqual(
      expect.objectContaining({
        _tag: "InvalidTrustedProjectCompositionError",
        reason: "duplicate-navigation",
        surface: "review",
      }),
    )
  })

  it("disposes every contribution slot without letting a stale disposer remove a replacement", () => {
    const fullExtension: TrustedBuiltInExtension = {
      id: TrustedExtensionId.make("example.full.extension"),
      projectActivities: [
        {
          id: ProjectWorkspaceActivityId.make("example.full.activity"),
          label: "Full",
          icon: () => null,
          order: 1,
          supportedSurfaces: ["review"],
          defaultForSurfaces: ["review"],
          surfacePolicy: "preserve",
          slots: {
            contextPane: {
              id: TrustedExtensionContributionId.make("example.full.context-pane"),
              order: 1,
              component: () => null,
            },
            detailPane: {
              id: TrustedExtensionContributionId.make("example.full.detail-pane"),
              order: 1,
              component: () => null,
            },
          },
        },
      ],
      projectSurfaces: [
        {
          id: TrustedExtensionContributionId.make("example.full.surface"),
          order: 1,
          surface: "review",
          defaultActivityId: ProjectWorkspaceActivityId.make("example.full.activity"),
          defaultMainPane: {
            id: TrustedExtensionContributionId.make("example.full.default-main-pane"),
            order: 1,
            component: ({ baseMain }) => baseMain,
          },
          component: () => null,
        },
      ],
      projectSurfaceProviders: [
        {
          id: TrustedExtensionContributionId.make("example.full.surface-provider"),
          order: 1,
          surface: "review",
          component: ({ children }) => children,
        },
      ],
      projectNavigation: [
        {
          id: TrustedExtensionContributionId.make("example.full.navigation"),
          order: 1,
          surface: "review",
          component: ({ children }) => children,
          createDefaultState: () => null,
          isValidState: () => true,
          sameState: Object.is,
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
      projectOpeningProviders: [
        {
          id: TrustedExtensionContributionId.make("example.full.project-opening-provider"),
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
      globalNavigation: [expect.objectContaining({ id: REQUIRED_HOME_NAVIGATION_ID })],
      projectActivities: [],
      projectSurfaces: [],
      projectSurfaceProviders: [],
      projectNavigation: [],
      codeSourceContributions: [],
      reviewDiffContributions: [],
      projectProviders: [],
      projectOpeningProviders: [],
      titlebarActions: [],
    })

    Result.getOrThrow(registry.register(fullExtension))
    dispose()
    expect(registry.snapshot().projectActivities).toHaveLength(1)
    expect(registry.snapshot().projectSurfaces).toHaveLength(1)
    expect(registry.snapshot().projectSurfaceProviders).toHaveLength(1)
    expect(registry.snapshot().projectNavigation).toHaveLength(1)
    expect(registry.snapshot().projectActivities[0]?.slots?.contextPane).toEqual(
      expect.objectContaining({ id: "example.full.context-pane" }),
    )
    expect(registry.snapshot().codeSourceContributions).toEqual([])
    expect(registry.snapshot().reviewDiffContributions).toHaveLength(1)
    expect(registry.snapshot().projectProviders).toHaveLength(1)
    expect(registry.snapshot().projectOpeningProviders).toHaveLength(1)
    expect(registry.snapshot().titlebarActions).toHaveLength(1)
  })

  it("retains an immutable copy when caller-owned definitions change", () => {
    const supportedSurfaces: Array<"code" | "review"> = ["review"]
    const contextPane = {
      id: TrustedExtensionContributionId.make("example.mutable.context-pane"),
      order: 1,
      component: () => null,
    }
    const activity = {
      id: ProjectWorkspaceActivityId.make("example.mutable.activity"),
      label: "Original",
      icon: () => null,
      order: 1,
      supportedSurfaces,
      surfacePolicy: "preserve" as const,
      slots: { contextPane },
    }
    const activities = [activity]
    const registry = compose([
      reviewExtension,
      {
        id: TrustedExtensionId.make("example.mutable.extension"),
        projectActivities: activities,
      },
    ])

    activity.label = "Changed"
    supportedSurfaces.push("code")
    contextPane.order = 2
    activities.length = 0

    const registeredActivity = registry
      .snapshot()
      .projectActivities.find(
        ({ id }) => id === ProjectWorkspaceActivityId.make("example.mutable.activity"),
      )
    expect(registeredActivity).toEqual(
      expect.objectContaining({ label: "Original", supportedSurfaces: ["review"] }),
    )
    expect(Object.isFrozen(registry.snapshot())).toBe(true)
    expect(Object.isFrozen(registry.snapshot().projectActivities)).toBe(true)
    expect(Object.isFrozen(registeredActivity?.supportedSurfaces)).toBe(true)
    expect(registeredActivity?.slots?.contextPane?.order).toBe(1)
    expect(Object.isFrozen(registeredActivity?.slots)).toBe(true)
    expect(Object.isFrozen(registeredActivity?.slots?.contextPane)).toBe(true)
  })

  it("advertises Comments on Code and Review with preserve-surface selection", () => {
    const snapshot = compose([reviewExtension, codeExtension, reviewCommentsExtension]).snapshot()
    const comments = snapshot.projectActivities.find(
      (activity) => activity.id === REVIEW_COMMENTS_ACTIVITY.id,
    )

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
    expect(comments?.slots?.contextPane).toEqual(
      expect.objectContaining({ id: REVIEW_COMMENTS_CONTEXT_PANE_ID }),
    )
    expect(Object.isFrozen(comments?.slots)).toBe(true)
    expect(Object.isFrozen(comments?.slots?.contextPane)).toBe(true)
  })

  it.each([
    {
      extensions: [reviewExtension, reviewCommentsExtension],
      surface: "review" as const,
      sourceContributionCount: 0,
      reviewContributionCount: 1,
    },
    {
      extensions: [codeExtension, reviewCommentsExtension],
      surface: "code" as const,
      sourceContributionCount: 1,
      reviewContributionCount: 0,
    },
  ])("cold-composes Comments on the available $surface lane", ({
    extensions,
    surface,
    sourceContributionCount,
    reviewContributionCount,
  }) => {
    const snapshot = compose(extensions).snapshot()

    expect(snapshot.projectSurfaces.map((contribution) => contribution.surface)).toEqual([surface])
    expect(snapshot.projectActivities.find(({ id }) => id === REVIEW_COMMENTS_ACTIVITY_ID)).toEqual(
      expect.objectContaining({ supportedSurfaces: [surface] }),
    )
    expect(snapshot.codeSourceContributions).toHaveLength(sourceContributionCount)
    expect(snapshot.reviewDiffContributions).toHaveLength(reviewContributionCount)
    expect(snapshot.projectProviders).toEqual([
      expect.objectContaining({ id: REVIEW_COMMENTS_PROJECT_PROVIDER_ID }),
    ])
  })

  it.each([
    {
      extensions: [codeExtension, walkthroughExtension],
      expectedActivityIds: [PROJECT_WORKSPACE_CODE_ACTIVITY_ID],
    },
    {
      extensions: [walkthroughExtension, codeExtension],
      expectedActivityIds: [PROJECT_WORKSPACE_CODE_ACTIVITY_ID],
    },
    {
      extensions: [codeExtension, reviewCommentsExtension, walkthroughExtension],
      expectedActivityIds: [PROJECT_WORKSPACE_CODE_ACTIVITY_ID, REVIEW_COMMENTS_ACTIVITY_ID],
    },
    {
      extensions: [walkthroughExtension, reviewCommentsExtension, codeExtension],
      expectedActivityIds: [PROJECT_WORKSPACE_CODE_ACTIVITY_ID, REVIEW_COMMENTS_ACTIVITY_ID],
    },
  ])("cold-composes the complete requested set independently of order", ({
    extensions,
    expectedActivityIds,
  }) => {
    const snapshot = compose(extensions).snapshot()

    expect(snapshot.projectSurfaces.map(({ surface }) => surface)).toEqual(["code"])
    expect(snapshot.projectActivities.map(({ id }) => id)).toEqual(expectedActivityIds)
    expect(snapshot.projectSurfaceProviders).toEqual([])
    expect(snapshot.reviewDiffContributions).toEqual([])
    expect(
      snapshot.projectActivities.some(({ id }) => id === PROJECT_WORKSPACE_WALKTHROUGH_ACTIVITY_ID),
    ).toBe(false)
  })

  it("publishes one snapshot after the complete cold set validates", () => {
    const registry = new TrustedExtensionRegistry()
    const publishedSnapshots: ReturnType<TrustedExtensionRegistry["snapshot"]>[] = []
    registry.subscribe(() => publishedSnapshots.push(registry.snapshot()))

    Result.getOrThrow(registry.registerAll([walkthroughExtension, codeExtension]))

    expect(publishedSnapshots).toHaveLength(1)
    expect(publishedSnapshots[0]?.projectActivities.map(({ id }) => id)).toEqual([
      PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
    ])
  })

  it("isolates subscriber defects and notifies healthy subscribers for each ownership change", () => {
    const registry = new TrustedExtensionRegistry()
    const subscriberExtension = extension("example.subscriber.extension")
    const observedActivityCounts: number[] = []
    registry.subscribe(() => {
      throw new Error("Subscriber failed")
    })
    const unsubscribe = registry.subscribe(() => {
      observedActivityCounts.push(registry.snapshot().projectActivities.length)
    })

    const dispose = Result.getOrThrow(registry.register(subscriberExtension))
    dispose()
    unsubscribe()
    Result.getOrThrow(registry.register(subscriberExtension))

    expect(observedActivityCounts).toEqual([0, 0])
  })

  it("removes every Review Comments contribution in one unregister generation", () => {
    const registry = compose([reviewExtension, codeExtension, reviewCommentsExtension])

    expect(registry.unregister(REVIEW_COMMENTS_EXTENSION_ID)).toBe(true)

    const snapshot = registry.snapshot()
    expect(snapshot.projectActivities).toHaveLength(3)
    expect(snapshot.codeSourceContributions).toEqual([])
    expect(snapshot.reviewDiffContributions).toEqual([])
    expect(snapshot.projectProviders).toEqual([])
    expect(snapshot.titlebarActions).toEqual([])
  })

  it("retains Review Comments Code contributions when the Review owner disappears", () => {
    const registry = compose([
      reviewExtension,
      codeExtension,
      walkthroughExtension,
      reviewCommentsExtension,
    ])
    const publishedSnapshots: ReturnType<TrustedExtensionRegistry["snapshot"]>[] = []
    registry.subscribe(() => publishedSnapshots.push(registry.snapshot()))

    expect(registry.unregister(reviewExtension.id)).toBe(true)

    expect(publishedSnapshots).toHaveLength(1)
    const [snapshot] = publishedSnapshots
    expect(snapshot?.projectSurfaces.map(({ surface }) => surface)).toEqual(["code"])
    expect(snapshot?.projectActivities.map(({ id }) => id)).toEqual([
      PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
      REVIEW_COMMENTS_ACTIVITY_ID,
    ])
    expect(
      snapshot?.projectActivities.find(({ id }) => id === REVIEW_COMMENTS_ACTIVITY_ID),
    ).toEqual(expect.objectContaining({ supportedSurfaces: ["code"] }))
    expect(snapshot?.projectSurfaceProviders).toEqual([])
    expect(snapshot?.projectNavigation.map(({ surface }) => surface)).toEqual(["code"])
    expect(snapshot?.codeSourceContributions).toEqual([
      expect.objectContaining({ id: REVIEW_COMMENTS_CODE_SOURCE_ID }),
    ])
    expect(snapshot?.reviewDiffContributions).toEqual([])
    expect(snapshot?.projectProviders).toEqual([
      expect.objectContaining({ id: REVIEW_COMMENTS_PROJECT_PROVIDER_ID }),
    ])
    expect(snapshot?.titlebarActions).toEqual([
      expect.objectContaining({ id: REVIEW_COMMENTS_CONNECTION_ACTION_ID }),
    ])
  })

  it("retains Review Comments Review contributions when the Code owner disappears", () => {
    const registry = compose([reviewExtension, codeExtension, reviewCommentsExtension])
    const publishedSnapshots: ReturnType<TrustedExtensionRegistry["snapshot"]>[] = []
    registry.subscribe(() => publishedSnapshots.push(registry.snapshot()))

    expect(registry.unregister(codeExtension.id)).toBe(true)

    expect(publishedSnapshots).toHaveLength(1)
    const [snapshot] = publishedSnapshots
    expect(snapshot?.projectSurfaces.map(({ surface }) => surface)).toEqual(["review"])
    expect(
      snapshot?.projectActivities.find(({ id }) => id === REVIEW_COMMENTS_ACTIVITY_ID),
    ).toEqual(expect.objectContaining({ supportedSurfaces: ["review"] }))
    expect(snapshot?.codeSourceContributions).toEqual([])
    expect(snapshot?.reviewDiffContributions).toEqual([
      expect.objectContaining({ id: REVIEW_COMMENTS_REVIEW_DIFF_ID }),
    ])
    expect(snapshot?.projectProviders).toEqual([
      expect.objectContaining({ id: REVIEW_COMMENTS_PROJECT_PROVIDER_ID }),
    ])
    expect(snapshot?.titlebarActions).toEqual([
      expect.objectContaining({ id: REVIEW_COMMENTS_CONNECTION_ACTION_ID }),
    ])
  })
})
