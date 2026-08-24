import type { ReviewThreadTarget } from "@diffdash/domain/review-thread"
import { StoredWalkthrough } from "@diffdash/domain/walkthrough"
import type { WalkthroughOperationId } from "@diffdash/domain/walkthrough-operation"
import type { DiffDashBridgeApi } from "@diffdash/protocol/api"
import { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import {
  WalkthroughBridgeIdempotencyKey,
  WalkthroughBridgeStartRequest,
  type WalkthroughStartBridgeFailure,
} from "@diffdash/protocol/walkthrough-operation"
import {
  WalkthroughBridgeGetStoredRequest,
  WalkthroughBridgeOperationRequest,
  type WalkthroughBridgeOperationSnapshot,
  WalkthroughCancelBridgeFailure,
  type WalkthroughGetOperationBridgeFailure,
  WalkthroughGetStoredBridgeFailure,
} from "@diffdash/protocol/walkthrough-operation-state"
import { Context, Effect, Layer, Match } from "effect"

import { PreloadClient } from "./preload-client"
import {
  invokePreload,
  rendererApiError,
  subscribePreloadEvent,
  type RendererApiError,
} from "./renderer-api-error"
import { runRendererPromise } from "./renderer-effect"

const FALLBACK_QUERY_MILLISECONDS = 1_000

type WalkthroughOperationsPreloadApi = DiffDashBridgeApi["walkthroughOperations"]

/** Public failures returned by authoritative walkthrough operation calls. */
export type WalkthroughOperationFailure =
  | WalkthroughStartBridgeFailure
  | WalkthroughGetOperationBridgeFailure
  | typeof WalkthroughCancelBridgeFailure.Type
  | typeof WalkthroughGetStoredBridgeFailure.Type
  | Exclude<
      WalkthroughBridgeOperationSnapshot,
      { readonly state: "active" } | { readonly state: "completed" }
    >

/** Renderer state for one source-neutral walkthrough target. */
export type WalkthroughOperationState =
  | { readonly status: "idle" }
  | {
      readonly status: "accepted"
      readonly operationId: WalkthroughOperationId
      readonly stateVersion: number
    }
  | { readonly status: "active"; readonly operation: WalkthroughBridgeOperationSnapshot }
  | { readonly status: "terminal"; readonly operation: WalkthroughBridgeOperationSnapshot }

/** One target-scoped durable walkthrough operation session. */
export interface WalkthroughOperationSession {
  readonly state: () => WalkthroughOperationState
  readonly subscribe: (listener: () => void) => () => void
  readonly getStored: () => Promise<StoredWalkthrough | null>
  readonly start: (regenerate: boolean) => Promise<StoredWalkthrough>
  readonly cancel: () => Promise<void>
  readonly dispose: () => void
}

/** Renderer capability for opening source-neutral walkthrough operation sessions. */
export class WalkthroughOperations extends Context.Service<
  WalkthroughOperations,
  { readonly open: (target: ReviewThreadTarget) => WalkthroughOperationSession }
>()("@diffdash/app/WalkthroughOperations") {}

/** Builds the renderer walkthrough operation capability against one preload client. */
export const makeWalkthroughOperations = (
  api: WalkthroughOperationsPreloadApi,
  fallbackQueryMilliseconds = FALLBACK_QUERY_MILLISECONDS,
): WalkthroughOperations["Service"] => ({
  open: (target) => new PreloadWalkthroughOperationSession(api, target, fallbackQueryMilliseconds),
})

class PreloadWalkthroughOperationSession implements WalkthroughOperationSession {
  readonly #listeners = new Set<() => void>()
  readonly #idempotencyKeys = new Map<boolean, WalkthroughBridgeIdempotencyKey>()
  #state: WalkthroughOperationState = { status: "idle" }
  #operationPromise: Promise<StoredWalkthrough> | null = null
  #resolveOperation: ((stored: StoredWalkthrough) => void) | null = null
  #rejectOperation: ((failure: WalkthroughOperationFailure | RendererApiError) => void) | null =
    null
  #fallbackTimer: ReturnType<typeof setTimeout> | null = null
  #unsubscribeHint: (() => void) | null = null
  #querySequence = 0
  #latestAppliedQuery = 0
  #queryInFlight = false
  #disposed = false

  constructor(
    private readonly api: WalkthroughOperationsPreloadApi,
    private readonly target: ReviewThreadTarget,
    private readonly fallbackQueryMilliseconds: number,
  ) {}

  readonly state = (): WalkthroughOperationState => this.#state

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  readonly getStored = async (): Promise<StoredWalkthrough | null> => {
    const result = await runRendererPromise(
      invokePreload(InvokeChannel.getStoredWalkthrough, () =>
        this.api.getStored(WalkthroughBridgeGetStoredRequest.make({ target: this.target })),
      ),
    )
    return Match.valueTags(result, {
      Failure: (failure) => Promise.reject(failure.error),
      Success: (success) =>
        success.value.status === "found"
          ? storedWalkthrough(this.target, success.value.stored)
          : null,
    })
  }

  readonly start = (regenerate: boolean): Promise<StoredWalkthrough> => {
    if (this.#operationPromise !== null) return this.#operationPromise

    this.#operationPromise = new Promise<StoredWalkthrough>((resolve, reject) => {
      this.#resolveOperation = resolve
      this.#rejectOperation = reject
    })
    void this.#accept(regenerate)
    return this.#operationPromise
  }

  readonly cancel = async (): Promise<void> => {
    const operationId = operationIdFromState(this.#state)
    if (operationId === null) return
    const result = await runRendererPromise(
      invokePreload(InvokeChannel.cancelWalkthroughOperation, () =>
        this.api.cancel(WalkthroughBridgeOperationRequest.make({ operationId })),
      ),
    )
    await Match.valueTags(result, {
      Failure: (failure) => Promise.reject(failure.error),
      Success: (success) => {
        this.#applySnapshot(success.value.operation, ++this.#querySequence)
        return Promise.resolve()
      },
    })
  }

  readonly dispose = (): void => {
    if (this.#disposed) return
    this.#disposed = true
    this.#stopFallback()
    this.#unsubscribeHint?.()
    this.#unsubscribeHint = null
    this.#listeners.clear()
  }

  async #accept(regenerate: boolean): Promise<void> {
    try {
      const idempotencyKey =
        this.#idempotencyKeys.get(regenerate) ??
        WalkthroughBridgeIdempotencyKey.make(`w:${crypto.randomUUID().replaceAll("-", "")}`)
      this.#idempotencyKeys.set(regenerate, idempotencyKey)
      const result = await runRendererPromise(
        invokePreload(InvokeChannel.startWalkthroughOperation, () =>
          this.api.start(
            WalkthroughBridgeStartRequest.make({
              target: this.target,
              regenerate,
              idempotencyKey,
            }),
          ),
        ),
      )
      Match.valueTags(result, {
        Failure: (failure) => this.#fail(failure.error),
        Success: (success) => {
          this.#idempotencyKeys.delete(regenerate)
          this.#state = {
            status: "accepted",
            operationId: success.value.operationId,
            stateVersion: success.value.stateVersion,
          }
          this.#emit()
          this.#subscribeToHints(success.value.operationId)
          this.#scheduleFallback(0)
        },
      })
    } catch (failure) {
      // A rejected transport call may have crossed the durable acceptance boundary.
      // Retain the key so an explicit retry deduplicates against the same intent.
      this.#rejectOperation?.(rendererApiError(InvokeChannel.startWalkthroughOperation, failure))
      this.#finish()
    }
  }

  #subscribeToHints(operationId: WalkthroughOperationId): void {
    this.#unsubscribeHint?.()
    this.#unsubscribeHint = subscribePreloadEvent(
      EventChannel.walkthroughOperationHint,
      this.api.onHint,
      (hint) => {
        if (hint.operationId === operationId && !this.#disposed) void this.#reconcile()
      },
    )
  }

  #scheduleFallback(delay = this.fallbackQueryMilliseconds): void {
    this.#stopFallback()
    if (this.#disposed || this.#state.status === "terminal") return
    this.#fallbackTimer = setTimeout(() => {
      this.#fallbackTimer = null
      void this.#reconcile()
    }, delay)
  }

  async #reconcile(): Promise<void> {
    const operationId = operationIdFromState(this.#state)
    if (operationId === null || this.#queryInFlight || this.#disposed) return
    this.#queryInFlight = true
    const querySequence = ++this.#querySequence
    try {
      const result = await runRendererPromise(
        invokePreload(InvokeChannel.getWalkthroughOperation, () =>
          this.api.getOperation(WalkthroughBridgeOperationRequest.make({ operationId })),
        ),
      )
      Match.valueTags(result, {
        Failure: (failure) => {
          if (failure.error.retryClass !== "automatic") this.#fail(failure.error)
        },
        Success: (success) => this.#applySnapshot(success.value.operation, querySequence),
      })
    } catch {
      // Transport loss is transient here: the bounded fallback query remains authoritative.
    } finally {
      this.#queryInFlight = false
      this.#scheduleFallback()
    }
  }

  #applySnapshot(operation: WalkthroughBridgeOperationSnapshot, querySequence: number): void {
    const current = snapshotFromState(this.#state)
    if (
      querySequence < this.#latestAppliedQuery ||
      (current !== null && operation.stateVersion < current.stateVersion)
    ) {
      return
    }
    this.#latestAppliedQuery = querySequence
    this.#state =
      operation.state === "active"
        ? { status: "active", operation }
        : { status: "terminal", operation }
    this.#emit()

    if (operation.state === "completed") {
      this.#resolveOperation?.(storedWalkthrough(this.target, operation.stored))
      this.#finish()
    } else if (operation.state !== "active") {
      this.#fail(operation)
    }
  }

  #fail(failure: WalkthroughOperationFailure): void {
    this.#rejectOperation?.(failure)
    this.#finish()
  }

  #finish(): void {
    this.#stopFallback()
    this.#unsubscribeHint?.()
    this.#unsubscribeHint = null
    this.#operationPromise = null
    this.#resolveOperation = null
    this.#rejectOperation = null
  }

  #stopFallback(): void {
    if (this.#fallbackTimer !== null) clearTimeout(this.#fallbackTimer)
    this.#fallbackTimer = null
  }

  #emit(): void {
    for (const listener of this.#listeners) listener()
  }
}

