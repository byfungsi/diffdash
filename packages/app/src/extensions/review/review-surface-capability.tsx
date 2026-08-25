import type { ParsedDiffFile } from "@diffdash/domain/diff"
import { AISettings } from "@diffdash/domain/ai-settings"
import type { ProjectWorkspaceActivityId } from "@diffdash/domain/project-workspace"
import type { ReviewSnapshotFileInventory } from "@diffdash/domain/review-context"
import type { ReviewThreadId } from "@diffdash/domain/review-thread"
import { HashMap, HashSet, Option } from "effect"
import {
  createContext,
  Fragment,
  type ReactNode,
  use,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react"

import type { CommandPaletteItem } from "@/shell/command-palette"
import type { ViewedFileUpdate } from "@/review/viewed-file-viewport"
import type { ReviewSelectionProjection } from "@/review/review-selection"
import type { ColorScheme } from "@/settings/theme"
import { useSettingsMutation } from "@/settings/use-settings-mutation"
import { useProjectRepositoryCapability } from "../project-repository-capability"
import {
  RendererLayoutSettings,
  ReviewContextPaneWidth,
  ReviewPaneSettings,
  ReviewThreadDetailPaneWidth,
} from "@diffdash/domain/renderer-layout-settings"
import type { HostedRepositoryLocator } from "@diffdash/domain/git-provider"

type ReadyReview = Extract<ReviewSelectionProjection, { readonly _tag: "ready" }>["review"]

/** Review-owned application environment kept outside generic project surface mechanics. */
export interface ReviewSurfaceEnvironment {
  readonly aiSettings: AISettings
  readonly colorScheme: ColorScheme
  readonly linkRepository: (repository?: HostedRepositoryLocator) => Promise<boolean>
  readonly contextWidth: number
  readonly threadDetailWidth: number
  readonly updateAISettings: (settings: AISettings) => void
  readonly updateContextWidth: (width: number) => void
  readonly updateThreadDetailWidth: (width: number) => void
}

/** Assembles Review settings and repository capabilities beneath the Review surface. */
export const useReviewSurfaceEnvironment = (colorScheme: ColorScheme): ReviewSurfaceEnvironment => {
  const settingsMutation = useSettingsMutation()
  const repository = useProjectRepositoryCapability()
  const updatePaneSettings = (
    update: (settings: AISettings["layout"]["review"]) => AISettings["layout"]["review"],
  ) => {
    void settingsMutation
      .update((current) =>
        AISettings.make({
          ...current,
          layout: RendererLayoutSettings.make({ review: update(current.layout.review) }),
        }),
      )
      .catch(() => undefined)
  }
  return {
    aiSettings: settingsMutation.settings,
    colorScheme,
    linkRepository: repository.link,
    contextWidth: settingsMutation.settings.layout.review.contextWidth,
    threadDetailWidth: settingsMutation.settings.layout.review.threadDetailWidth,
    updateAISettings: (settings) => void settingsMutation.update(settings).catch(() => undefined),
    updateContextWidth: (width) =>
      updatePaneSettings((current) =>
        ReviewPaneSettings.make({
          ...current,
          contextWidth: ReviewContextPaneWidth.make(width),
        }),
      ),
    updateThreadDetailWidth: (width) =>
      updatePaneSettings((current) =>
        ReviewPaneSettings.make({
          ...current,
          threadDetailWidth: ReviewThreadDetailPaneWidth.make(width),
        }),
      ),
  }
}

/** Semantic Review operations available to registered renderer extensions. */
export interface ReviewSurfaceCapability {
  readonly review: ReadyReview
  readonly inventory: readonly ReviewSnapshotFileInventory[]
  readonly parsedFiles: readonly ParsedDiffFile[]
  readonly viewedFileKeys: HashSet.HashSet<string>
  readonly setViewedFiles: (updates: readonly ViewedFileUpdate[]) => void
  readonly aiAgentAvailable: boolean
  readonly aiSettings: AISettings
  readonly onAISettingsChange: (settings: AISettings) => void
  readonly navigateToFile: (
    file: ReviewSnapshotFileInventory,
    origin: "file-tree" | "extension" | "command",
  ) => void
  readonly navigableThreadIds: HashSet.HashSet<ReviewThreadId>
  readonly navigateToThread: (threadId: ReviewThreadId) => void
  readonly panes: {
    readonly showContext: (activityId: ProjectWorkspaceActivityId) => void
    readonly showDetail: (activityId: ProjectWorkspaceActivityId) => void
    readonly showMain: () => void
    readonly closeContext: () => void
  }
}

/** Activity-owned Review policy and commands consumed by the generic Review host. */
export interface ReviewActivityBehavior {
  readonly activityId: ProjectWorkspaceActivityId
  readonly restrictsInventory: boolean
  readonly visibleInventory: readonly ReviewSnapshotFileInventory[]
  readonly collapsedFileKeys: HashSet.HashSet<string>
  readonly navigationItems: readonly CommandPaletteItem[]
  readonly navigationPlaceholder: string
  readonly actionItems: readonly CommandPaletteItem[]
  readonly settings: ReactNode
  readonly toggleFileCollapsed: (reviewKey: string) => void
}

interface ReviewSurfaceCapabilitySnapshot {
  readonly capability: Option.Option<ReviewSurfaceCapability>
  readonly behaviors: HashMap.HashMap<ProjectWorkspaceActivityId, ReviewActivityBehavior>
}

interface ReviewSurfaceCapabilityStore {
  readonly snapshot: () => ReviewSurfaceCapabilitySnapshot
  readonly subscribe: (listener: () => void) => () => void
  readonly publishCapability: (capability: Option.Option<ReviewSurfaceCapability>) => void
  readonly registerBehavior: (behavior: ReviewActivityBehavior) => () => void
}

const makeReviewSurfaceCapabilityStore = (): ReviewSurfaceCapabilityStore => {
  let snapshot: ReviewSurfaceCapabilitySnapshot = {
    capability: Option.none(),
    behaviors: HashMap.empty(),
  }
  const listeners = new Set<() => void>()
  const publish = (next: ReviewSurfaceCapabilitySnapshot) => {
    snapshot = next
    listeners.forEach((listener) => listener())
  }
  return {
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publishCapability: (capability) => {
      const unchanged = Option.match(snapshot.capability, {
        onNone: () => Option.isNone(capability),
        onSome: (current) => Option.exists(capability, (next) => Object.is(current, next)),
      })
      if (unchanged) return
      publish({ ...snapshot, capability })
    },
    registerBehavior: (behavior) => {
      publish({
        ...snapshot,
        behaviors: HashMap.set(snapshot.behaviors, behavior.activityId, behavior),
      })
      return () => {
        const registered = HashMap.get(snapshot.behaviors, behavior.activityId)
        if (!Option.exists(registered, (current) => Object.is(current, behavior))) return
        publish({
          ...snapshot,
          behaviors: HashMap.remove(snapshot.behaviors, behavior.activityId),
        })
      }
    },
  }
}

const ReviewSurfaceCapabilityContext = createContext<ReviewSurfaceCapabilityStore | null>(null)

/** Owns the semantic Review capability and removable activity behavior lane. */
export const ReviewSurfaceCapabilityProvider = ({ children }: { readonly children: ReactNode }) => {
  const [store] = useState(makeReviewSurfaceCapabilityStore)
  return <ReviewSurfaceCapabilityContext value={store}>{children}</ReviewSurfaceCapabilityContext>
}

const useReviewSurfaceCapabilityStore = (): ReviewSurfaceCapabilityStore => {
  const store = use(ReviewSurfaceCapabilityContext)
  if (store === null) throw new Error("Review surface capability is unavailable")
  return store
}

/** Reads the currently published semantic Review capability. */
export const useReviewSurfaceCapability = (): Option.Option<ReviewSurfaceCapability> => {
  const store = useReviewSurfaceCapabilityStore()
  return useSyncExternalStore(
    store.subscribe,
    () => store.snapshot().capability,
    () => store.snapshot().capability,
  )
}

/** Publishes Review's current semantic operations for registered extension owners. */
export const usePublishReviewSurfaceCapability = (capability: ReviewSurfaceCapability): void => {
  const store = useReviewSurfaceCapabilityStore()
  useLayoutEffect(() => {
    store.publishCapability(Option.some(capability))
  }, [capability, store])
  useLayoutEffect(() => () => store.publishCapability(Option.none()), [store])
}

/** Registers one removable activity policy with the Review host. */
export const useRegisterReviewActivityBehavior = (
  behavior: ReviewActivityBehavior | null,
): void => {
  const store = useReviewSurfaceCapabilityStore()
  useLayoutEffect(() => {
    const registration = Option.map(Option.fromNullishOr(behavior), store.registerBehavior)
    return Option.getOrUndefined(registration)
  }, [behavior, store])
}

/** Resolves one complete Review behavior and extension-wide activity additions. */
export const useReviewActivityBehaviors = (
  activityId: ProjectWorkspaceActivityId,
  fallback: ReviewActivityBehavior,
) => {
  const store = useReviewSurfaceCapabilityStore()
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  const behaviors = [...HashMap.values(snapshot.behaviors)]
  return {
    active: Option.getOrElse(HashMap.get(snapshot.behaviors, activityId), () => fallback),
    actionItems: behaviors.flatMap(({ actionItems }) => actionItems),
    settings: behaviors.map(({ activityId: behaviorActivityId, settings }) => (
      <Fragment key={behaviorActivityId}>{settings}</Fragment>
    )),
  }
}
