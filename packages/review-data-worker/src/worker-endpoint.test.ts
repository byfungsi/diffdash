import { describe, expect, it } from "@effect/vitest"

import { attachReviewDataWorker } from "./worker-endpoint"
import type { ReviewDataWorkerCommand, ReviewDataWorkerResponse } from "./worker-runtime"

describe("attachReviewDataWorker", () => {
  it("acknowledges heartbeat while a pre-authorized staging append is pending", async () => {
    let receive = (_command: ReviewDataWorkerCommand): void => {
      throw new Error("Worker endpoint did not attach")
    }
    let releaseAppend = (): void => {
      throw new Error("Staging append was not acquired")
    }
    const responses: ReviewDataWorkerResponse[] = []
    const appendPending = new Promise<void>((resolve) => {
      releaseAppend = resolve
    })
    const detach = attachReviewDataWorker(
      {
        onCommand: (listener) => {
          receive = listener
          return () => {
            receive = () => undefined
          }
        },
        respond: (response) => responses.push(response),
        close: () => undefined,
      },
      {
        append: () => appendPending,
        close: () => Promise.resolve(),
      },
    )
    receive({ _tag: "Chunk", requestId: 1, bytes: new TextEncoder().encode("preamble") })
    receive({ _tag: "Heartbeat", requestId: 2 })
    expect(responses).toEqual([{ _tag: "Heartbeat", requestId: 2 }])

    releaseAppend()
    await Promise.resolve()
    await Promise.resolve()
    expect(responses).toContainEqual({ _tag: "Accepted", requestId: 1 })
    detach()
  })
})