const operationIdFromState = (state: WalkthroughOperationState): WalkthroughOperationId | null => {
  if (state.status === "idle") return null
  if (state.status === "accepted") return state.operationId
  return state.operation.operationId
}

const snapshotFromState = (
  state: WalkthroughOperationState,
): WalkthroughBridgeOperationSnapshot | null =>
  state.status === "active" || state.status === "terminal" ? state.operation : null

const storedWalkthrough = (
  target: ReviewThreadTarget,
  stored: Extract<WalkthroughBridgeOperationSnapshot, { readonly state: "completed" }>["stored"],
): StoredWalkthrough =>
  StoredWalkthrough.make({
    repoId: stored.reviewGeneration.projectId,
    prNumber: target.kind === "hosted" ? target.review.number : null,
    reviewKey: stored.reviewGeneration.reviewKey,
    baseSha: stored.reviewGeneration.baseRevision,
    headSha: stored.reviewGeneration.headRevision,
    promptVersion: stored.promptVersion,
    walkthrough: stored.walkthrough,
    createdAt: stored.createdAt,
  })

/** Production walkthrough operation capability. */
export const walkthroughOperationsLayer = Layer.effect(
  WalkthroughOperations,
  Effect.gen(function* () {
    const api = yield* PreloadClient
    return WalkthroughOperations.of(makeWalkthroughOperations(api.walkthroughOperations))
  }),
)
