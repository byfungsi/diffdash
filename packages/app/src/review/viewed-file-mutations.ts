import type { ReviewViewedFileWrite } from "./review-source-operations"

/** Optimistic UI state changed by one viewed-file mutation. */
export type ViewedFileMutationSnapshot = {
  readonly viewed: boolean
  readonly expanded: boolean
}

/** One viewed-file transition and its rollback state. */
export type ViewedFileMutation = {
  readonly write: ReviewViewedFileWrite
  readonly previous: ViewedFileMutationSnapshot
  readonly next: ViewedFileMutationSnapshot
}

/** Side effects used by ordered viewed-file persistence. */
type ViewedFileMutationDependencies = {
  readonly write: (write: ReviewViewedFileWrite) => Promise<void>
  readonly onOptimistic: (mutation: ViewedFileMutation) => void
  readonly onRollback: (reviewKey: string, snapshot: ViewedFileMutationSnapshot) => void
  readonly onError: (write: ReviewViewedFileWrite, error: unknown) => void
}

/** Ordered and coalescing viewed-file mutation API. */
export type ViewedFileMutationCoordinator = {
  readonly submit: (mutation: ViewedFileMutation) => void
  readonly replaceConfirmed: (reviewKey: string, snapshot: ViewedFileMutationSnapshot) => void
  readonly whenIdle: () => Promise<void>
}

type PendingViewedFileMutation = ViewedFileMutation & {
  readonly version: number
}

/**
 * Applies viewed state immediately, coalesces pending writes per file, persists writes in order,
 * and rolls back only the latest failed transition to its last confirmed state.
 */
export const createViewedFileMutationCoordinator = (
  dependencies: ViewedFileMutationDependencies,
): ViewedFileMutationCoordinator => {
  const confirmed = new Map<string, ViewedFileMutationSnapshot>()
  const versions = new Map<string, number>()
  const pending = new Map<string, PendingViewedFileMutation>()
  let draining = false
  let scheduled = false
  let idlePromise = Promise.resolve()
  let resolveIdle: (() => void) | null = null

  const startIdleCycle = () => {
    if (resolveIdle !== null) return
    idlePromise = new Promise<void>((resolve) => {
      resolveIdle = resolve
    })
  }

  const finishIdleCycle = () => {
    const resolve = resolveIdle
    resolveIdle = null
    resolve?.()
  }

  const drain = async () => {
    scheduled = false
    if (draining) return
    draining = true
    while (pending.size > 0) {
      const entry = pending.entries().next().value
      if (entry === undefined) break
      const [reviewKey, mutation] = entry
      pending.delete(reviewKey)
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Persistence order is the coordinator's contract.
        await dependencies.write(mutation.write)
        confirmed.set(reviewKey, mutation.next)
      } catch (error) {
        if (versions.get(reviewKey) === mutation.version) {
          dependencies.onRollback(reviewKey, confirmed.get(reviewKey) ?? mutation.previous)
          dependencies.onError(mutation.write, error)
        }
      }
    }
    draining = false
    if (pending.size > 0) {
      void drain()
      return
    }
    finishIdleCycle()
  }

  return {
    submit: (mutation) => {
      const reviewKey = mutation.write.reviewKey
      const version = (versions.get(reviewKey) ?? 0) + 1
      versions.set(reviewKey, version)
      if (!confirmed.has(reviewKey)) confirmed.set(reviewKey, mutation.previous)
      dependencies.onOptimistic(mutation)
      pending.set(reviewKey, { ...mutation, version })
      startIdleCycle()
      if (!scheduled) {
        scheduled = true
        queueMicrotask(() => void drain())
      }
    },
    replaceConfirmed: (reviewKey, snapshot) => {
      if (!pending.has(reviewKey)) confirmed.set(reviewKey, snapshot)
    },
    whenIdle: () => idlePromise,
  }
}
