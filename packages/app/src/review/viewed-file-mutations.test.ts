import { ReviewFilePatchHash } from "@diffdash/domain/review-identity"
import { describe, expect, it } from "vitest"
import {
  type ViewedFileMutation,
  createViewedFileMutationCoordinator,
} from "./viewed-file-mutations"

const ignoreRejection = (_error: unknown): void => undefined

const mutation = (
  reviewKey: string,
  viewed: boolean,
  previousViewed = !viewed,
): ViewedFileMutation => ({
  write: { reviewKey, patchHash: ReviewFilePatchHash.make(`patch-${reviewKey}`), viewed },
  previous: { viewed: previousViewed, expanded: !previousViewed },
  next: { viewed, expanded: !viewed },
})

describe("viewed-file mutation coordinator", () => {
  it("coalesces same-file bulk transitions and persists files in insertion order", async () => {
    const writes: string[] = []
    const coordinator = createViewedFileMutationCoordinator({
      write: async (write) => {
        writes.push(`${write.reviewKey}:${String(write.viewed)}`)
      },
      onOptimistic: () => undefined,
      onRollback: () => undefined,
      onError: () => undefined,
    })

    coordinator.submit(mutation("a", true, false))
    coordinator.submit(mutation("b", true, false))
    coordinator.submit(mutation("a", false, true))
    await coordinator.whenIdle()

    expect(writes).toEqual(["a:false", "b:true"])
  })

  it("rolls back both viewed and expansion state after the latest write rejects", async () => {
    const rollbacks: {
      readonly reviewKey: string
      readonly viewed: boolean
      readonly expanded: boolean
    }[] = []
    const errors: unknown[] = []
    const coordinator = createViewedFileMutationCoordinator({
      write: async () => {
        throw new Error("persistence unavailable")
      },
      onOptimistic: () => undefined,
      onRollback: (reviewKey, snapshot) => rollbacks.push({ reviewKey, ...snapshot }),
      onError: (_write, error) => errors.push(error),
    })

    coordinator.submit(mutation("src/app.ts", true, false))
    await coordinator.whenIdle()

    expect(rollbacks).toEqual([{ reviewKey: "src/app.ts", viewed: false, expanded: true }])
    expect(errors).toHaveLength(1)
  })

  it("does not let a failed older write roll back a newer pending transition", async () => {
    let rejectFirst: (error: unknown) => void = ignoreRejection
    const firstWrite = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject
    })
    let writeCount = 0
    const rollbacks: boolean[] = []
    const coordinator = createViewedFileMutationCoordinator({
      write: async () => {
        writeCount += 1
        if (writeCount === 1) return firstWrite
      },
      onOptimistic: () => undefined,
      onRollback: (_reviewKey, snapshot) => rollbacks.push(snapshot.viewed),
      onError: () => undefined,
    })

    coordinator.submit(mutation("a", true, false))
    await Promise.resolve()
    coordinator.submit(mutation("a", false, true))
    rejectFirst(new Error("older write failed"))
    await coordinator.whenIdle()

    expect(writeCount).toBe(2)
    expect(rollbacks).toEqual([])
  })
})
