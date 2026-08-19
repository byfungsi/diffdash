import type {
  ReviewDataWorkerCommand,
  ReviewDataWorkerHandle,
  ReviewDataWorkerResponse,
  ReviewDataWorkerRuntime,
} from "./worker-runtime"

/** Structural subset of Bun's Web Worker needed by the review worker adapter. */
export interface BunWorkerHandle {
  /** Sends a command and transfers source-owned buffers. */
  postMessage(command: ReviewDataWorkerCommand, transfer?: ReadonlyArray<ArrayBuffer>): void
  /** Registers and removes worker response listeners. */
  onMessage(listener: (response: ReviewDataWorkerResponse) => void): () => void
  /** Registers and removes worker failure listeners. */
  onError(listener: (error: Error) => void): () => void
  /** Synchronously requests worker termination. */
  terminate(): void
}

/** Bun Web Worker adapter with construction supplied by the Bun composition root. */
export class BunReviewDataWorkerRuntime implements ReviewDataWorkerRuntime {
  readonly #startWorker: (moduleUrl: URL) => BunWorkerHandle

  /** Creates an adapter from Bun's composition-root Worker constructor. */
  constructor(startWorker: (moduleUrl: URL) => BunWorkerHandle) {
    this.#startWorker = startWorker
  }

  /** Starts a module worker without passing product database capabilities. */
  start(moduleUrl: URL): ReviewDataWorkerHandle {
    const worker = this.#startWorker(moduleUrl)
    return {
      post: (command, transfer = []): void => worker.postMessage(command, transfer),
      onResponse: (listener): (() => void) => worker.onMessage(listener),
      onFailure: (listener): (() => void) => worker.onError(listener),
      terminate: async (): Promise<void> => worker.terminate(),
    }
  }
}
