/** Message subset accepted by the isolated review data worker. */
export type ReviewDataWorkerCommand =
  | { readonly _tag: "Chunk"; readonly requestId: number; readonly bytes: Uint8Array }
  | { readonly _tag: "Finish"; readonly requestId: number }
  | { readonly _tag: "Heartbeat"; readonly requestId: number }
  | { readonly _tag: "Cancel"; readonly requestId: number }

/** Bounded response subset emitted by the isolated review data worker. */
import type { IncrementalDiffBatch } from "./incremental-diff-parser"
import { isBoundedIncrementalDiffBatch } from "./incremental-diff-parser"
import { Match, Predicate, Schema } from "effect"

export type ReviewDataWorkerResponse =
  | { readonly _tag: "Accepted"; readonly requestId: number }
  | { readonly _tag: "Batch"; readonly requestId: number; readonly batch: IncrementalDiffBatch }
  | { readonly _tag: "Heartbeat"; readonly requestId: number }
  | { readonly _tag: "Finished"; readonly requestId: number }
  | { readonly _tag: "Cancelled"; readonly requestId: number }
  | { readonly _tag: "Failed"; readonly requestId: number; readonly message: string }

/** Runtime worker handle shared by Node, Bun, and deterministic test adapters. */
export interface ReviewDataWorkerHandle {
  /** Sends one bounded protocol command. */
  post(command: ReviewDataWorkerCommand, transfer?: ReadonlyArray<ArrayBuffer>): void
  /** Subscribes to validated worker responses. */
  onResponse(listener: (response: ReviewDataWorkerResponse) => void): () => void
  /** Subscribes to unexpected worker failure or exit. */
  onFailure(listener: (cause: Error) => void): () => void
  /** Terminates the disposable worker and resolves after runtime resources are reclaimed. */
  terminate(): Promise<void>
}

/** Runtime adapter that starts one worker module without granting database capabilities. */
export interface ReviewDataWorkerRuntime {
  /** Starts a fresh disposable worker for one review session. */
  start(moduleUrl: URL): ReviewDataWorkerHandle
}

/** Parses one untrusted host command before it reaches the worker parser. */
const RequestId = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))
const ReviewDataWorkerCommandSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Chunk"), requestId: RequestId, bytes: Schema.Uint8Array }),
  Schema.Struct({ _tag: Schema.Literal("Finish"), requestId: RequestId }),
  Schema.Struct({ _tag: Schema.Literal("Heartbeat"), requestId: RequestId }),
  Schema.Struct({ _tag: Schema.Literal("Cancel"), requestId: RequestId }),
])
const ReviewDataWorkerResponseEnvelope = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Accepted"), requestId: RequestId }),
  Schema.Struct({ _tag: Schema.Literal("Batch"), requestId: RequestId, batch: Schema.Json }),
  Schema.Struct({ _tag: Schema.Literal("Heartbeat"), requestId: RequestId }),
  Schema.Struct({ _tag: Schema.Literal("Finished"), requestId: RequestId }),
  Schema.Struct({ _tag: Schema.Literal("Cancelled"), requestId: RequestId }),
  Schema.Struct({
    _tag: Schema.Literal("Failed"),
    requestId: RequestId,
    message: Schema.String.pipe(Schema.check(Schema.isMaxLength(1_024))),
  }),
])

export const isReviewDataWorkerCommand = Schema.is(ReviewDataWorkerCommandSchema)
const isReviewDataWorkerResponseEnvelope = Schema.is(ReviewDataWorkerResponseEnvelope)

/** Disposable latest-session worker client with one in-flight bounded command. */
export class ReviewDataWorkerClient {
  readonly #handle: ReviewDataWorkerHandle
  readonly #pending = new Map<
    number,
    {
      readonly command: ReviewDataWorkerCommand["_tag"]
      readonly resolve: (response: ReviewDataWorkerResponse) => void
    }
  >()
  readonly #batchListeners = new Set<(batch: IncrementalDiffBatch) => Promise<void> | void>()
  readonly #unsubscribe: () => void
  readonly #unsubscribeFailure: () => void
  #requestId = 0
  #disposed = false
  #chunkPending = false
  #batchTail = Promise.resolve()

