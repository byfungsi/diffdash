/* oxlint-disable eslint/no-underscore-dangle -- Renderer review variants use Effect-compatible _tag discriminants. */
import type { ReviewSnapshotFileInventory } from "@diffdash/domain/review-context"
import { ReviewKey } from "@diffdash/domain/review-identity"
import { HashSet, Match } from "effect"
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
  readonly viewedFileKeys: HashSet.HashSet<string>
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
  inventory: readonly ReviewSnapshotFileInventory[],
): ViewedFileMutationController => {
  const captureAnalytics = useCaptureAnalytics()
  const initialExpanded = new Set(inventory.map((file) => file.reviewKey))
  const inventoryRef = useRef(inventory)
  inventoryRef.current = inventory
  const viewedRef = useRef(HashSet.empty<string>())
  const expandedRef = useRef<ReadonlySet<string>>(initialExpanded)
  const [viewedFileKeys, setViewedFileKeys] = useState(() => HashSet.empty<string>())
  const [expandedFileKeys, setExpandedFileKeys] = useState<ReadonlySet<string>>(initialExpanded)
  const [error, setError] = useState<string | null>(null)
  const operationsRef = useRef(operations)
  operationsRef.current = operations
  const [coordinator] = useState<ViewedFileMutationCoordinator>(() =>
    createViewedFileMutationCoordinator({
      write: (write) => operationsRef.current.setViewedFile(write),
      onOptimistic: ({ write, next }) => {
        const nextViewed = next.viewed
          ? HashSet.add(viewedRef.current, write.reviewKey)
          : HashSet.remove(viewedRef.current, write.reviewKey)
        const nextExpanded = new Set(expandedRef.current)
        if (next.expanded) nextExpanded.add(write.reviewKey)
        else nextExpanded.delete(write.reviewKey)
        viewedRef.current = nextViewed
        expandedRef.current = nextExpanded
        setViewedFileKeys(nextViewed)
        setExpandedFileKeys(nextExpanded)
        setError(null)
      },
      onRollback: (reviewKey, snapshot) => {
        const nextViewed = snapshot.viewed
          ? HashSet.add(viewedRef.current, reviewKey)
          : HashSet.remove(viewedRef.current, reviewKey)
        const nextExpanded = new Set(expandedRef.current)
        if (snapshot.expanded) nextExpanded.add(reviewKey)
        else nextExpanded.delete(reviewKey)
        viewedRef.current = nextViewed
        expandedRef.current = nextExpanded
        setViewedFileKeys(nextViewed)
        setExpandedFileKeys(nextExpanded)
      },
      onError: (write, cause) => {
        const path =
          matchingInventoryFile(inventoryRef.current, write.reviewKey)?.path ?? write.reviewKey
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
    viewedRef.current = HashSet.empty()
    expandedRef.current = expanded
    setViewedFileKeys(HashSet.empty())
    setExpandedFileKeys(expanded)
    setError(null)
    inventory.forEach((file) => {
      coordinator.replaceConfirmed(file.reviewKey, { viewed: false, expanded: true })
    })

    void listViewedFiles()
      .then((records) => {
        if (cancelled) return undefined
        const viewed = HashSet.fromIterable(
          records.flatMap((record) => {
            const file = matchingInventoryFile(inventory, record.reviewKey)
            return file?.patchHash === record.patchHash ? [record.reviewKey] : []
          }),
        )
        viewedRef.current = viewed
        setViewedFileKeys(viewed)
        inventory.forEach((file) => {
          coordinator.replaceConfirmed(file.reviewKey, {
            viewed: HashSet.has(viewed, file.reviewKey),
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
      viewed: HashSet.has(viewedRef.current, reviewKey),
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
