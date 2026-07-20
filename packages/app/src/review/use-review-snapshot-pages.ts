import type { ParsedDiffFile } from "@diffdash/domain/diff"
import type { ReviewSnapshotManifest } from "@diffdash/domain/review-context"
import type { ReviewFileId } from "@diffdash/domain/review-identity"
import {
  REVIEW_SNAPSHOT_PAGE_FILE_LIMIT,
  ReviewSnapshotPageRequest,
  ReviewSnapshotPageResponse,
} from "@diffdash/protocol/review-snapshot"
import { Schema } from "effect"
import { useEffect, useRef, useState } from "react"
import { useStableCallback } from "./pierre"
import { ReviewPageCache } from "./review-page-cache"

/** Incremental parsed-file loading state for one renderer manifest. */
interface ReviewSnapshotPages {
  readonly files: readonly ParsedDiffFile[]
  readonly loadingFileIds: ReadonlySet<ReviewFileId>
  readonly tooLargeFileIds: ReadonlySet<ReviewFileId>
  readonly getFile: (fileId: ReviewFileId) => ParsedDiffFile | null
  readonly loadFiles: (fileIds: readonly ReviewFileId[]) => Promise<void>
}

/** Loads selected snapshot files lazily while retaining only a bounded LRU page cache. */
export const useReviewSnapshotPages = (
  manifest: ReviewSnapshotManifest,
  onExpired: () => void | Promise<void>,
): ReviewSnapshotPages => {
  const [cache] = useState(() => new ReviewPageCache())
  const [files, setFiles] = useState<readonly ParsedDiffFile[]>([])
  const [loadingFileIds, setLoadingFileIds] = useState<ReadonlySet<ReviewFileId>>(() => new Set())
  const [tooLargeFileIds, setTooLargeFileIds] = useState<ReadonlySet<ReviewFileId>>(() => new Set())
  const onExpiredRef = useRef(onExpired)
  const activeSnapshotIdRef = useRef(manifest.snapshotId)
  const inFlightRef = useRef(new Set<ReviewFileId>())
  const expiredRef = useRef(false)

  onExpiredRef.current = onExpired

  useEffect(() => {
    activeSnapshotIdRef.current = manifest.snapshotId
    inFlightRef.current.clear()
    expiredRef.current = false
    cache.clear()
    setFiles([])
    setLoadingFileIds(new Set())
    setTooLargeFileIds(new Set())
  }, [cache, manifest.snapshotId])

  const getFile = useStableCallback((fileId: ReviewFileId) => cache.get(fileId))
  const loadFiles = useStableCallback(async (requestedFileIds: readonly ReviewFileId[]) => {
    const snapshotId = manifest.snapshotId
    const pending = [...new Set(requestedFileIds)].filter(
      (fileId) =>
        cache.get(fileId) === null &&
        !inFlightRef.current.has(fileId) &&
        !tooLargeFileIds.has(fileId),
    )
    if (pending.length === 0) return

    pending.forEach((fileId) => inFlightRef.current.add(fileId))
    setLoadingFileIds(new Set(inFlightRef.current))
    try {
      for (let start = 0; start < pending.length; start += REVIEW_SNAPSHOT_PAGE_FILE_LIMIT) {
        const fileIds = pending.slice(start, start + REVIEW_SNAPSHOT_PAGE_FILE_LIMIT)
        let response = Schema.decodeUnknownSync(ReviewSnapshotPageResponse)(
          // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential pages bound concurrent IPC and cache pressure.
          await window.diffDash.reviewSnapshots.getPage(
            ReviewSnapshotPageRequest.make({ snapshotId, cursor: null, fileIds }),
          ),
        )
        if (activeSnapshotIdRef.current !== snapshotId) return
        if (response["_tag"] === "expired") {
          if (!expiredRef.current) {
            expiredRef.current = true
            // oxlint-disable-next-line eslint/no-await-in-loop -- Recovery must complete before retrying this page.
            await onExpiredRef.current()
            if (activeSnapshotIdRef.current !== snapshotId) return
            response = Schema.decodeUnknownSync(ReviewSnapshotPageResponse)(
              // oxlint-disable-next-line eslint/no-await-in-loop -- Retry uses the snapshot reacquired immediately above.
              await window.diffDash.reviewSnapshots.getPage(
                ReviewSnapshotPageRequest.make({ snapshotId, cursor: null, fileIds }),
              ),
            )
          }
          if (response["_tag"] === "expired") return
          expiredRef.current = false
        }
        if (response["_tag"] === "fileTooLarge") {
          setTooLargeFileIds((current) => new Set(current).add(response.file.fileId))
          continue
        }
        cache.put(response.files, new Set(fileIds))
        setFiles(cache.files())
      }
    } finally {
      pending.forEach((fileId) => inFlightRef.current.delete(fileId))
      setLoadingFileIds(new Set(inFlightRef.current))
    }
  })

  return { files, loadingFileIds, tooLargeFileIds, getFile, loadFiles }
}
