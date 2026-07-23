import type { ReviewSnapshotFileInventory } from "@diffdash/domain/review-context"
import { useEffect, useRef } from "react"
import { MiddleTruncatedText } from "@/shared/ui/middle-truncated-text"
import { diffCardDomId } from "./viewed-file-viewport"

/** Lazy parsed-file placeholder inputs. */
interface ReviewPagePlaceholderProps {
  readonly file: ReviewSnapshotFileInventory
  readonly loading: boolean
  readonly tooLarge: boolean
  readonly onVisible: () => void
}

/** Preserves file order and triggers bounded page loading only near the diff viewport. */
export const ReviewPagePlaceholder = ({
  file,
  loading,
  tooLarge,
  onVisible,
}: ReviewPagePlaceholderProps) => {
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    const target = ref.current
    if (target === null || tooLarge) return undefined
    if (typeof IntersectionObserver === "undefined") {
      onVisible()
      return undefined
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onVisible()
      },
      { rootMargin: "600px 0px" },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [onVisible, tooLarge])

  return (
    <section
      ref={ref}
      id={diffCardDomId(file.reviewKey)}
      data-diff-card-path={file.path}
      className="bg-card min-h-36 rounded-2xl border p-4 shadow-xs"
    >
      <div className="flex items-center justify-between gap-3">
        <MiddleTruncatedText value={file.path} className="flex-1 font-mono text-xs" />
        <span className="text-muted-foreground text-caption shrink-0 whitespace-nowrap">
          {tooLarge ? "File exceeds the bounded page size" : loading ? "Loading diff..." : "Queued"}
        </span>
      </div>
    </section>
  )
}
