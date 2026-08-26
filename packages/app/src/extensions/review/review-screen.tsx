/* oxlint-disable eslint/no-underscore-dangle -- Domain unions use Effect-compatible _tag discriminants. */
import type { ProjectWorkspaceActivityId } from "@diffdash/domain/project-workspace"
import type { ReviewProjectId } from "@diffdash/domain/review-identity"
import type {
  HostedReviewCheck,
  HostedReviewDetail as HostedReviewDetailModel,
  HostedReviewSummary,
} from "@diffdash/domain/git-provider"
import type { ReactNode } from "react"
import { useEffect, useState } from "react"
import { Match, Option } from "effect"

import type {
  OwnedExtensionContribution,
  ProjectActivityContribution,
  ProjectSurfaceContribution,
  ReviewDiffContribution,
} from "@/extensions/extension-registry"
import { resolveProjectActivityMainPane } from "@/extensions/project-main-pane-resolver"
import { ProjectWorkspaceFrame } from "@/project-workspace/project-workspace-frame"
import { HostedReviewDetail } from "@/project-workspace/hosted-review-detail"
import type { HostedReviewActionOperations } from "@/project-workspace/hosted-review-actions"
import { Button } from "@/shared/ui/button"
import { ProjectWorkspaceStatePanel } from "@/shared/ui/project-workspace-state-panel"
import {
  type ReadyReviewDetailState,
  type ReviewDetailEnvironment,
  ReviewDetailView,
} from "@/review/review-detail-view"
import type { ReviewSelectionProjection } from "@/review/review-selection"
import type { ReviewSourceOperationProjection } from "@/review/use-review-source-operations"
import { useProgressiveReviewContent } from "@/review/use-progressive-review-content"
import { useViewedFileMutations } from "@/review/use-viewed-file-mutations"
import { ReviewActivityPaneProvider } from "./review-activity-panes"

/** Inputs supplied by the project host to the trusted Review extension surface. */
export interface ReviewScreenProps {
  readonly active: boolean
  readonly activeActivity: ProjectWorkspaceActivityId
  readonly activities: readonly OwnedExtensionContribution<ProjectActivityContribution>[]
  readonly detailEnvironment: ReviewDetailEnvironment
  readonly projectId: ReviewProjectId
  readonly reviewsContext: ReactNode
  readonly reviewsMain: ReactNode
  readonly selectedHostedReview: HostedReviewSummary | null
  readonly hostedReviewDetail: HostedReviewDetailModel | null
  readonly hostedReviewDetailError: string | null
  readonly hostedReviewDetailLoading: boolean
  readonly hostedReviewChecks: readonly HostedReviewCheck[]
  readonly hostedReviewChecksError: string | null
  readonly hostedReviewChecksLoading: boolean
  readonly hostedReviewChecksSupported: boolean
  readonly hostedReviewSelected: boolean
  readonly hostedDiffOpen: boolean
  readonly hostedReviewActions: HostedReviewActionOperations
  readonly hostedReviewAbbreviation: string
  readonly hostedReviewProviderName: string
  readonly reviewDiffContributions: readonly OwnedExtensionContribution<ReviewDiffContribution>[]
  readonly selection: ReviewSelectionProjection
  readonly sourceOperations: ReviewSourceOperationProjection
  readonly surfaceContribution: OwnedExtensionContribution<ProjectSurfaceContribution>
  readonly workspaceNotice: Option.Option<string>
  readonly onActiveActivityChange: (activityId: ProjectWorkspaceActivityId) => void
  readonly onOpenHostedDiff: () => void
  readonly onHostedActionCompleted: () => void
  readonly onRetryHostedDetail: () => void
  readonly onRefreshHostedChecks: () => void
  readonly onRetrySelection: () => void
}

