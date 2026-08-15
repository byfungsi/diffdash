import { describe, expect, it } from "@effect/vitest"

import { NodeReviewDataWorkerRuntime } from "./node-worker-runtime"
import { ReviewDataWorkerClient } from "./worker-runtime"
import type {
  ReviewDataWorkerCommand,
  ReviewDataWorkerHandle,
  ReviewDataWorkerResponse,
  ReviewDataWorkerRuntime,
} from "./worker-runtime"

describe("ReviewDataWorkerClient", () => {
  it("keeps heartbeat responsive while parsing is held and terminates on cancellation", async () => {
    const runtime = new HeldChunkRuntime()
    const client = new ReviewDataWorkerClient(runtime, new URL("file:///fake-worker.mjs"))
    const parsing = client.sendChunk(new Uint8Array([1, 2, 3]))
    await expect(client.sendChunk(new Uint8Array([4]))).resolves.toMatchObject({ _tag: "Failed" })

    await expect(client.heartbeat()).resolves.toMatchObject({ _tag: "Heartbeat" })
    await client.cancel()

    await expect(parsing).resolves.toMatchObject({ _tag: "Failed" })
    expect(runtime.terminated).toBe(true)
  })

  it("resolves pending requests when the worker exits unexpectedly", async () => {
    const runtime = new FailingRuntime()
    const client = new ReviewDataWorkerClient(runtime, new URL("file:///fixture-worker.mjs"))
    const pending = client.sendChunk(new Uint8Array([1]))
    runtime.fail(new Error("worker crashed"))

    await expect(pending).resolves.toMatchObject({
      _tag: "Failed",
      message: "Review data worker failed: worker crashed",
    })
    expect(runtime.terminated).toBe(true)
  })

  it("terminates when a batch is attributed to a command that cannot emit batches", async () => {
    const runtime = new UnsolicitedBatchRuntime()
    const client = new ReviewDataWorkerClient(runtime, new URL("file:///fixture-worker.mjs"))

    await expect(client.heartbeat()).resolves.toMatchObject({
      _tag: "Failed",
      message: "Review data worker emitted an invalid batch",
    })
    expect(runtime.terminated).toBe(true)
  })

  it("starts and reclaims a real Node worker thread", async () => {
    const source = `
      const { parentPort } = await import("node:worker_threads");
      parentPort.on("message", (command) => {
        if (command._tag === "Heartbeat") parentPort.postMessage({ _tag: "Heartbeat", requestId: command.requestId });
      });
    `
    const moduleUrl = new URL(`data:text/javascript,${encodeURIComponent(source)}`)
    const client = new ReviewDataWorkerClient(new NodeReviewDataWorkerRuntime(), moduleUrl)

    await expect(client.heartbeat()).resolves.toMatchObject({ _tag: "Heartbeat" })
    await client.dispose()
    await expect(client.heartbeat()).resolves.toMatchObject({ _tag: "Failed" })
  })
})

class HeldChunkRuntime implements ReviewDataWorkerRuntime {
  terminated = false

  start(_moduleUrl: URL): ReviewDataWorkerHandle {
    const listeners = new Set<(response: ReviewDataWorkerResponse) => void>()
    return {
      post: (command: ReviewDataWorkerCommand): void => {
        if (command._tag === "Heartbeat") {
          queueMicrotask(() => {
            for (const listener of listeners)
              listener({ _tag: "Heartbeat", requestId: command.requestId })
          })
        }
      },
      onResponse: (listener): (() => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      onFailure: () => () => undefined,
      terminate: async (): Promise<void> => {
        this.terminated = true
        listeners.clear()
      },
    }
  }
}

class FailingRuntime implements ReviewDataWorkerRuntime {
  #fail: (cause: Error) => void = () => undefined
  terminated = false

  fail(cause: Error): void {
    this.#fail(cause)
  }

  start(_moduleUrl: URL): ReviewDataWorkerHandle {
    return {
      post: () => undefined,
      onResponse: () => () => undefined,
      onFailure: (listener) => {
        this.#fail = listener
        return () => {
          this.#fail = () => undefined
        }
      },
      terminate: async () => {
        this.terminated = true
      },
    }
  }
}

class UnsolicitedBatchRuntime implements ReviewDataWorkerRuntime {
  terminated = false

  start(_moduleUrl: URL): ReviewDataWorkerHandle {
    const listeners = new Set<(response: ReviewDataWorkerResponse) => void>()
    return {
      post: (command) => {
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({
              _tag: "Batch",
              requestId: command.requestId,
              batch: { events: [], byteCount: 0 },
            })
          }
        })
      },
      onResponse: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      onFailure: () => () => undefined,
      terminate: async () => {
        this.terminated = true
        listeners.clear()
      },
    }
  }
}
