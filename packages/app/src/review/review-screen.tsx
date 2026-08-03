/* oxlint-disable eslint/no-underscore-dangle -- Domain unions use Effect-compatible _tag discriminants. */
import type { ProjectWorkspaceRibbon } from "@diffdash/domain/project-workspace"
import type { ReactNode } from "react"
import { useEffect, useState } from "react"

import { ProjectWorkspaceFrame } from "@/project-workspace/project-workspace-frame"
import { Button } from "@/shared/ui/button"
import { ProjectWorkspaceStatePanel } from "@/shared/ui/project-workspace-state-panel"
import {
  type ReadyReviewDetailState,
  type ReviewDetailEnvironment,
  ReviewDetailView,
} from "./review-detail-view"
import type { ReviewSelectionProjection } from "./review-selection"
import type { ReviewSourceOperationProjection } from "./use-review-source-operations"
import { useViewedFileMutations } from "./use-viewed-file-mutations"

/** Branches once over normalized selection and directly composes ready review detail. */
export const ReviewScreen = ({
  activeRibbon,
  detailEnvironment,
  reviewsContext,
  reviewsMain,
  selection,
  sourceOperations,
  workspaceNotice,
  onActiveRibbonChange,
  onRetrySelection,
}: {
  readonly activeRibbon: ProjectWorkspaceRibbon
  readonly detailEnvironment: ReviewDetailEnvironment
  readonly reviewsContext: ReactNode
  readonly reviewsMain: ReactNode
  readonly selection: ReviewSelectionProjection
  readonly sourceOperations: ReviewSourceOperationProjection
  readonly workspaceNotice: string | null
  readonly onActiveRibbonChange: (ribbon: ProjectWorkspaceRibbon) => void
  readonly onRetrySelection: () => void
}) => {
  if (selection._tag === "ready" && sourceOperations._tag === "ready") {
    return (
      <ReadyReviewScreen
        key={selection.sourceKey}
        activeRibbon={activeRibbon}
        detailEnvironment={detailEnvironment}
        reviewsContext={reviewsContext}
        selection={selection}
        operations={sourceOperations.operations}
        onActiveRibbonChange={onActiveRibbonChange}
      />
    )
  }

  const context =
    activeRibbon === "reviews" ? (
      reviewsContext
    ) : (
      <WorkspaceContextUnavailable
        ribbon={activeRibbon}
        onReviews={() => onActiveRibbonChange("reviews")}
      />
    )

  return (
    <ProjectWorkspaceFrame
      activeRibbon={activeRibbon}
      context={context}
      contextWidth={detailEnvironment.sidebarWidth}
      main={
        <WorkspaceMainState
          activeRibbon={activeRibbon}
          notice={workspaceNotice}
          reviewsMain={reviewsMain}
          selection={selection}
          onRetry={onRetrySelection}
          onReviews={() => onActiveRibbonChange("reviews")}
        />
      }
      sidebarExpanded={detailEnvironment.sidebarExpanded}
      threadDetailWidth={detailEnvironment.threadDetailWidth}
      onActiveRibbonChange={onActiveRibbonChange}
      onSidebarExpandedChange={detailEnvironment.onSidebarExpandedChange}
      onSidebarWidthChange={detailEnvironment.onSidebarWidthChange}
      onThreadDetailWidthChange={detailEnvironment.onThreadDetailWidthChange}
    />
  )
}