/** Branches once over normalized selection and directly composes ready review detail. */
export const ReviewScreen = ({
  active,
  activeActivity,
  activities,
  detailEnvironment,
  projectId,
  reviewsContext,
  reviewsMain,
  selectedHostedReview,
  hostedReviewDetail,
  hostedReviewDetailError,
  hostedReviewDetailLoading,
  hostedReviewChecks,
  hostedReviewChecksError,
  hostedReviewChecksLoading,
  hostedReviewChecksSupported,
  hostedReviewSelected,
  hostedDiffOpen,
  hostedReviewActions,
  hostedReviewAbbreviation,
  hostedReviewProviderName,
  reviewDiffContributions,
  selection,
  sourceOperations,
  surfaceContribution,
  workspaceNotice,
  onActiveActivityChange,
  onOpenHostedDiff,
  onHostedActionCompleted,
  onRetryHostedDetail,
  onRefreshHostedChecks,
  onRetrySelection,
}: ReviewScreenProps) => {
  const activeActivityContribution = activities.find((activity) => activity.id === activeActivity)
  const activeIsDefault = activeActivity === surfaceContribution.defaultActivityId
  const activeLabel = activeActivityContribution?.label ?? "Activity"
  const selectDefaultReviewActivity = () => {
    const activity = activities.find(
      (candidate) => candidate.id === surfaceContribution.defaultActivityId,
    )
    if (activity !== undefined) onActiveActivityChange(activity.id)
  }
  const readySelection = Match.valueTags(selection, {
    ready: (ready) => Option.some(ready),
    loading: () => Option.none<Extract<ReviewSelectionProjection, { readonly _tag: "ready" }>>(),
    failure: () => Option.none<Extract<ReviewSelectionProjection, { readonly _tag: "ready" }>>(),
    none: () => Option.none<Extract<ReviewSelectionProjection, { readonly _tag: "ready" }>>(),
  })
  const readyOperations = Match.valueTags(sourceOperations, {
    ready: (ready) => Option.some(ready),
    unavailable: () =>
      Option.none<Extract<ReviewSourceOperationProjection, { readonly _tag: "ready" }>>(),
  })
  if (hostedReviewSelected && !hostedDiffOpen) {
    return (
      <ProjectWorkspaceFrame
        activeActivity={activeActivity}
        activities={activities}
        context={reviewsContext}
        contextWidth={detailEnvironment.sidebarWidth}
        main={
          <HostedReviewDetail
            actions={hostedReviewActions}
            checks={hostedReviewChecks}
            checksError={hostedReviewChecksError}
            checksLoading={hostedReviewChecksLoading}
            checksSupported={hostedReviewChecksSupported}
            commits={hostedReviewDetail?.commits ?? null}
            comments={hostedReviewDetail?.comments ?? null}
            error={hostedReviewDetailError}
            files={hostedReviewDetail?.files ?? null}
            loading={hostedReviewDetailLoading}
            mergeState={hostedReviewDetail?.mergeState ?? null}
            onOpenDiff={onOpenHostedDiff}
            onActionCompleted={onHostedActionCompleted}
            onRetry={onRetryHostedDetail}
            onRefreshChecks={onRefreshHostedChecks}
            providerName={hostedReviewProviderName}
            reviewAbbreviation={hostedReviewAbbreviation}
            summary={selectedHostedReview}
          />
        }
        sidebarExpanded={detailEnvironment.sidebarExpanded}
        threadDetailWidth={detailEnvironment.threadDetailWidth}
        onActiveActivityChange={onActiveActivityChange}
        onSidebarExpandedChange={detailEnvironment.onSidebarExpandedChange}
        onSidebarWidthChange={detailEnvironment.onSidebarWidthChange}
        onThreadDetailWidthChange={detailEnvironment.onThreadDetailWidthChange}
      />
    )
  }
  if (Option.isSome(readySelection) && Option.isSome(readyOperations)) {
    return (
      <ReadyReviewScreen
        key={readySelection.value.sourceKey}
        active={active}
        activeActivity={activeActivity}
        activities={activities}
        detailEnvironment={detailEnvironment}
        reviewsContext={reviewsContext}
        reviewDiffContributions={reviewDiffContributions}
        selection={readySelection.value}
        surfaceContribution={surfaceContribution}
        operations={readyOperations.value.operations}
        onActiveActivityChange={onActiveActivityChange}
      />
    )
  }

  const unavailableContext = (
    <WorkspaceContextUnavailable
      activityLabel={activeLabel}
      selection={selection}
      onReviews={selectDefaultReviewActivity}
    />
  )
  const context = activeIsDefault ? reviewsContext : unavailableContext
  const activityPaneProps = {
    location: { projectId, surface: "review" as const },
    paneHost: {
      contextOpen: detailEnvironment.sidebarExpanded,
      detailOpen: false,
      contextActions: null,
      openContext: () => detailEnvironment.onSidebarExpandedChange(true),
      openDetail: () => undefined,
      closeContext: () => detailEnvironment.onSidebarExpandedChange(false),
      closeDetail: () => undefined,
      showMain: () => detailEnvironment.onSidebarExpandedChange(false),
    },
  }

  return (
    <ReviewActivityPaneProvider reviewsContext={reviewsContext} filesContext={unavailableContext}>
      <ProjectWorkspaceFrame
        activeActivity={activeActivity}
        activities={activities}
        context={context}
        contextWidth={detailEnvironment.sidebarWidth}
        main={resolveProjectActivityMainPane({
          activeActivityId: activeActivity,
          activities,
          activityPaneProps,
          baseMain: (
            <WorkspaceMainState
              activeIsDefault={activeIsDefault}
              activityLabel={activeLabel}
              notice={workspaceNotice}
              reviewsMain={reviewsMain}
              selection={selection}
              onRetry={onRetrySelection}
              onReviews={selectDefaultReviewActivity}
            />
          ),
          surface: surfaceContribution,
        })}
        sidebarExpanded={detailEnvironment.sidebarExpanded}
        threadDetailWidth={detailEnvironment.threadDetailWidth}
        onActiveActivityChange={onActiveActivityChange}
        onSidebarExpandedChange={detailEnvironment.onSidebarExpandedChange}
        onSidebarWidthChange={detailEnvironment.onSidebarWidthChange}
        onThreadDetailWidthChange={detailEnvironment.onThreadDetailWidthChange}
      />
    </ReviewActivityPaneProvider>
  )
}

