import type { ReviewSnapshotManifest } from "@diffdash/domain/review-context"
import { RegistryContext, useAtomValue } from "@effect/atom-react"
import { useContext, useEffect, useRef, useState } from "react"

import { useReviewContent } from "@/platform/renderer-runtime"
import {
  ProgressiveReviewContentSession,
  type ProgressiveReviewContentProjection,
  type ProgressiveReviewContentReader,
} from "./progressive-review-content-session"

/** Progressive inventory and range state for one active review manifest. */
export interface ProgressiveReviewContent extends ProgressiveReviewContentProjection {
  readonly reader: ProgressiveReviewContentReader
}

/** Thin React adapter around one explicitly disposable progressive review session. */
export const useProgressiveReviewContent = (
  manifest: ReviewSnapshotManifest,
  onExpired: () => void | Promise<void>,
): ProgressiveReviewContent => {
  const registry = useContext(RegistryContext)
  const reviewContent = useReviewContent()
  const [session] = useState(
    () =>
      new ProgressiveReviewContentSession(
        registry,
        manifest,
        reviewContent.progressive,
        reviewContent.progressiveSessions,
        onExpired,
      ),
  )
  const projection = useAtomValue(session.projectionAtom)
  const disposeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  session.updateRuntime(onExpired)

  useEffect(() => {
    if (disposeTimerRef.current !== null) {
      clearTimeout(disposeTimerRef.current)
      disposeTimerRef.current = null
    }
    session.mount()
    return () => {
      disposeTimerRef.current = setTimeout(() => session.dispose(), 0)
    }
  }, [session])

  useEffect(() => session.replaceManifest(manifest), [manifest, session])

  return { ...projection, reader: session.reader }
}
