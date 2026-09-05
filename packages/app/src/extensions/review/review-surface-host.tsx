import { RepositoryCheckout } from "@diffdash/domain/repository"
import {
  makeHostedReviewKey,
  type HostedReviewCheck,
  type HostedReviewDetail,
  type HostedReviewSummary,
} from "@diffdash/domain/git-provider"
import { Array as EffectArray, Cause, HashMap, HashSet, Match, Option, Order } from "effect"
import { type ReactNode, useEffect, useEffectEvent, useRef } from "react"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/unstable/reactivity"

import { ReviewScreen } from "./review-screen"
import { useTrustedExtensionRegistry } from "../extension-registry-context"
import {
  ReviewSurfaceCapabilityProvider,
  useReviewSurfaceEnvironment,
} from "./review-surface-capability"
import { useReviewNavigationController } from "./review-navigation"
import { useProjectSurfaceRuntime } from "../project-surface-runtime"
import { providersAtom, repositoriesAtom } from "@/repositories/atoms"
import {
  hostedReviewManifestAtom,
  hostedReviewChecksAtom,
  hostedReviewDetailAtom,
  localReviewManifestAtom,
  pullRequestsAtom,
  repoKey,
  repositoryComparisonManifestAtom,
  serializeLocalReviewAtomKey,
} from "@/review/atoms"
import { workingTreeReviewTarget } from "@diffdash/domain/local-review"
import { useReviewSelection } from "@/review/use-review-selection"
import { useReviewSourceOperations } from "@/review/use-review-source-operations"
import { reviewSelectionSourceKeys } from "@/review/review-selection"
import { ReviewsPane } from "@/project-workspace/reviews-pane"
import { ProjectReviewsOverview } from "@/project-workspace/project-reviews-overview"
import {
  projectHostedReviewsLifecycle,
  projectLocalReviewsLifecycle,
} from "@/project-workspace/reviews-lifecycle"
import { agentProviderCatalogAtom } from "@/walkthrough/atoms"
import { EMPTY_AGENT_PROVIDER_CATALOG } from "@diffdash/protocol/agent-providers"
import { agentRouteAvailable } from "@/settings/agent-selection"
import { useCaptureAnalytics } from "@/shared/analytics"
import { useKeyboardShortcut } from "@/shell/keyboard-shortcuts"
import { formatError } from "@/shared/errors"
import { useReviewSourceOperationsFactory } from "@/platform/renderer-runtime"
import { createCodeFileNavigationState } from "../code/code-navigation"
import {
  PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
  PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
} from "./review-identities"

const HOSTED_REVIEW_CHECKS_POLL_INTERVAL_MS = 30_000
const HOSTED_REVIEW_DETAIL_POLL_INTERVAL_MS = 5_000