  /** Starts one disposable worker owned by this client. */
  constructor(runtime: ReviewDataWorkerRuntime, moduleUrl: URL) {
    this.#handle = runtime.start(moduleUrl)
    this.#unsubscribe = this.#handle.onResponse((response) => {
      if (!isReviewDataWorkerResponseEnvelope(response)) {
        this.#failPending("Review data worker emitted an invalid response")
        return
      }
      try {
        Match.value(response).pipe(
          Match.tag("Batch", ({ batch, requestId }) => {
            const pending = this.#pending.get(requestId)
            if (
              pending === undefined ||
              (pending.command !== "Chunk" && pending.command !== "Finish") ||
              !isBoundedIncrementalDiffBatch(batch)
            ) {
              this.#failPending("Review data worker emitted an invalid batch")
              return
            }
            this.#batchTail = this.#batchTail.then(async () => {
              await Promise.all(
                [...this.#batchListeners].map((listener) => Promise.resolve(listener(batch))),
              )
              return undefined
            })
          }),
          Match.orElse((terminal) => {
            const pending = this.#pending.get(terminal.requestId)
            if (pending === undefined) return
            this.#pending.delete(terminal.requestId)
            void this.#batchTail.then(
              () => pending.resolve(terminal),
              () =>
                pending.resolve({
                  _tag: "Failed",
                  requestId: terminal.requestId,
                  message: "Review data worker batch handling failed",
                }),
            )
          }),
        )
      } catch {
        this.#failPending("Review data worker emitted an invalid response")
      }
    })
    this.#unsubscribeFailure = this.#handle.onFailure((cause) => {
      this.#failPending(
        `Review data worker failed: ${Predicate.isError(cause) ? cause.message : "unknown worker failure"}`,
      )
    })
  }

  /** Sends one chunk and waits for acknowledgement before allowing the next chunk. */
  sendChunk(bytes: Uint8Array): Promise<ReviewDataWorkerResponse> {
    const requestId = this.#nextRequestId()
    if (this.#chunkPending) {
      return Promise.resolve({
        _tag: "Failed",
        requestId,
        message: "Review data worker already has a chunk in flight",
      })
    }
    this.#chunkPending = true
    const copy = bytes.slice()
    return this.#request({ _tag: "Chunk", requestId, bytes: copy }, [copy.buffer]).finally(() => {
      this.#chunkPending = false
    })
  }

  /** Subscribes to independently bounded parser batches. */
  onBatch(listener: (batch: IncrementalDiffBatch) => Promise<void> | void): () => void {
    this.#batchListeners.add(listener)
    return () => this.#batchListeners.delete(listener)
  }

  /** Requests a heartbeat independently of parser progress between acknowledged chunks. */
  heartbeat(): Promise<ReviewDataWorkerResponse> {
    return this.#request({ _tag: "Heartbeat", requestId: this.#nextRequestId() })
  }

  /** Finishes parsing and waits for terminal worker acknowledgement. */
  finish(): Promise<ReviewDataWorkerResponse> {
    return this.#request({ _tag: "Finish", requestId: this.#nextRequestId() })
  }

  /** Cancels work, terminates the disposable worker, and rejects future commands. */
  async cancel(): Promise<void> {
    if (this.#disposed) return
    const requestId = this.#nextRequestId()
    this.#handle.post({ _tag: "Cancel", requestId })
    await this.#dispose()
  }

  /** Terminates the worker when switching reviews or releasing the owning session. */
  async dispose(): Promise<void> {
    await this.#dispose()
  }

  #nextRequestId(): number {
    this.#requestId += 1
    return this.#requestId
  }

  #request(
    command: ReviewDataWorkerCommand,
    transfer?: ReadonlyArray<ArrayBuffer>,
  ): Promise<ReviewDataWorkerResponse> {
    if (this.#disposed)
      return Promise.resolve({
        _tag: "Failed",
        requestId: command.requestId,
        message: "Review data worker is disposed",
      })
    return new Promise((resolve) => {
      this.#pending.set(command.requestId, { command: command._tag, resolve })
      try {
        this.#handle.post(command, transfer)
      } catch (cause) {
        this.#pending.delete(command.requestId)
        resolve({
          _tag: "Failed",
          requestId: command.requestId,
          message: Predicate.isError(cause) ? cause.message : "Review data worker command failed",
        })
      }
    })
  }

  #failPending(message: string): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#unsubscribe()
    this.#unsubscribeFailure()
    for (const [requestId, pending] of this.#pending)
      pending.resolve({ _tag: "Failed", requestId, message })
    this.#pending.clear()
    this.#batchListeners.clear()
    void this.#handle.terminate()
  }

  async #dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#unsubscribe()
    this.#unsubscribeFailure()
    for (const [requestId, pending] of this.#pending)
      pending.resolve({ _tag: "Failed", requestId, message: "Review data worker was terminated" })
    this.#pending.clear()
    this.#batchListeners.clear()
    await this.#handle.terminate()
  }
}
