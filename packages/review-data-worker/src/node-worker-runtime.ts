import { Worker } from "node:worker_threads"

import type {
  ReviewDataWorkerCommand,
  ReviewDataWorkerHandle,
  ReviewDataWorkerResponse,
  ReviewDataWorkerRuntime,
} from "./worker-runtime"

/** Node worker-thread adapter for disposable review data workers. */
export class NodeReviewDataWorkerRuntime implements ReviewDataWorkerRuntime {
  /** Starts an isolated module worker with no product database handle or path. */
  start(moduleUrl: URL): ReviewDataWorkerHandle {
    const worker = new Worker(moduleUrl)
    return {
      post: (command: ReviewDataWorkerCommand, transfer: ReadonlyArray<ArrayBuffer> = []): void => {
        worker.postMessage(command, transfer)
      },
      onResponse: (listener: (response: ReviewDataWorkerResponse) => void): (() => void) => {
        worker.on("message", listener)
        return () => worker.off("message", listener)
      },
      onFailure: (listener): (() => void) => {
        let terminated = false
        const onError = (cause: Error): void => listener(cause)
        const onExit = (code: number): void => {
          if (!terminated) listener(new Error(`Review data worker exited with ${code}`))
        }
        worker.on("error", onError)
        worker.on("exit", onExit)
        return () => {
          terminated = true
          worker.off("error", onError)
          worker.off("exit", onExit)
        }
      },
      terminate: async (): Promise<void> => {
        await worker.terminate()
      },
    }
  }
}
