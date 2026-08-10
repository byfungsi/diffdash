import type { ReviewFileId } from "@diffdash/domain/review-identity"

import type { MountedReviewAnchor } from "./review-navigation"

/** Serializable structural information registered before a final target mounts. */
export interface RegisteredReviewTargetDescriptor {
  readonly anchorKey: string
  readonly fileId: ReviewFileId
}

interface RegisteredAnchor extends MountedReviewAnchor {
  readonly generation: number
}

interface AnchorWaiter {
  readonly resolve: (anchor: MountedReviewAnchor) => void
  readonly reject: (error: DOMException) => void
  readonly signal: AbortSignal
  readonly onAbort: () => void
}

/** Review-scoped registry for structural descriptors and generation-aware mounted anchors. */
export class ReviewNavigationAnchorRegistry {
  readonly #descriptors = new Map<string, RegisteredReviewTargetDescriptor>()
  readonly #anchors = new Map<string, RegisteredAnchor>()
  readonly #waiters = new Map<string, Set<AnchorWaiter>>()
  #generation = 0

  /** Registers a structural target without retaining a DOM resource. */
  readonly registerDescriptor = (descriptor: RegisteredReviewTargetDescriptor) => {
    this.#descriptors.set(descriptor.anchorKey, descriptor)
    return () => {
      if (this.#descriptors.get(descriptor.anchorKey) === descriptor) {
        this.#descriptors.delete(descriptor.anchorKey)
      }
    }
  }

  /** Resolves structural loading ownership for one semantic anchor key. */
  readonly descriptor = (anchorKey: string) => this.#descriptors.get(anchorKey) ?? null

  /** Registers one mounted target and returns a generation-aware disposer. */
  readonly registerAnchor = (
    anchorKey: string,
    anchor: Omit<MountedReviewAnchor, "generation">,
  ) => {
    const generation = this.#generation + 1
    this.#generation = generation
    const registered: RegisteredAnchor = { ...anchor, generation }
    this.#anchors.set(anchorKey, registered)
    const waiters = this.#waiters.get(anchorKey)
    if (waiters !== undefined) {
      this.#waiters.delete(anchorKey)
      for (const waiter of waiters) {
        waiter.signal.removeEventListener("abort", waiter.onAbort)
        waiter.resolve(registered)
      }
    }
    return () => {
      if (this.#anchors.get(anchorKey)?.generation === generation) this.#anchors.delete(anchorKey)
    }
  }

  /** Returns a connected mounted target if one is currently registered. */
  readonly getAnchor = (anchorKey: string): MountedReviewAnchor | null => {
    const anchor = this.#anchors.get(anchorKey)
    if (anchor === undefined || !anchor.isConnected()) return null
    return anchor
  }

  /** Waits abortably for the next connected mounted target. */
  readonly waitForAnchor = (anchorKey: string, signal: AbortSignal) => {
    const current = this.getAnchor(anchorKey)
    if (current !== null) return Promise.resolve(current)
    if (signal.aborted) return Promise.reject(new DOMException("Navigation aborted", "AbortError"))

    return new Promise<MountedReviewAnchor>((resolve, reject) => {
      const onAbort = () => {
        const waiters = this.#waiters.get(anchorKey)
        waiters?.delete(waiter)
        if (waiters?.size === 0) this.#waiters.delete(anchorKey)
        reject(new DOMException("Navigation aborted", "AbortError"))
      }
      const waiter: AnchorWaiter = { resolve, reject, signal, onAbort }
      const waiters = this.#waiters.get(anchorKey) ?? new Set<AnchorWaiter>()
      waiters.add(waiter)
      this.#waiters.set(anchorKey, waiters)
      signal.addEventListener("abort", onAbort, { once: true })
    })
  }

  /** Clears descriptors, anchors, and waiters at review teardown. */
  readonly dispose = () => {
    this.#descriptors.clear()
    this.#anchors.clear()
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) {
        waiter.signal.removeEventListener("abort", waiter.onAbort)
        waiter.reject(new DOMException("Navigation bridge disposed", "AbortError"))
      }
    }
    this.#waiters.clear()
  }
}

/** Stable mounted-anchor key for a file card. */
export const reviewFileAnchorKey = (fileId: ReviewFileId) => `file:${fileId}`
