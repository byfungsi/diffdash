import type { ParsedDiffFile } from "@diffdash/domain/diff"
import type { ReviewSnapshotManifest } from "@diffdash/domain/review-context"
import type { ReviewFileId } from "@diffdash/domain/review-identity"
import { RegistryContext, useAtomValue } from "@effect/atom-react"
import { useContext, useEffect, useRef, useState } from "react"
import { runRendererPromise, useReviewContent } from "@/platform/renderer-runtime"

import {
  type ReviewSnapshotLoadResult,
  type ReviewSnapshotPageProjection,
  type ReviewSnapshotPageReader,
  ReviewSnapshotPageSession,
} from "./review-snapshot-page-session"

export type {
  ReviewSnapshotFileLoadStatus,
  ReviewSnapshotLoadResult,
} from "./review-snapshot-page-session"

/** Incremental parsed-file loading state for one renderer manifest. */
export interface ReviewSnapshotPages extends ReviewSnapshotPageProjection {
  readonly getFile: (fileId: ReviewFileId) => ParsedDiffFile | null
  readonly loadFiles: (fileIds: readonly ReviewFileId[]) => Promise<ReviewSnapshotLoadResult>
  readonly pageReader: ReviewSnapshotPageReader
  readonly setPinnedFileIds: (fileIds: ReadonlySet<ReviewFileId>) => void
}

const maskedProjection = (manifest: ReviewSnapshotManifest): ReviewSnapshotPageProjection =>
  Object.freeze({
    projectId: manifest.projectId,
    snapshotId: manifest.snapshotId,
    files: Object.freeze([]),
    loadingFileIds: Object.freeze(new Set<ReviewFileId>()),
    tooLargeFileIds: Object.freeze(new Set<ReviewFileId>()),
    fileErrors: Object.freeze(new Map<ReviewFileId, string>()),
    snapshotRefresh: Object.freeze({ _tag: "idle" }),
  })

/** Thin React adapter around one explicitly disposable snapshot page session. */
export const useReviewSnapshotPages = (
  manifest: ReviewSnapshotManifest,
  onExpired: () => void | Promise<void>,
): ReviewSnapshotPages => {
  const registry = useContext(RegistryContext)
  const reviewContent = useReviewContent()
  const manifestRef = useRef(manifest)
  manifestRef.current = manifest
  const [session] = useState(
    () =>
      new ReviewSnapshotPageSession(registry, manifest, {
        getPage: (request) => runRendererPromise(reviewContent.snapshots.getPage(request)),
        onExpired,
      }),
  )
  const [pageReader] = useState<ReviewSnapshotPageReader>(() => ({
    getFile: (fileId) =>
      session.isManifestActive(manifestRef.current) ? session.getFile(fileId) : null,
    getProjection: () =>
      session.isManifestActive(manifestRef.current)
        ? session.getProjection()
        : maskedProjection(manifestRef.current),
    loadFiles: (fileIds) => {
      session.replaceManifest(manifestRef.current)
      return session.loadFiles(fileIds)
    },
    waitForManifestReplacement: (expectedSnapshotId, signal) =>
      session.waitForManifestReplacement(expectedSnapshotId, signal),
  }))
  const projection = useAtomValue(session.projectionAtom)
  const disposeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  session.updateRuntime({
    getPage: (request) => runRendererPromise(reviewContent.snapshots.getPage(request)),
    onExpired,
  })

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

  useEffect(() => {
    session.replaceManifest(manifest)
  }, [manifest, session])

  const currentProjection = session.isManifestActive(manifest)
    ? projection
    : maskedProjection(manifest)
  return {
    ...currentProjection,
    getFile: pageReader.getFile,
    loadFiles: pageReader.loadFiles,
    pageReader,
    setPinnedFileIds: session.setPinnedFileIds,
  }
}
