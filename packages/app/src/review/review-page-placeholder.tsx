/* oxlint-disable eslint/no-underscore-dangle -- Snapshot lifecycle uses Effect-compatible _tag discriminants. */
import type { ReviewSnapshotFileInventory } from "@diffdash/domain/review-context"
import { type RefObject, useEffect, useEffectEvent, useLayoutEffect, useRef } from "react"
import { Button } from "@/shared/ui/button"
import { MiddleTruncatedText } from "@/shared/ui/middle-truncated-text"
import { UnicodeLoadingText } from "@/shared/ui/unicode-loading-text"
import type { ReviewSnapshotRefreshStatus } from "./review-snapshot-page-session"
import { diffCardDomId } from "./viewed-file-viewport"

/** Lazy parsed-file placeholder inputs. */
interface ReviewPagePlaceholderProps {
  readonly error: string | null
  readonly file: ReviewSnapshotFileInventory
  readonly loading: boolean
  readonly scrollContainerRef: RefObject<HTMLElement | null>
  readonly snapshotRefresh: ReviewSnapshotRefreshStatus
  readonly tooLarge: boolean
  readonly onFileAnchorChange: (element: HTMLElement, focusElement: HTMLElement) => () => void
  readonly onRetry: () => void
  readonly onRefresh: () => void
  readonly onVisible: () => void
}

/** Preserves file order and triggers bounded page loading only near the diff viewport. */
export const ReviewPagePlaceholder = ({
  error,
  file,
  loading,
  scrollContainerRef,
  snapshotRefresh,
  tooLarge,
  onFileAnchorChange,
  onRetry,
  onRefresh,
  onVisible,
}: ReviewPagePlaceholderProps) => {
  const ref = useRef<HTMLElement>(null)
  const retryRef = useRef<HTMLButtonElement>(null)
  const handleVisible = useEffectEvent(onVisible)

  useEffect(() => {
    const target = ref.current
    if (target === null || loading || tooLarge || error !== null || snapshotRefresh._tag !== "idle")
      return undefined
    if (typeof IntersectionObserver === "undefined") {
      handleVisible()
      return undefined
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) handleVisible()
      },
      { root: scrollContainerRef.current, rootMargin: "600px 0px" },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [error, loading, scrollContainerRef, snapshotRefresh, tooLarge])

  useLayoutEffect(() => {
    const element = ref.current
    if (element === null || (!tooLarge && error === null && snapshotRefresh._tag !== "failed"))
      return undefined
    element.tabIndex = -1
    return onFileAnchorChange(element, retryRef.current ?? element)
  }, [error, onFileAnchorChange, snapshotRefresh, tooLarge])

  const refreshFailure = snapshotRefresh._tag === "failed" ? snapshotRefresh.message : null
  const displayedError = refreshFailure ?? error
  const refreshing = snapshotRefresh._tag === "refreshing"

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
            {tooLarge
              ? "File exceeds the bounded page size"
              : loading
                ? "Loading diff..."
                : displayedError === null
                  ? "Queued"
                  : refreshFailure === null
                    ? "Load failed"
                    : "Refresh failed"}
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