const ReadyReviewScreen = ({
  active,
  activeActivity,
  activities,
  detailEnvironment,
  reviewsContext,
  reviewDiffContributions,
  selection,
  surfaceContribution,
  operations,
  onActiveActivityChange,
}: {
  readonly active: boolean
  readonly activeActivity: ProjectWorkspaceActivityId
  readonly activities: readonly OwnedExtensionContribution<ProjectActivityContribution>[]
  readonly detailEnvironment: ReviewDetailEnvironment
  readonly reviewsContext: ReactNode
  readonly reviewDiffContributions: readonly OwnedExtensionContribution<ReviewDiffContribution>[]
  readonly selection: Extract<ReviewSelectionProjection, { readonly _tag: "ready" }>
  readonly surfaceContribution: OwnedExtensionContribution<ProjectSurfaceContribution>
  readonly operations: ReadyReviewDetailState["sourceOperations"]
  readonly onActiveActivityChange: (activityId: ProjectWorkspaceActivityId) => void
}) => {
  const content = useProgressiveReviewContent(selection.review.manifest, operations.refresh)
  const inventory = content.inventory
  const viewedFiles = useViewedFileMutations(selection, operations, inventory)
  const [selectedPath, setSelectedPath] = useState<Option.Option<string>>(() =>
    Option.fromNullishOr(inventory[0]?.path),
  )
  const [isReloading, setIsReloading] = useState(false)

  useEffect(() => {
    setSelectedPath((path) => {
      if (Option.exists(path, (value) => inventory.some((file) => file.path === value))) return path
      return Option.fromNullishOr(inventory[0]?.path)
    })
  }, [inventory])

  useEffect(() => {
    if (!isReloading || selection.refreshing) return
    const timer = window.setTimeout(() => setIsReloading(false), 0)
    return () => window.clearTimeout(timer)
  }, [isReloading, selection.refreshing, selection.review.manifest.snapshotId])

  const emptyInventoryStatus = Match.valueTags(selection.review, {
    hosted: () => Option.none<string>(),
    local: (review) => Option.some(`No local changes in ${review.manifest.detail.repoName}`),
    repositoryComparison: () => Option.none<string>(),
  })

  const status = Option.match(Option.fromNullishOr(viewedFiles.error), {
    onSome: (error) => error,
    onNone: () => {
      if (
        Option.isSome(emptyInventoryStatus) &&
        !content.inventoryLoading &&
        content.inventoryError === null &&
        inventory.length === 0
      ) {
        return emptyInventoryStatus.value
      }
      return selection.status
    },
  })

  const ready: ReadyReviewDetailState = {
    selection,
    progressiveContent: content,
    sourceOperations: operations,
    expandedFileKeys: viewedFiles.expandedFileKeys,
    viewedFileKeys: viewedFiles.viewedFileKeys,
    selectedPath,
    isReloading: isReloading || selection.refreshing,
    status,
    operationError: Option.fromNullishOr(viewedFiles.error),
    onReload: () => {
      setIsReloading(true)
      operations.refresh()
    },
    onSelectPath: (path) => setSelectedPath(Option.some(path)),
    onSetViewed: viewedFiles.setFileViewed,
    onToggleExpanded: viewedFiles.toggleExpanded,
  }

  return (
    <div className="contents" data-review-diff-open>
      <ReviewDetailView
        active={active}
        activeActivity={activeActivity}
        activities={activities}
        environment={detailEnvironment}
        ready={ready}
        reviewsContext={reviewsContext}
        reviewDiffContributions={reviewDiffContributions}
        surfaceContribution={surfaceContribution}
        onActiveActivityChange={onActiveActivityChange}
      />
    </div>
  )
}