const ReadyReviewScreen = ({
  activeRibbon,
  detailEnvironment,
  reviewsContext,
  selection,
  operations,
  onActiveRibbonChange,
}: {
  readonly activeRibbon: ProjectWorkspaceRibbon
  readonly detailEnvironment: ReviewDetailEnvironment
  readonly reviewsContext: ReactNode
  readonly selection: Extract<ReviewSelectionProjection, { readonly _tag: "ready" }>
  readonly operations: ReadyReviewDetailState["sourceOperations"]
  readonly onActiveRibbonChange: (ribbon: ProjectWorkspaceRibbon) => void
}) => {
  const viewedFiles = useViewedFileMutations(selection, operations)
  const [selectedPath, setSelectedPath] = useState<string | null>(
    selection.inventory[0]?.path ?? null,
  )
  const [isReloading, setIsReloading] = useState(false)

  useEffect(() => {
    setSelectedPath((path) => {
      if (path !== null && selection.inventory.some((file) => file.path === path)) return path
      return selection.inventory[0]?.path ?? null
    })
  }, [selection.inventory])

  useEffect(() => {
    if (!isReloading || selection.refreshing) return
    const timer = window.setTimeout(() => setIsReloading(false), 0)
    return () => window.clearTimeout(timer)
  }, [isReloading, selection.refreshing, selection.manifest.snapshotId])

  const ready: ReadyReviewDetailState = {
    selection,
    sourceOperations: operations,
    expandedFileKeys: viewedFiles.expandedFileKeys,
    viewedFileKeys: viewedFiles.viewedFileKeys,
    selectedPath,
    isReloading: isReloading || selection.refreshing,
    status: viewedFiles.error ?? selection.status,
    operationError: viewedFiles.error,
    onReload: () => {
      setIsReloading(true)
      operations.refresh()
    },
    onSelectPath: setSelectedPath,
    onSetViewed: viewedFiles.setFileViewed,
    onToggleExpanded: viewedFiles.toggleExpanded,
  }

  return (
    <ReviewDetailView
      activeRibbon={activeRibbon}
      environment={detailEnvironment}
      ready={ready}
      reviewsContext={reviewsContext}
      onActiveRibbonChange={onActiveRibbonChange}
    />
  )
}

const WorkspaceMainState = ({
  activeRibbon,
  notice,
  reviewsMain,
  selection,
  onRetry,
  onReviews,
}: {
  readonly activeRibbon: ProjectWorkspaceRibbon
  readonly notice: string | null
  readonly reviewsMain: ReactNode
  readonly selection: ReviewSelectionProjection
  readonly onRetry: () => void
  readonly onReviews: () => void
}) => {
  const noticePanel =
    notice === null ? null : (
      <ProjectWorkspaceStatePanel
        announcement="alert"
        description={notice}
        title="Workspace notice"
        tone="warning"
      />
    )

  if (selection._tag === "loading") {
    return (
      <WorkspaceMainLayout notice={noticePanel}>
        <ProjectWorkspaceStatePanel
          announcement="loading"
          description={selection.status}
          progress={{ label: "Loading selected review" }}
          title="Opening review"
          tone="neutral"
        />
      </WorkspaceMainLayout>
    )
  }
  if (selection._tag === "failure") {
    return (
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
          description={selection.status}
          title="Review could not be opened"
          tone="danger"
        />
      </WorkspaceMainLayout>
    )
  }
  if (selection._tag === "ready") {
    return (
      <WorkspaceMainLayout notice={noticePanel}>
        <ProjectWorkspaceStatePanel
          announcement="loading"
          description="Preparing review operations."
          title="Preparing workspace"
          tone="neutral"
        />
      </WorkspaceMainLayout>
    )
  }
  if (activeRibbon === "reviews") {
    return <>{reviewsMain}</>
  }

  return (
    <WorkspaceMainLayout notice={noticePanel}>
      <ProjectWorkspaceStatePanel
        actions={
          <Button size="sm" onClick={onReviews}>
            Go to Reviews
          </Button>
        }
        description={`${ribbonLabel(activeRibbon)} becomes available after selecting a review.`}
        title={`${ribbonLabel(activeRibbon)} unavailable`}
        tone="neutral"
      />
    </WorkspaceMainLayout>
  )
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
  ribbon,
  onReviews,
}: {
  readonly ribbon: Exclude<ProjectWorkspaceRibbon, "reviews">
  readonly onReviews: () => void
}) => (
  <aside className="bg-review-sidebar flex h-full flex-col justify-center p-3">
    <ProjectWorkspaceStatePanel
      actions={
        <Button size="sm" onClick={onReviews}>
          Go to Reviews
        </Button>
      }
      description={`Select a review before opening ${ribbonLabel(ribbon).toLowerCase()}.`}
      title="No review selected"
      tone="neutral"
    />
  </aside>
)

const ribbonLabel = (ribbon: ProjectWorkspaceRibbon) =>
  ribbon === "files"
    ? "Files"
    : ribbon === "walkthrough"
      ? "Walkthrough"
      : ribbon === "threads"
        ? "Threads"
        : "Reviews"