/** Registered Review surface entrypoint resolved from the trusted extension registry. */
export const ReviewExtensionSurface = () => {
  const host = useProjectSurfaceRuntime()
  const retainedActivityRef = useRef(host.activeActivity)
  const active = host.activeSurface === "review"
  if (active) retainedActivityRef.current = host.activeActivity
  const environment = useReviewSurfaceEnvironment(host.colorScheme)
  const navigation = useReviewNavigationController()
  const captureAnalytics = useCaptureAnalytics()
  const reviewSourceOperations = useReviewSourceOperationsFactory()
  const { projectNavigation, projectSurfaces, reviewDiffContributions } =
    useTrustedExtensionRegistry()
  const reviewContribution = projectNavigation.find(({ surface }) => surface === "review")
  const reviewSurfaceContribution = projectSurfaces.find(({ surface }) => surface === "review")
  const codeSurfaceContribution = projectSurfaces.find(({ surface }) => surface === "code")
  const codeContribution = projectNavigation.find(({ surface }) => surface === "code")
  const providersResult = useAtomValue(providersAtom)
  const repositoriesResult = useAtomValue(repositoriesAtom)
  const providers = AsyncResult.getOrElse(providersResult, () => [])
  const repos = AsyncResult.getOrElse(repositoriesResult, () => [])
  const selectedReview = navigation.selectedReview
  const selectedReviewTarget = Option.getOrNull(selectedReview)
  const sourceKeys = reviewSelectionSourceKeys(selectedReviewTarget)
  const selectedReviewProvider =
    selectedReviewTarget?.kind !== "hosted"
      ? null
      : (providers.find(
          (provider) => provider.id === selectedReviewTarget.review.repository.providerId,
        ) ?? null)
  const hostedChecksSourceKey =
    selectedReviewProvider?.capabilities.reviewChecks === true ? sourceKeys.hosted : ""
  const hostedDiffOpen =
    sourceKeys.hosted.length > 0 &&
    selectedReviewTarget?.kind === "hosted" &&
    selectedReviewTarget.view === "files"
  const selection = useReviewSelection(selectedReviewTarget, providers, hostedDiffOpen)
  const sourceOperations = useReviewSourceOperations(selection)
  const hostedReviewDetailResult = useAtomValue(hostedReviewDetailAtom(sourceKeys.hosted))
  const refreshHostedReviewDetail = useAtomRefresh(hostedReviewDetailAtom(sourceKeys.hosted))
  const hostedReviewChecksResult = useAtomValue(hostedReviewChecksAtom(hostedChecksSourceKey))
  const refreshHostedReviewChecks = useAtomRefresh(hostedReviewChecksAtom(hostedChecksSourceKey))
  const refreshHostedReview = useAtomRefresh(
    hostedReviewManifestAtom(hostedDiffOpen ? sourceKeys.hosted : ""),
  )
  const refreshLocalReview = useAtomRefresh(localReviewManifestAtom(sourceKeys.local))
  const refreshRepositoryComparison = useAtomRefresh(
    repositoryComparisonManifestAtom(sourceKeys.comparison),
  )
  const repoPullRequestsAtom = pullRequestsAtom(
    Option.match(Option.fromNullishOr(host.repo.hostedLocator), {
      onNone: () => "",
      onSome: (locator) => repoKey(locator.providerId, locator.namespace, locator.name),
    }),
  )
  const pullRequestsResult = useAtomValue(repoPullRequestsAtom)
  const pullRequests = AsyncResult.getOrElse(pullRequestsResult, () => [])
  const refreshPullRequests = useAtomRefresh(repoPullRequestsAtom)
  const hostedReviewChecks: readonly HostedReviewCheck[] = AsyncResult.isSuccess(
    hostedReviewChecksResult,
  )
    ? hostedReviewChecksResult.value
    : []
  const hostedReviewChecksPending = hostedReviewChecks.some(({ status }) => status === "pending")
  const hostedReviewChecksFailed = AsyncResult.isFailure(hostedReviewChecksResult)
  const hostedReviewChecksWaiting = AsyncResult.isWaiting(hostedReviewChecksResult)
  const hostedReviewDetailChecking =
    AsyncResult.isSuccess(hostedReviewDetailResult) &&
    hostedReviewDetailResult.value?.mergeState.status === "checking"
  const hostedReviewDetailWaiting = AsyncResult.isWaiting(hostedReviewDetailResult)
  useVisibleRefreshPolling(
    active && !hostedDiffOpen && sourceKeys.hosted.length > 0 && hostedReviewDetailChecking,
    hostedReviewDetailWaiting,
    HOSTED_REVIEW_DETAIL_POLL_INTERVAL_MS,
    refreshHostedReviewDetail,
  )
  useVisibleRefreshPolling(
    active &&
      !hostedDiffOpen &&
      hostedChecksSourceKey.length > 0 &&
      (hostedReviewChecksPending || hostedReviewChecksFailed),
    hostedReviewChecksWaiting,
    HOSTED_REVIEW_CHECKS_POLL_INTERVAL_MS,
    refreshHostedReviewChecks,
  )

  const workingTreeAtom = localReviewManifestAtom(
    active &&
      !host.workspaceRestoring &&
      host.activeActivity === PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID
      ? Option.match(Option.fromNullishOr(host.repo.localPath), {
          onNone: () => "",
          onSome: (localPath) => serializeLocalReviewAtomKey(workingTreeReviewTarget(localPath)),
        })
      : "",
  )
  const workingTreeResult = useAtomValue(workingTreeAtom)
  const refreshWorkingTree = useAtomRefresh(workingTreeAtom)
  const agentCatalogResult = useAtomValue(agentProviderCatalogAtom)
  const agentCatalog = AsyncResult.getOrElse(agentCatalogResult, () => EMPTY_AGENT_PROVIDER_CATALOG)
  useKeyboardShortcut(
    "review.toggleSidebar",
    () => {
      const activeElement = document.activeElement
      if (
        host.sidebarExpanded &&
        activeElement !== null &&
        activeElement.closest("[data-review-sidebar-collapse-region]") !== null
      ) {
        document.querySelector<HTMLButtonElement>("[data-workbench-sidebar-toggle]")?.focus()
      }
      host.setSidebarExpanded(!host.sidebarExpanded)
    },
    { enabled: active },
  )
  useKeyboardShortcut(
    "review.reload",
    () => {
      refreshHostedReviewDetail()
      refreshPullRequests()
      if (hostedChecksSourceKey.length > 0) refreshHostedReviewChecks()
    },
    {
      enabled: active && selectedReviewTarget?.kind === "hosted" && !hostedDiffOpen,
      priority: 10,
    },
  )
  if (reviewContribution === undefined || reviewSurfaceContribution === undefined) return null
  const selectReview = (next: NonNullable<typeof selectedReviewTarget>) => {
    const activity = host.activities.find(
      (candidate) => candidate.id === PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
    )
    if (activity === undefined) return
    Match.valueTags(selection, {
      none: () => undefined,
      loading: () => undefined,
      ready: () => undefined,
      failure: (failure) => {
        const nextSourceKeys = reviewSelectionSourceKeys(next)
        if (failure.sourceKey === nextSourceKeys.hosted) refreshHostedReview()
        if (failure.sourceKey === nextSourceKeys.local) refreshLocalReview()
        if (failure.sourceKey === nextSourceKeys.comparison) refreshRepositoryComparison()
      },
    })
    const state = navigation.encodeReviewSelection(Option.some(next))
    host.navigate(reviewContribution, activity.id, state)
    void host.persistLocation(reviewContribution, activity, state)
    captureAnalytics({
      event: "review_opened",
      reviewType: Match.value(next).pipe(
        Match.discriminatorsExhaustive("kind")({
          hosted: () => "pull_request" as const,
          localDiff: () => "local_diff" as const,
          repositoryComparison: () => "repository_comparison" as const,
        }),
      ),
    })
  }
  const linkSelectedReviewRepository = () =>
    Option.match(selectedReview, {
      onNone: () => Promise.resolve(false),
      onSome: (review) =>
        Match.value(review).pipe(
          Match.discriminatorsExhaustive("kind")({
            hosted: (hostedReview) => environment.linkRepository(hostedReview.review.repository),
            localDiff: () => Promise.resolve(false),
            repositoryComparison: () => Promise.resolve(false),
          }),
        ),
    })
  const repositoryLinkState = Option.match(selectedReview, {
    onNone: () => "not-applicable" as const,
    onSome: (review) =>
      Match.value(review).pipe(
        Match.discriminatorsExhaustive("kind")({
          hosted: (hostedReview) => {
            const activeRepositoryLinked = RepositoryCheckout.match(host.repo.checkout, {
              RemoteOnly: () => false,
              LinkedCheckout: () => host.repo.matchesHosted(hostedReview.review.repository),
            })
            if (activeRepositoryLinked) return "linked" as const
            if (
              AsyncResult.isWaiting(repositoriesResult) ||
              AsyncResult.isFailure(repositoriesResult)
            ) {
              return "checking" as const
            }
            const linked = repos.some((repo) =>
              RepositoryCheckout.match(repo.checkout, {
                RemoteOnly: () => false,
                LinkedCheckout: () => repo.matchesHosted(hostedReview.review.repository),
              }),
            )
            if (linked) return "linked" as const
            return "unlinked" as const
          },
          localDiff: () => "not-applicable" as const,
          repositoryComparison: () => "not-applicable" as const,
        }),
      ),
  })
  const reviewsContext = (
    <ReviewsPane
      hosted={projectHostedReviewsLifecycle(host.repo, pullRequestsResult)}
      local={projectLocalReviewsLifecycle(host.repo, workingTreeResult)}
      repo={host.repo}
      onRefreshHosted={refreshPullRequests}
      onRefreshLocal={refreshWorkingTree}
      onLinkRepository={() => void environment.linkRepository()}
      onSelect={selectReview}
    />
  )
  const reviewsMain = (
    <ProjectReviewsOverview
      hosted={projectHostedReviewsLifecycle(host.repo, pullRequestsResult)}
      local={projectLocalReviewsLifecycle(host.repo, workingTreeResult)}
      repo={host.repo}
      onRefreshHosted={refreshPullRequests}
      onRefreshLocal={refreshWorkingTree}
      onLinkRepository={() => void environment.linkRepository()}
      onSelect={selectReview}
    />
  )
  const listedHostedReview: HostedReviewSummary | null =
    selectedReviewTarget?.kind !== "hosted"
      ? null
      : (pullRequests.find(
          (review) =>
            makeHostedReviewKey(review.locator) ===
            makeHostedReviewKey(selectedReviewTarget.review),
        ) ?? null)
  const hostedReviewDetail: HostedReviewDetail | null = AsyncResult.isSuccess(
    hostedReviewDetailResult,
  )
    ? hostedReviewDetailResult.value
    : null
  const selectedHostedReview = hostedReviewDetail?.summary ?? listedHostedReview
  const selectedHostedProvider =
    selectedHostedReview === null
      ? null
      : (providers.find(
          (provider) => provider.id === selectedHostedReview.locator.repository.providerId,
        ) ?? null)
  const hostedReviewChecksError = AsyncResult.isFailure(hostedReviewChecksResult)
    ? formatError(
        Option.getOrNull(Cause.findErrorOption(hostedReviewChecksResult.cause)),
        "Could not load checks",
      )
    : null
  const hostedReviewActions =
    selectedHostedReview === null
      ? {
          close: null,
          merge: null,
          mergeBypassSupported: false,
          submit: null,
          updateBranch: null,
        }
      : reviewSourceOperations.makeHostedMutations(selectedHostedReview, selectedHostedProvider)
  const hostedReviewDetailError = AsyncResult.isFailure(hostedReviewDetailResult)
    ? formatError(
        Option.getOrNull(Cause.findErrorOption(hostedReviewDetailResult.cause)),
        "Could not load pull request details",
      )
    : null
  return (
    <ReviewSurfaceCapabilityProvider>
      <PersistentReviewSurfaceProviders>
        <ReviewScreen
          active={active}
          activeActivity={retainedActivityRef.current}
          activities={host.activities}
          projectId={host.repo.id}
          detailEnvironment={{
            aiAgentAvailable:
              agentRouteAvailable(
                agentCatalog,
                environment.aiSettings.selections.walkthrough,
                "walkthrough",
              ) || AsyncResult.isWaiting(agentCatalogResult),
            aiSettings: environment.aiSettings,
            quickNavigationRequest: host.quickNavigationRequest,
            repositoryLinkState,
            sidebarExpanded: host.sidebarExpanded,
            sidebarWidth: environment.contextWidth,
            threadDetailWidth: environment.threadDetailWidth,
            colorScheme: environment.colorScheme,
            onAISettingsChange: environment.updateAISettings,
            onLinkRepository: linkSelectedReviewRepository,
            onOpenCodeFile: (path, target, files, lineChanges, revealRange) => {
              if (codeContribution === undefined) return
              const activity = host.activities.find(
                (candidate) => candidate.id === codeSurfaceContribution?.defaultActivityId,
              )
              if (activity === undefined) return
              const state = createCodeFileNavigationState({
                projectId: host.repo.id,
                path,
                target,
                files,
                lineChanges,
                revealRange,
              })
              if (host.navigate(codeContribution, activity.id, state)) {
                void host.persistLocation(codeContribution, activity, state)
              }
            },
            onShowFilesActivity: () => host.selectActivity(PROJECT_WORKSPACE_FILES_ACTIVITY_ID),
            onSidebarExpandedChange: host.setSidebarExpanded,
            onSidebarWidthChange: environment.updateContextWidth,
            onThreadDetailWidthChange: environment.updateThreadDetailWidth,
          }}
          reviewsContext={reviewsContext}
          reviewsMain={reviewsMain}
          selectedHostedReview={selectedHostedReview}
          hostedReviewDetail={hostedReviewDetail}
          hostedReviewDetailError={hostedReviewDetailError}
          hostedReviewDetailLoading={
            !AsyncResult.isSuccess(hostedReviewDetailResult) ||
            AsyncResult.isWaiting(hostedReviewDetailResult)
          }
          hostedReviewChecks={hostedReviewChecks}
          hostedReviewChecksError={hostedReviewChecksError}
          hostedReviewChecksLoading={
            hostedChecksSourceKey.length > 0 && AsyncResult.isWaiting(hostedReviewChecksResult)
          }
          hostedReviewChecksSupported={selectedHostedProvider?.capabilities.reviewChecks === true}
          hostedReviewSelected={selectedReviewTarget?.kind === "hosted"}
          hostedDiffOpen={hostedDiffOpen}
          hostedReviewActions={hostedReviewActions}
          hostedReviewAbbreviation={selectedHostedProvider?.terminology.reviewAbbreviation ?? "PR"}
          hostedReviewProviderName={selectedHostedProvider?.displayName ?? "provider"}
          reviewDiffContributions={reviewDiffContributions}
          selection={selection}
          sourceOperations={sourceOperations}
          surfaceContribution={reviewSurfaceContribution}
          workspaceNotice={host.workspaceNotice}
          onActiveActivityChange={host.selectActivity}
          onOpenHostedDiff={() => {
            if (selectedReviewTarget?.kind !== "hosted") return
            const activity = host.activities.find(
              ({ id }) => id === PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
            )
            if (activity === undefined) return
            const state = navigation.encodeReviewSelection(
              Option.some({ ...selectedReviewTarget, view: "files" }),
            )
            if (host.navigate(reviewContribution, activity.id, state)) {
              void host.persistLocation(reviewContribution, activity, state)
            }
          }}
          onHostedActionCompleted={() => {
            refreshHostedReviewDetail()
            refreshPullRequests()
            if (hostedChecksSourceKey.length > 0) refreshHostedReviewChecks()
          }}
          onRetryHostedDetail={refreshHostedReviewDetail}
          onRefreshHostedChecks={refreshHostedReviewChecks}
          onRetrySelection={() => {
            Match.valueTags(selection, {
              none: () => undefined,
              loading: () => undefined,
              ready: () => undefined,
              failure: (failure) => {
                if (failure.sourceKey === sourceKeys.hosted) refreshHostedReview()
                if (failure.sourceKey === sourceKeys.local) refreshLocalReview()
                if (failure.sourceKey === sourceKeys.comparison) refreshRepositoryComparison()
              },
            })
          }}
        />
      </PersistentReviewSurfaceProviders>
    </ReviewSurfaceCapabilityProvider>
  )
}

