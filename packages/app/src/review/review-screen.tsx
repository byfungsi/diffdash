/* oxlint-disable eslint/no-underscore-dangle -- Domain unions use Effect-compatible _tag discriminants. */
import { ArrowLeft } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@/shared/ui/button"
import { EmptyState } from "@/shared/ui/empty-state"
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
  detailEnvironment,
  selection,
  sourceOperations,
  onBack,
}: {
  readonly detailEnvironment: ReviewDetailEnvironment
  readonly selection: ReviewSelectionProjection
  readonly sourceOperations: ReviewSourceOperationProjection
  readonly onBack: () => void
}) => {
  if (selection._tag === "ready" && sourceOperations._tag === "ready") {
    return (
      <ReadyReviewScreen
        key={selection.sourceKey}
        detailEnvironment={detailEnvironment}
        selection={selection}
        operations={sourceOperations.operations}
        onBack={onBack}
      />
    )
  }

  const status = selection._tag === "none" ? "Select a review to continue." : selection.status
  return (
    <section className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-8 py-10">
      <Button variant="ghost" className="mb-4 w-fit" onClick={onBack}>
        <ArrowLeft className="size-4" />
        Home
      </Button>
      <EmptyState>{status}</EmptyState>
    </section>
  )
}

const ReadyReviewScreen = ({
  detailEnvironment,
  selection,
  operations,
  onBack,
}: {
  readonly detailEnvironment: ReviewDetailEnvironment
  readonly selection: Extract<ReviewSelectionProjection, { readonly _tag: "ready" }>
  readonly operations: ReadyReviewDetailState["sourceOperations"]
  readonly onBack: () => void
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

  return <ReviewDetailView environment={detailEnvironment} ready={ready} onBack={onBack} />
}
