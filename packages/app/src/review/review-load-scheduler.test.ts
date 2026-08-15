import { describe, expect, it, vi } from "vitest"
import {
  type ReviewLoadLane,
  type ReviewLoadSchedulerLimits,
  ReviewLoadScheduler,
  type ReviewLoadTask,
} from "./review-load-scheduler"

const limits: ReviewLoadSchedulerLimits = {
  maxConcurrency: 1,
  lanes: {
    target: { maxQueuedBytes: 100, maxConcurrency: 1, maxReservedOutputBytes: 100 },
    viewport: { maxQueuedBytes: 100, maxConcurrency: 1, maxReservedOutputBytes: 100 },
    prefetch: { maxQueuedBytes: 100, maxConcurrency: 1, maxReservedOutputBytes: 100 },
    background: { maxQueuedBytes: 100, maxConcurrency: 1, maxReservedOutputBytes: 100 },
  },
}

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

const task = (
  id: string,
  lane: ReviewLoadLane,
  run: ReviewLoadTask["run"],
  queuedBytes = 10,
  reservedOutputBytes = 20,
): ReviewLoadTask => ({
  id,
  lane,
  kind: lane === "prefetch" ? "prefetch" : "read",
  run,
  queuedBytes,
  reservedOutputBytes,
})

describe("ReviewLoadScheduler", () => {
  it("runs target, viewport, prefetch, then background and conflates queued viewport demand", async () => {
    const blocker = deferred()
    const order: string[] = []
    const scheduler = new ReviewLoadScheduler(limits)
    scheduler.schedule(task("active", "target", async () => blocker.promise))
    scheduler.schedule(task("background", "background", async () => void order.push("background")))
    scheduler.schedule(task("prefetch", "prefetch", async () => void order.push("prefetch")))
    const staleRun = vi.fn<ReviewLoadTask["run"]>(async () => undefined)
    scheduler.schedule(task("stale", "viewport", staleRun))
    scheduler.schedule(task("latest", "viewport", async () => void order.push("viewport")))
    scheduler.schedule(task("target", "target", async () => void order.push("target")))

    blocker.resolve()
    await vi.waitFor(() => expect(order).toEqual(["target", "viewport", "prefetch", "background"]))
    expect(staleRun).not.toHaveBeenCalled()
  })

  it("enforces queued-byte, concurrency, and output-reservation pressure", () => {
    const blocker = deferred()
    const scheduler = new ReviewLoadScheduler(limits)
    expect(scheduler.schedule(task("active", "target", async () => blocker.promise, 80, 80))).toBe(
      true,
    )
    expect(
      scheduler.schedule(task("reservation-pressure", "target", async () => undefined, 10, 30)),
    ).toBe(false)
    expect(scheduler.schedule(task("queued", "background", async () => undefined, 90, 10))).toBe(
      true,
    )
    expect(
      scheduler.schedule(task("queue-pressure", "background", async () => undefined, 20, 10)),
    ).toBe(false)

    expect(scheduler.pressure("target")).toEqual({
      active: 1,
      queued: 0,
      queuedBytes: 0,
      reservedOutputBytes: 80,
      rejected: 1,
    })
    expect(scheduler.pressure("background")).toMatchObject({
      queued: 1,
      queuedBytes: 90,
      rejected: 1,
    })
    scheduler.dispose()
  })

  it("aborts stale reads, prefetch, and highlights on reversal and far navigation", async () => {
    const signals: AbortSignal[] = []
    const cancellationTask = (
      id: string,
      lane: ReviewLoadLane,
      kind: ReviewLoadTask["kind"],
    ): ReviewLoadTask => ({
      ...task(id, lane, (signal) => {
        signals.push(signal)
        return new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        )
      }),
      kind,
    })
    const scheduler = new ReviewLoadScheduler({ ...limits, maxConcurrency: 3 })
    scheduler.updateDemand(1, false)
    scheduler.schedule(cancellationTask("viewport", "viewport", "read"))
    scheduler.schedule(cancellationTask("prefetch", "prefetch", "prefetch"))
    scheduler.schedule(cancellationTask("highlight", "background", "highlight"))
    scheduler.updateDemand(-1, false)

    await vi.waitFor(() => expect(signals.every((signal) => signal.aborted)).toBe(true))
    await vi.waitFor(() => {
      expect(scheduler.pressure("viewport").reservedOutputBytes).toBe(0)
      expect(scheduler.pressure("prefetch").reservedOutputBytes).toBe(0)
      expect(scheduler.pressure("background").reservedOutputBytes).toBe(0)
    })

    const farBlocker = deferred()
    const farScheduler = new ReviewLoadScheduler(limits)
    farScheduler.schedule(task("target", "target", async () => farBlocker.promise))
    farScheduler.schedule(task("far-prefetch", "prefetch", async () => undefined))
    farScheduler.schedule({
      ...task("far-highlight", "background", async () => undefined),
      kind: "highlight",
    })
    farScheduler.updateDemand(1, true)
    expect(farScheduler.pressure("prefetch")).toMatchObject({ queued: 0, reservedOutputBytes: 0 })
    expect(farScheduler.pressure("background")).toMatchObject({ queued: 0, reservedOutputBytes: 0 })
    farScheduler.dispose()
  })
})