const WorkspaceMainState = ({
  activeIsDefault,
  activityLabel,
  notice,
  reviewsMain,
  selection,
  onRetry,
  onReviews,
}: {
  readonly activeIsDefault: boolean
  readonly activityLabel: string
  readonly notice: Option.Option<string>
  readonly reviewsMain: ReactNode
  readonly selection: ReviewSelectionProjection
  readonly onRetry: () => void
  readonly onReviews: () => void
}) => {
  const noticePanel = Option.match(notice, {
    onNone: () => null,
    onSome: (message) => (
      <ProjectWorkspaceStatePanel
        announcement="alert"
        description={message}
        title="Workspace notice"
        tone="warning"
      />
    ),
  })

  return Match.valueTags(selection, {
    loading: (loading) => (
      <WorkspaceMainLayout notice={noticePanel}>
        <ProjectWorkspaceStatePanel
          announcement="loading"
          description={loading.status}
          progress={{ label: "Loading selected review" }}
          title="Opening review"
          tone="neutral"
        />
      </WorkspaceMainLayout>
    ),
    failure: (failure) => (
      <WorkspaceMainLayout notice={noticePanel}>
        <ProjectWorkspaceStatePanel
          announcement="alert"
          actions={
            <>
              <Button size="sm" onClick={onRetry}>
                Retry
              </Button>
              <Button size="sm" variant="outline" onClick={onReviews}>
                Choose another review
              </Button>
            </>
          }
          description={failure.status}
          title="Review could not be opened"
          tone="danger"
        />
      </WorkspaceMainLayout>
    ),
    ready: () => (
      <WorkspaceMainLayout notice={noticePanel}>
        <ProjectWorkspaceStatePanel
          announcement="loading"
          description="Preparing review operations."
          title="Preparing workspace"
          tone="neutral"
        />
      </WorkspaceMainLayout>
    ),
    none: () => {
      if (activeIsDefault) return <>{reviewsMain}</>
      return (
        <WorkspaceMainLayout notice={noticePanel}>
          <ProjectWorkspaceStatePanel
            actions={
              <Button size="sm" onClick={onReviews}>
                Go to Reviews
              </Button>
            }
            description={`${activityLabel} becomes available after selecting a review.`}
            title={`${activityLabel} unavailable`}
            tone="neutral"
          />
        </WorkspaceMainLayout>
      )
    },
  })
}

const WorkspaceMainLayout = ({
  children,
  notice,
}: {
  readonly children: ReactNode
  readonly notice: ReactNode
}) => (
  <section className="mx-auto flex min-h-full max-w-3xl flex-col justify-center gap-3 px-6 py-10">
    {notice}
    {children}
  </section>
)

const WorkspaceContextUnavailable = ({
  activityLabel,
  selection,
  onReviews,
}: {
  readonly activityLabel: string
  readonly selection: ReviewSelectionProjection
  readonly onReviews: () => void
}) => {
  const state = Match.valueTags(selection, {
    none: () => ({
      description: `Select a review before opening ${activityLabel.toLowerCase()}.`,
      title: "No review selected",
      tone: "neutral" as const,
    }),
    loading: (loading) => ({
      description: loading.status,
      title: "Opening selected review",
      tone: "neutral" as const,
    }),
    failure: (failure) => ({
      description: failure.status,
      title: "Selected review unavailable",
      tone: "danger" as const,
    }),
    ready: () => ({
      description: "Review operations are unavailable.",
      title: "Selected review unavailable",
      tone: "warning" as const,
    }),
  })

  return (
    <aside className="bg-review-sidebar flex h-full flex-col justify-center p-3">
      <ProjectWorkspaceStatePanel
        actions={
          <Button size="sm" onClick={onReviews}>
            Go to Reviews
          </Button>
        }
        description={state.description}
        title={state.title}
        tone={state.tone}
      />
    </aside>
  )
}
