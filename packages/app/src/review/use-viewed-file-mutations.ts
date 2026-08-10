/* oxlint-disable eslint/no-underscore-dangle -- Renderer review variants use Effect-compatible _tag discriminants. */
import type { ReviewSnapshotFileInventory } from "@diffdash/domain/review-context"
import { ReviewKey } from "@diffdash/domain/review-identity"
import { Match } from "effect"
import { useEffect, useEffectEvent, useRef, useState } from "react"
import { useCaptureAnalytics } from "@/shared/analytics"
import { formatError } from "@/shared/errors"
import type { ReviewSelectionProjection } from "./review-selection"
import type { ReviewSourceOperations } from "./use-review-source-operations"
import {
  type ViewedFileMutationCoordinator,
  type ViewedFileMutationSnapshot,
  createViewedFileMutationCoordinator,
} from "./viewed-file-mutations"

/** Local viewed and expansion state coordinated with persisted writes. */
type ViewedFileMutationController = {
  readonly viewedFileKeys: ReadonlySet<string>
  readonly expandedFileKeys: ReadonlySet<string>
  readonly error: string | null
  readonly setFileViewed: (reviewKey: string, viewed: boolean) => void
  readonly toggleExpanded: (reviewKey: string) => void
}

const matchingInventoryFile = (
  inventory: readonly ReviewSnapshotFileInventory[],
  reviewKey: string,
) =>
  inventory.find(
    (candidate) =>
      candidate.reviewKey === reviewKey || reviewKey.startsWith(`${candidate.reviewKey}:`),
  )

/** Owns optimistic viewed state, ordered persistence, coalescing, and rejection rollback. */
export const useViewedFileMutations = (
  selection: Extract<ReviewSelectionProjection, { readonly _tag: "ready" }>,
  operations: ReviewSourceOperations,
): ViewedFileMutationController => {
  const captureAnalytics = useCaptureAnalytics()
  const inventory = selection.review.manifest.files
  const initialExpanded = new Set(inventory.map((file) => file.reviewKey))
  const viewedRef = useRef<ReadonlySet<string>>(new Set())
  const expandedRef = useRef<ReadonlySet<string>>(initialExpanded)
  const [viewedFileKeys, setViewedFileKeys] = useState<ReadonlySet<string>>(new Set())
  const [expandedFileKeys, setExpandedFileKeys] = useState<ReadonlySet<string>>(initialExpanded)
  const [error, setError] = useState<string | null>(null)
  const operationsRef = useRef(operations)
  operationsRef.current = operations
  const [coordinator] = useState<ViewedFileMutationCoordinator>(() =>
    createViewedFileMutationCoordinator({
      write: (write) => operationsRef.current.setViewedFile(write),
      onOptimistic: ({ write, next }) => {
        const nextViewed = new Set(viewedRef.current)
        const nextExpanded = new Set(expandedRef.current)
        if (next.viewed) nextViewed.add(write.reviewKey)
        else nextViewed.delete(write.reviewKey)
        if (next.expanded) nextExpanded.add(write.reviewKey)
        else nextExpanded.delete(write.reviewKey)
        viewedRef.current = nextViewed
        expandedRef.current = nextExpanded
        setViewedFileKeys(nextViewed)
        setExpandedFileKeys(nextExpanded)
        setError(null)
      },
      onRollback: (reviewKey, snapshot) => {
        const nextViewed = new Set(viewedRef.current)
        const nextExpanded = new Set(expandedRef.current)
        if (snapshot.viewed) nextViewed.add(reviewKey)
        else nextViewed.delete(reviewKey)
        if (snapshot.expanded) nextExpanded.add(reviewKey)
        else nextExpanded.delete(reviewKey)
        viewedRef.current = nextViewed
        expandedRef.current = nextExpanded
        setViewedFileKeys(nextViewed)
        setExpandedFileKeys(nextExpanded)
      },
      onError: (write, cause) => {
        const path = matchingInventoryFile(inventory, write.reviewKey)?.path ?? write.reviewKey
        setError(
          `${formatError(cause, `Could not save viewed state for ${path}`)} The viewed and expansion state was reverted; retry the action.`,
        )
      },
    }),
  )
  const listViewedFiles = useEffectEvent(() => operations.listViewedFiles())

  useEffect(() => {
    let cancelled = false
    const expanded = new Set(inventory.map((file) => file.reviewKey))
    viewedRef.current = new Set()
    expandedRef.current = expanded
    setViewedFileKeys(new Set())
    setExpandedFileKeys(expanded)
    setError(null)
    inventory.forEach((file) => {
      coordinator.replaceConfirmed(file.reviewKey, { viewed: false, expanded: true })
    })

    void listViewedFiles()
      .then((records) => {
        if (cancelled) return undefined
        const viewed = new Set(
          records.flatMap((record) => {
            const file = matchingInventoryFile(inventory, record.reviewKey)
            return file?.patchHash === record.patchHash ? [record.reviewKey] : []
          }),
        )
        viewedRef.current = viewed
        setViewedFileKeys(viewed)
        inventory.forEach((file) => {
          coordinator.replaceConfirmed(file.reviewKey, {
            viewed: viewed.has(file.reviewKey),
            expanded: true,
          })
        })
        return undefined
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(
            formatError(cause, "Could not load viewed files; retry by reloading the review."),
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [coordinator, inventory, selection.sourceKey])

  const setFileViewed = (reviewKey: string, viewed: boolean) => {
    const file = matchingInventoryFile(inventory, reviewKey)
    if (file === undefined) return
    const previous: ViewedFileMutationSnapshot = {
      viewed: viewedRef.current.has(reviewKey),
      expanded: expandedRef.current.has(reviewKey),
    }
    coordinator.submit({
      write: { reviewKey: ReviewKey.make(reviewKey), patchHash: file.patchHash, viewed },
      previous,
      next: { viewed, expanded: !viewed },
    })
    captureAnalytics({
      event: "review_file_viewed",
      reviewType: Match.valueTags(selection.review, {
        hosted: () => "pull_request" as const,
        local: () => "local_diff" as const,
        repositoryComparison: () => "repository_comparison" as const,
      }),
      viewed,
    })
  }

  return {
    viewedFileKeys,
    expandedFileKeys,
    error,
    setFileViewed,
    toggleExpanded: (reviewKey) => {
      const next = new Set(expandedRef.current)
      if (next.has(reviewKey)) next.delete(reviewKey)
      else next.add(reviewKey)
      expandedRef.current = next
      setExpandedFileKeys(next)
    },
  }
}
