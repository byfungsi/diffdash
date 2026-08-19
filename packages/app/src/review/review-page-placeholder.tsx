import type { ReviewSnapshotFileInventory } from "@diffdash/domain/review-context"
import { useLayoutEffect, useRef } from "react"
import { Button } from "@/shared/ui/button"
import { MiddleTruncatedText } from "@/shared/ui/middle-truncated-text"
import { diffCardDomId } from "./viewed-file-viewport"

/** Placeholder shown while Core supplies one complete review file. */
export const ReviewPagePlaceholder = ({
  error,
  file,
  onFileAnchorChange,
  onRetry,
}: {
  readonly error: string
  readonly file: ReviewSnapshotFileInventory
  readonly onFileAnchorChange: (element: HTMLElement, focusElement: HTMLElement) => () => void
  readonly onRetry: () => void
}) => {
  const ref = useRef<HTMLElement>(null)
  const retryRef = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return undefined
    element.tabIndex = -1
    return onFileAnchorChange(element, retryRef.current ?? element)
  }, [onFileAnchorChange])

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
        <span className="text-muted-foreground text-caption shrink-0 whitespace-nowrap">
          Load failed
        </span>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
        <Button ref={retryRef} type="button" size="xs" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </section>
  )
}
