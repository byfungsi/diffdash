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
  /** Registers a worker response listener. */
  addEventListener(
    type: "message",
    listener: (event: { readonly data: ReviewDataWorkerResponse }) => void,
  ): void
  addEventListener(type: "error", listener: (event: { readonly error: Error }) => void): void
  /** Removes a worker response listener. */
  removeEventListener(
    type: "message",
    listener: (event: { readonly data: ReviewDataWorkerResponse }) => void,
  ): void
  removeEventListener(type: "error", listener: (event: { readonly error: Error }) => void): void
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
      onResponse: (listener): (() => void) => {
        const receive = (event: { readonly data: ReviewDataWorkerResponse }): void =>
          listener(event.data)
        worker.addEventListener("message", receive)
        return () => worker.removeEventListener("message", receive)
      },
      onFailure: (listener): (() => void) => {
        const fail = (event: { readonly error: Error }): void => listener(event.error)
        worker.addEventListener("error", fail)
        return () => worker.removeEventListener("error", fail)
      },
      terminate: async (): Promise<void> => worker.terminate(),
    }
  }
}
