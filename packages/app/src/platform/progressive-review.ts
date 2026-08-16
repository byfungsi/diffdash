import type {
  CloseReviewSessionRequest,
  ProgressiveReviewApi,
  ReviewSessionIdentity,
  ReviewSessionState,
} from "@diffdash/protocol/review-session"
import {
  CurrentReviewSessionRequest,
  ReviewSessionState as ReviewSessionStateSchema,
} from "@diffdash/protocol/review-session"
import { Schema } from "effect"
import type { DiffDashBridgeApi } from "@diffdash/protocol/api"
import { InvokeChannel } from "@diffdash/protocol/channels"

import type {
  ReviewSessionConnection,
  ReviewSessionGateway,
} from "../review/progressive-review-session"
import { runRendererPromise } from "./renderer-effect"
import { invokePreload, invokePreloadVoid } from "./renderer-api-error"

/** Poll interval for authoritative session state while event replay is not yet connected. */
export const PROGRESSIVE_REVIEW_STATE_POLL_MS = 250

/** Restores typed progressive review values from the context-bridged preload surface. */
export const createProgressiveReviewApi = (
  bridge: DiffDashBridgeApi["progressiveReviews"],
): ProgressiveReviewApi => ({
  openSession: (request) =>
    runRendererPromise(
      invokePreload(InvokeChannel.openProgressiveReviewSession, () => bridge.openSession(request)),
    ),
  currentSession: (request) =>
    runRendererPromise(
      invokePreload(InvokeChannel.getProgressiveReviewSession, () =>
        bridge.currentSession(request),
      ),
    ),
  closeSession: (request) =>
    runRendererPromise(
      invokePreload(InvokeChannel.closeProgressiveReviewSession, () =>
        bridge.closeSession(request),
      ),
    ),
  inventory: (request) =>
    runRendererPromise(
      invokePreload(InvokeChannel.getProgressiveReviewInventory, () => bridge.inventory(request)),
    ),
  readRange: (request) =>
    runRendererPromise(
      invokePreload(InvokeChannel.readProgressiveReviewRange, () => bridge.readRange(request)),
    ),
  waitForRange: (request) =>
    runRendererPromise(
      invokePreload(InvokeChannel.waitForProgressiveReviewRange, () =>
        bridge.waitForRange(request),
      ),
    ),
  resolveTarget: (request) =>
    runRendererPromise(
      invokePreload(InvokeChannel.resolveProgressiveReviewTarget, () =>
        bridge.resolveTarget(request),
      ),
    ),
  search: (request, onPublication) =>
    runRendererPromise(
      invokePreloadVoid(InvokeChannel.searchProgressiveReview, () =>
        bridge.search(request, onPublication),
      ),
    ),
})

/** Creates the renderer session gateway over the browser-safe preload contract. */
export const createProgressiveReviewSessionGateway = (
  api: ProgressiveReviewApi,
  pollMilliseconds = PROGRESSIVE_REVIEW_STATE_POLL_MS,
): ReviewSessionGateway => {
  const connections = new Map<string, PollingReviewSessionConnection>()

  return {
    openSession: async (request): Promise<ReviewSessionConnection> => {
      const state = Schema.decodeUnknownSync(ReviewSessionStateSchema)(
        await api.openSession(request),
      )
      const key = sessionKey(state.identity)
      connections.get(key)?.dispose()
      const connection = new PollingReviewSessionConnection(api, state, pollMilliseconds)
      connections.set(key, connection)
      return connection
    },
    closeSession: async (request: CloseReviewSessionRequest): Promise<void> => {
      const key = sessionKey(request.identity)
      connections.get(key)?.dispose()
      connections.delete(key)
      await api.closeSession(request)
    },
  }
}

class PollingReviewSessionConnection implements ReviewSessionConnection {
  readonly #listeners = new Set<(state: ReviewSessionState) => void>()
  #state: ReviewSessionState
  #timer: ReturnType<typeof setTimeout> | null = null
  #disposed = false

  constructor(
    private readonly api: ProgressiveReviewApi,
    state: ReviewSessionState,
    private readonly pollMilliseconds: number,
  ) {
    this.#state = state
  }

  readonly subscribe = (listener: (state: ReviewSessionState) => void): (() => void) => {
    if (this.#disposed) throw new Error("Progressive review connection is disposed")
    this.#listeners.add(listener)
    listener(this.#state)
    if (this.#timer === null) this.#schedule()
    return () => {
      this.#listeners.delete(listener)
      if (this.#listeners.size === 0) this.#stopTimer()
    }
  }

  readonly dispose = (): void => {
    if (this.#disposed) return
    this.#disposed = true
    this.#listeners.clear()
    this.#stopTimer()
  }

  #schedule(): void {
    if (this.#disposed || this.#listeners.size === 0) return
    this.#timer = setTimeout(() => void this.#poll(), this.pollMilliseconds)
  }

  async #poll(): Promise<void> {
    this.#timer = null
    if (this.#disposed || this.#listeners.size === 0) return
    try {
      const candidate = Schema.decodeUnknownSync(ReviewSessionStateSchema)(
        await this.api.currentSession(
          CurrentReviewSessionRequest.make({ identity: this.#state.identity }),
        ),
      )
      this.#state = candidate
      for (const listener of this.#listeners) listener(candidate)
    } finally {
      this.#schedule()
    }
  }

  #stopTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
  }
}

const sessionKey = (identity: ReviewSessionIdentity): string =>
  JSON.stringify([
    identity.projectId,
    identity.reviewKey,
    identity.snapshotId,
    identity.processId,
    identity.sessionId,
  ])
