/* oxlint-disable eslint/no-underscore-dangle -- Snapshot lifecycle uses Effect-compatible _tag discriminants. */
import type { ReviewSnapshotFileInventory } from "@diffdash/domain/review-context"
import { Match } from "effect"
import { useLayoutEffect, useRef } from "react"
import { Button } from "@/shared/ui/button"
import { MiddleTruncatedText } from "@/shared/ui/middle-truncated-text"
import { UnicodeLoadingText } from "@/shared/ui/unicode-loading-text"
import type { ProgressiveReviewRefreshStatus } from "./progressive-review-content-session"
import { diffCardDomId } from "./viewed-file-viewport"

/** Placeholder shown while Core supplies one complete review file. */
export const ReviewPagePlaceholder = ({
  error,
  file,
  loading,
  snapshotRefresh,
  onFileAnchorChange,
  onRetry,
  onRefresh,
}: {
  readonly error: string | null
  readonly file: ReviewSnapshotFileInventory
  readonly loading: boolean
  readonly snapshotRefresh: ProgressiveReviewRefreshStatus
  readonly onFileAnchorChange: (element: HTMLElement, focusElement: HTMLElement) => () => void
  readonly onRetry: () => void
  readonly onRefresh: () => void
}) => {
  const ref = useRef<HTMLElement>(null)
  const retryRef = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return undefined
    element.tabIndex = -1
    return onFileAnchorChange(element, retryRef.current ?? element)
  }, [onFileAnchorChange])

  const refreshFailure = Match.valueTags(snapshotRefresh, {
    failed: ({ message }) => message,
    idle: () => null,
    refreshing: () => null,
  })
  const displayedError = refreshFailure ?? error
  const refreshing = Match.valueTags(snapshotRefresh, {
    refreshing: () => true,
    idle: () => false,
    failed: () => false,
  })

  return (
    <section
      ref={ref}
      id={diffCardDomId(file.reviewKey)}
      data-diff-card-path={file.path}
      data-diff-file-status={file.status}
      data-review-file-id={file.fileId}
      data-review-page-placeholder-file-id={file.fileId}
      className="bg-card min-h-36 rounded-2xl border p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <MiddleTruncatedText value={file.path} className="flex-1 font-mono text-xs" />
        {refreshing ? (
          <UnicodeLoadingText
            className="text-muted-foreground text-caption shrink-0 whitespace-nowrap"
            text="Refreshing diff"
          />
        ) : (
          <span className="text-muted-foreground text-caption shrink-0 whitespace-nowrap">
            {loading ? "Loading diff..." : displayedError === null ? "Queued" : "Load failed"}
          </span>
        )}
      </div>
      {displayedError === null ? null : (
        <div className="mt-3 flex items-center justify-between gap-3">
          <p role="alert" className="text-destructive text-xs">
            {displayedError}
          </p>
          <Button
            ref={retryRef}
            type="button"
            size="xs"
            variant="outline"
            onClick={refreshFailure === null ? onRetry : onRefresh}
          >
            Retry
          </Button>
        </div>
      )}
    </section>
  )
}
