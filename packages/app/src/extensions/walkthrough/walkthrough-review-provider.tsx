import type { ParsedDiffFile } from "@diffdash/domain/diff"
import type { AISettings } from "@diffdash/domain/ai-settings"
import type { ReviewSnapshotFileInventory } from "@diffdash/domain/review-context"
import { HostedReviewTarget } from "@diffdash/domain/review-thread"
import {
  buildWalkthroughHunkDigest,
  focusFilesForWalkthroughHunks,
  type StoredWalkthrough,
} from "@diffdash/domain/walkthrough"
import {
  type AgentProviderCatalog,
  EMPTY_AGENT_PROVIDER_CATALOG,
} from "@diffdash/protocol/agent-providers"
import { WalkthroughBridgeOperationSnapshot } from "@diffdash/protocol/walkthrough-operation-state"
import { AsyncResult } from "effect/unstable/reactivity"
import { HashMap, HashSet, Match, Option, Schema } from "effect"
import { Sparkles } from "lucide-react"
import {
  createContext,
  type ReactNode,
  use,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { useAtomValue } from "@effect/atom-react"

import { useCaptureAnalytics } from "@/shared/analytics"
import {
  agentSelection,
  aiProviderLabel,
  selectedAIModelLabel,
  selectedProvider,
} from "@/settings/agent-selection"
import { reviewWalkthroughScope } from "@/review/review-subject"
import { agentProviderCatalogAtom } from "@/walkthrough/atoms"
import { useWalkthroughOperations } from "@/walkthrough/use-walkthrough-operations"
import { walkthroughErrorPresentation } from "@/walkthrough/walkthrough-error-report"
import { type WalkthroughState, walkthroughReviewSteps } from "@/walkthrough/walkthrough-panel"
import {
  type ReviewActivityBehavior,
  type ReviewSurfaceCapability,
  useRegisterReviewActivityBehavior,
  useReviewSurfaceCapability,
} from "../review/review-surface-capability"
import { WalkthroughSettingsMenu } from "./walkthrough-settings-menu"
import type { TrustedExtensionRegistrationToken } from "../extension-registry"
import { PROJECT_WORKSPACE_WALKTHROUGH_ACTIVITY_ID } from "./walkthrough-extension"

/** Inputs needed when the Walkthrough extension loads or regenerates its artifact. */
/** Walkthrough-specific projection over the current Review inventory. */
export interface WalkthroughReviewProjection {
  readonly activeStoredWalkthrough: Option.Option<StoredWalkthrough>
  readonly activeWalkthrough: Option.Option<StoredWalkthrough["walkthrough"]>
  readonly steps: ReturnType<typeof walkthroughReviewSteps>
  readonly activeStep: Option.Option<ReturnType<typeof walkthroughReviewSteps>[number]>
  readonly activeStepFiles: readonly ParsedDiffFile[]
  readonly activeStepInventory: readonly ReviewSnapshotFileInventory[]
  readonly scope: ReturnType<typeof reviewWalkthroughScope>
  readonly hunkDigest: ReturnType<typeof buildWalkthroughHunkDigest>
}

/** Walkthrough-owned lifecycle and ephemeral state consumed by Review projections. */
export interface WalkthroughReviewCapability {
  readonly state: WalkthroughState
  readonly operationId: Option.Option<string>
  readonly activeStepIndex: number
  readonly visitedStepIndexes: HashSet.HashSet<number>
  readonly collapsedFileKeys: HashSet.HashSet<string>
  readonly aiAgentAvailable: boolean
  readonly providerCatalog: AgentProviderCatalog
  readonly settings: AISettings
  readonly onSettingsChange: (settings: AISettings) => void
  readonly fileFilter: string
  readonly setFileFilter: (filter: string) => void
  readonly load: (regenerate: boolean) => Promise<void>
  readonly cancel: () => Promise<void>
  readonly project: () => WalkthroughReviewProjection
  readonly filesForStep: (index: number) => readonly ParsedDiffFile[]
  readonly markActiveStepComplete: () => void
  readonly selectStep: (index: number) => void
  readonly selectNextStep: () => void
  readonly selectFile: (stepIndex: number, file: ParsedDiffFile) => void
  readonly toggleFileCollapsed: (reviewKey: string) => void
}

interface WalkthroughReviewCapabilityStore {
  readonly snapshot: () => WalkthroughReviewCapability | null
  readonly subscribe: (listener: () => void) => () => void
  readonly publish: (capability: Option.Option<WalkthroughReviewCapability>) => void
}

const makeWalkthroughReviewCapabilityStore = (): WalkthroughReviewCapabilityStore => {
  let capability = Option.none<WalkthroughReviewCapability>()
  const listeners = new Set<() => void>()
  return {
    snapshot: () => Option.getOrNull(capability),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish: (next) => {
      if (
        (Option.isNone(capability) && Option.isNone(next)) ||
        (Option.isSome(capability) &&
          Option.isSome(next) &&
          Object.is(capability.value, next.value))
      ) {
        return
      }
      capability = next
      listeners.forEach((listener) => listener())
    },
  }
}

const WalkthroughReviewContext = createContext<WalkthroughReviewCapabilityStore | null>(null)

/** Returns the active Walkthrough lifecycle when its extension is registered. */
export const useWalkthroughReviewCapability = (): WalkthroughReviewCapability | null => {
  const store = use(WalkthroughReviewContext)
  return useSyncExternalStore(
    store?.subscribe ?? (() => () => undefined),
    store?.snapshot ?? (() => null),
    store?.snapshot ?? (() => null),
  )
}

/** Owner-scoped provider mounted only while the Walkthrough extension is registered. */
export const WalkthroughReviewProvider = ({
  active,
  children,
  registrationToken: _registrationToken,
}: {
  readonly active: boolean
  readonly children: ReactNode
  readonly registrationToken: TrustedExtensionRegistrationToken
}) => {
  const reviewCapability = useReviewSurfaceCapability()
  const [store] = useState(makeWalkthroughReviewCapabilityStore)
  return (
    <WalkthroughReviewContext value={store}>
      {active
        ? Option.match(reviewCapability, {
            onNone: () => null,
            onSome: (capability) => (
              <ReadyWalkthroughReviewProvider reviewCapability={capability} store={store} />
            ),
          })
        : null}
      {children}
    </WalkthroughReviewContext>
  )
}

const ReadyWalkthroughReviewProvider = ({
  reviewCapability,
  store,
}: {
  readonly reviewCapability: ReviewSurfaceCapability
  readonly store: WalkthroughReviewCapabilityStore
}) => {
  const captureAnalytics = useCaptureAnalytics()
  const review = reviewCapability.review
  const target = useMemo(
    () =>
      Match.valueTags(review, {
        hosted: (hostedReview) =>
          HostedReviewTarget.make({ kind: "hosted", review: hostedReview.target }),
        local: (localReview) => localReview.target,
        repositoryComparison: (comparisonReview) => comparisonReview.target,
      }),
    [review],
  )
  const operations = useWalkthroughOperations(target)
  const providerCatalogResult = useAtomValue(agentProviderCatalogAtom)
  const providerCatalog = AsyncResult.getOrElse(
    providerCatalogResult,
    () => EMPTY_AGENT_PROVIDER_CATALOG,
  )
  const [state, setState] = useState<WalkthroughState>({ status: "idle" })
  const [activeStepIndex, setActiveStepIndex] = useState(0)
  const [visitedStepIndexes, setVisitedStepIndexes] = useState(() => HashSet.empty<number>())
  const [collapsedFileKeys, setCollapsedFileKeys] = useState(() => HashSet.empty<string>())
  const [fileFilter, setFileFilter] = useState("")

  const reviewGeneration = `${review.manifest.projectId}\u0000${review.manifest.snapshotId}\u0000${review.baseRevision ?? ""}\u0000${review.headRevision ?? ""}`
  const reviewGenerationRef = useRef<Option.Option<string>>(Option.some(reviewGeneration))
  reviewGenerationRef.current = Option.some(reviewGeneration)
  useEffect(() => {
    setState({ status: "idle" })
    setActiveStepIndex(0)
    setVisitedStepIndexes(HashSet.empty())
    setCollapsedFileKeys(HashSet.empty())
    setFileFilter("")
    return () => {
      if (Option.contains(reviewGenerationRef.current, reviewGeneration)) {
        reviewGenerationRef.current = Option.none()
      }
    }
  }, [reviewGeneration])

  const load = async (regenerate: boolean) => {
    const requestedGeneration = reviewGeneration
    const generationIsCurrent = () =>
      Option.contains(reviewGenerationRef.current, requestedGeneration)
    if (reviewCapability.inventory.length === 0) {
      if (generationIsCurrent()) {
        setState({ status: "empty", message: "This review has no reviewable file changes." })
      }
      return
    }
    if (!regenerate && review.baseRevision !== null && review.headRevision !== null) {
      setState({ status: "loading", message: "Loading cached walkthrough" })
      try {
        const cached = await operations.getStored()
        if (!generationIsCurrent()) return
        if (cached !== null) {
          setActiveStepIndex(0)
          setVisitedStepIndexes(HashSet.make(0))
          setState({ status: "ready", stored: cached })
          return
        }
      } catch {
        // Generation performs the same cache lookup and remains the recovery path.
      }
    }
    if (!reviewCapability.aiAgentAvailable) {
      setState({
        status: "unavailable",
        message:
          "Walkthrough generation is disabled because the configured AI agent is unavailable.",
      })
      return
    }
    setState({
      status: "loading",
      message: regenerate ? "Regenerating walkthrough" : "Generating walkthrough",
    })
    try {
      const stored = await operations.start(regenerate)
      if (!generationIsCurrent()) return
      if (regenerate) resetWalkthroughViewedFiles(review, stored, reviewCapability)
      setActiveStepIndex(0)
      setVisitedStepIndexes(HashSet.make(0))
      setState({ status: "ready", stored })
      captureAnalytics({
        event: "walkthrough_generated",
        reviewType: Match.valueTags(review, {
          hosted: () => "pull_request" as const,
          local: () => "local_diff" as const,
          repositoryComparison: () => "repository_comparison" as const,
        }),
        regenerated: regenerate,
        provider: selectedProvider(agentSelection(reviewCapability.aiSettings, "walkthrough")),
      })
    } catch (error) {
      if (!generationIsCurrent()) return
      const operationFailure = Schema.decodeUnknownOption(WalkthroughBridgeOperationSnapshot)(error)
      const operationCancelled = Option.exists(operationFailure, (operation) =>
        Match.value(operation).pipe(
          Match.discriminatorsExhaustive("state")({
            active: () => false,
            completed: () => false,
            failed: () => false,
            cancelled: () => true,
            superseded: () => false,
            interrupted: () => false,
          }),
        ),
      )
      if (operationCancelled) {
        setState({ status: "idle" })
        return
      }
      const settings = reviewCapability.aiSettings
      setState({
        status: "error",
        ...walkthroughErrorPresentation(error, {
          action: regenerate ? "regenerate" : "generate",
          appVersion: import.meta.env.VITE_APP_VERSION,
          model: selectedAIModelLabel(settings, providerCatalog),
          occurredAt: new Date().toISOString(),
          platform: window.navigator.platform,
          provider: aiProviderLabel(agentSelection(settings, "walkthrough"), providerCatalog),
          reviewSource: Match.valueTags(review, {
            hosted: () => "hosted" as const,
            local: () => "local" as const,
            repositoryComparison: () => "repositoryComparison" as const,
          }),
        }),
      })
    }
  }

  const operationId = Match.value(operations.state).pipe(
    Match.discriminatorsExhaustive("status")({
      idle: () => Option.none(),
      accepted: (accepted) => Option.some(accepted.operationId),
      active: ({ operation }) => Option.some(operation.operationId),
      terminal: ({ operation }) => Option.some(operation.operationId),
    }),
  )
  const cancel = async (): Promise<void> => {
    await operations.cancel()
    if (Option.contains(reviewGenerationRef.current, reviewGeneration)) setState({ status: "idle" })
  }

  const project = (): WalkthroughReviewProjection => {
    const changedFiles = reviewCapability.inventory
    const loadedFiles = reviewCapability.parsedFiles
    const activeStoredWalkthrough = Match.value(state).pipe(
      Match.discriminatorsExhaustive("status")({
        idle: () => Option.none(),
        loading: () => Option.none(),
        ready: ({ stored }) => Option.some(stored),
        empty: () => Option.none(),
        unavailable: () => Option.none(),
        error: () => Option.none(),
      }),
    )
    const activeWalkthrough = Option.map(activeStoredWalkthrough, (stored) => stored.walkthrough)
    const scope = reviewWalkthroughScope(review, Option.getOrNull(activeStoredWalkthrough))
    const steps = Option.match(activeWalkthrough, {
      onNone: () => [],
      onSome: walkthroughReviewSteps,
    })
    const activeStep = Option.fromNullishOr(steps[activeStepIndex])
    return {
      activeStoredWalkthrough,
      activeWalkthrough,
      steps,
      activeStep,
      activeStepFiles: Option.match(activeStep, {
        onNone: () => [],
        onSome: (step) => focusFilesForWalkthroughHunks(loadedFiles, step.hunkIds, scope),
      }),
      activeStepInventory: Option.match(activeStep, {
        onNone: () => [],
        onSome: (step) =>
          changedFiles.filter((file) =>
            step.hunkIds.some((hunkId) => hunkId.startsWith(`${file.path}:`)),
          ),
      }),
      scope,
      hunkDigest: buildWalkthroughHunkDigest(loadedFiles, scope),
    }
  }
  const filesForStep = (index: number): readonly ParsedDiffFile[] => {
    const loadedFiles = reviewCapability.parsedFiles
    const activeStoredWalkthrough = Match.value(state).pipe(
      Match.discriminatorsExhaustive("status")({
        idle: () => Option.none(),
        loading: () => Option.none(),
        ready: ({ stored }) => Option.some(stored),
        empty: () => Option.none(),
        unavailable: () => Option.none(),
        error: () => Option.none(),
      }),
    )
    return Option.match(
      Option.flatMap(activeStoredWalkthrough, (stored) =>
        Option.map(
          Option.fromNullishOr(walkthroughReviewSteps(stored.walkthrough)[index]),
          (step) => ({ step, stored }),
        ),
      ),
      {
        onNone: () => [],
        onSome: ({ step, stored }) =>
          focusFilesForWalkthroughHunks(
            loadedFiles,
            step.hunkIds,
            reviewWalkthroughScope(review, stored),
          ),
      },
    )
  }

  const capability: WalkthroughReviewCapability = {
    state,
    operationId,
    activeStepIndex,
    visitedStepIndexes,
    collapsedFileKeys,
    aiAgentAvailable: reviewCapability.aiAgentAvailable,
    providerCatalog,
    settings: reviewCapability.aiSettings,
    onSettingsChange: reviewCapability.onAISettingsChange,
    fileFilter,
    setFileFilter,
    load,
    cancel,
    project,
    filesForStep,
    markActiveStepComplete: () => {
      reviewCapability.setViewedFiles(
        filesForStep(activeStepIndex).map((file) => ({
          reviewKey: file.reviewKey,
          viewed: true,
        })),
      )
    },
    selectStep: (index) => {
      setVisitedStepIndexes((indexes) => HashSet.add(HashSet.add(indexes, activeStepIndex), index))
      setActiveStepIndex(index)
    },
    selectNextStep: () => {
      const stepCount = project().steps.length
      if (stepCount === 0) return
      const index = Math.min(activeStepIndex + 1, stepCount - 1)
      setVisitedStepIndexes((indexes) => HashSet.add(HashSet.add(indexes, activeStepIndex), index))
      setActiveStepIndex(index)
    },
    selectFile: (stepIndex, file) => {
      setVisitedStepIndexes((indexes) =>
        HashSet.add(HashSet.add(indexes, activeStepIndex), stepIndex),
      )
      setActiveStepIndex(stepIndex)
      const inventoryFile = reviewCapability.inventory.find(
        (candidate) => candidate.fileId === file.fileId,
      )
      if (inventoryFile !== undefined) reviewCapability.navigateToFile(inventoryFile, "extension")
    },
    toggleFileCollapsed: (reviewKey) => {
      setCollapsedFileKeys((keys) =>
        HashSet.has(keys, reviewKey)
          ? HashSet.remove(keys, reviewKey)
          : HashSet.add(keys, reviewKey),
      )
    },
  }
  const projection = project()
  const walkthroughLoading = Match.value(state).pipe(
    Match.discriminatorsExhaustive("status")({
      idle: () => false,
      loading: () => true,
      ready: () => false,
      empty: () => false,
      unavailable: () => false,
      error: () => false,
    }),
  )
  const normalizedFilter = fileFilter.trim().toLowerCase()
  const visibleInventory =
    normalizedFilter.length === 0
      ? projection.activeStepInventory
      : projection.activeStepInventory.filter(
          (file) =>
            file.path.toLowerCase().includes(normalizedFilter) ||
            (file.oldPath?.toLowerCase().includes(normalizedFilter) ?? false),
        )
  const behavior: ReviewActivityBehavior = {
    activityId: PROJECT_WORKSPACE_WALKTHROUGH_ACTIVITY_ID,
    restrictsInventory: true,
    visibleInventory,
    collapsedFileKeys,
    navigationItems: projection.steps.map((step, index) => ({
      id: `walkthrough:${index}:${step.id}`,
      keywords: `${step.title} ${step.summary} ${step.chapterTitle ?? ""} walkthrough section`,
      subtitle: `${step.chapterTitle ?? "Walkthrough"} · ${step.risk}`,
      title: `${step.chapterTitle ?? "Walkthrough"} > ${step.title}`,
      onSelect: () => {
        capability.selectStep(index)
        const file = capability.filesForStep(index)[0]
        if (file !== undefined) capability.selectFile(index, file)
      },
    })),
    navigationPlaceholder: "Search walkthrough sections",
    actionItems: [
      {
        disabled: !reviewCapability.aiAgentAvailable || walkthroughLoading,
        id: "action:regenerate-walkthrough",
        icon: Sparkles,
        keywords: "regenerate walkthrough ai",
        subtitle: reviewCapability.aiAgentAvailable
          ? "Generate a fresh walkthrough"
          : "Walkthroughs require an available agent provider. Complete provider setup to enable guided review.",
        title: "Regenerate walkthrough",
        onSelect: () => void load(true),
      },
    ],
    settings: (
      <WalkthroughSettingsMenu
        catalog={providerCatalog}
        settings={reviewCapability.aiSettings}
        onChange={reviewCapability.onAISettingsChange}
      />
    ),
    toggleFileCollapsed: capability.toggleFileCollapsed,
  }
  useRegisterReviewActivityBehavior(behavior)
  useLayoutEffect(() => {
    store.publish(Option.some(capability))
  })
  useLayoutEffect(() => () => store.publish(Option.none()), [store])
  return null
}

const resetWalkthroughViewedFiles = (
  review: Parameters<typeof reviewWalkthroughScope>[0],
  stored: StoredWalkthrough,
  input: ReviewSurfaceCapability,
): void => {
  const scope = reviewWalkthroughScope(review, stored)
  const initialUpdates = HashMap.fromIterable(
    input.inventory.map(
      (file) => [file.reviewKey, { reviewKey: file.reviewKey, viewed: false }] as const,
    ),
  )
  const updates = walkthroughReviewSteps(stored.walkthrough).reduce(
    (byReviewKey, step) =>
      focusFilesForWalkthroughHunks(input.parsedFiles, step.hunkIds, scope).reduce(
        (current, file) =>
          HashMap.set(current, file.reviewKey, { reviewKey: file.reviewKey, viewed: false }),
        byReviewKey,
      ),
    initialUpdates,
  )
  input.setViewedFiles([...HashMap.values(updates)])
}