const useVisibleRefreshPolling = (
  enabled: boolean,
  waiting: boolean,
  intervalMs: number,
  refresh: () => void,
) => {
  const refreshFromEvent = useEffectEvent(refresh)
  useEffect(() => {
    if (!enabled) return undefined

    let timer: number | undefined
    const clearTimer = () => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = undefined
    }
    const schedule = () => {
      clearTimer()
      if (document.visibilityState !== "visible" || waiting) return
      timer = window.setTimeout(refreshFromEvent, intervalMs)
    }
    const handleVisibilityChange = () => {
      clearTimer()
      if (document.visibilityState === "visible" && !waiting) refreshFromEvent()
    }

    schedule()
    document.addEventListener("visibilitychange", handleVisibilityChange)
    return () => {
      clearTimer()
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [enabled, intervalMs, waiting])
}

/** Keeps previously registered provider slots stable while toggling their owner controllers. */
export const PersistentReviewSurfaceProviders = ({
  children,
}: {
  readonly children: ReactNode
}) => {
  const { projectSurfaceProviders } = useTrustedExtensionRegistry()
  const knownProvidersRef = useRef(
    HashMap.fromIterable(
      projectSurfaceProviders
        .filter(({ surface }) => surface === "review")
        .map((provider) => [provider.id, provider]),
    ),
  )
  for (const provider of projectSurfaceProviders) {
    if (provider.surface === "review") {
      knownProvidersRef.current = HashMap.set(knownProvidersRef.current, provider.id, provider)
    }
  }
  const activeProviderIds = HashSet.fromIterable(
    projectSurfaceProviders
      .filter(({ surface }) => surface === "review")
      .map((provider) => provider.id),
  )
  const providerOrder = Order.combineAll<(typeof projectSurfaceProviders)[number]>([
    Order.mapInput(Order.Number, (provider) => provider.order),
    Order.mapInput(Order.String, (provider) => provider.id),
  ])
  return EffectArray.sort(
    [...HashMap.values(knownProvidersRef.current)],
    providerOrder,
  ).reduceRight<ReactNode>((content, provider) => {
    const Provider = provider.component
    return (
      <Provider
        key={`${provider.ownerExtensionId}:${provider.id}:${provider.ownerRegistrationToken.reactKey}`}
        active={HashSet.has(activeProviderIds, provider.id)}
        registrationToken={provider.ownerRegistrationToken}
      >
        {content}
      </Provider>
    )
  }, children)
}
