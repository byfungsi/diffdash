/** Strict scheduler priority from direct navigation through idle work. */
export type ReviewLoadLane = "target" | "viewport" | "prefetch" | "background"

/** Work types used to cancel stale reads and highlights together. */
export type ReviewLoadKind = "read" | "highlight" | "prefetch"

/** Hard pressure bounds for one scheduling lane. */
export interface ReviewLoadLaneLimits {
  readonly maxQueuedBytes: number
  readonly maxConcurrency: number
  readonly maxReservedOutputBytes: number
}

/** Global and lane-local scheduler limits. */
export interface ReviewLoadSchedulerLimits {
  readonly maxConcurrency: number
  readonly lanes: Readonly<Record<ReviewLoadLane, ReviewLoadLaneLimits>>
}

/** One cancellable unit admitted under input and output byte reservations. */
export interface ReviewLoadTask {
  readonly id: string
  readonly lane: ReviewLoadLane
  readonly kind: ReviewLoadKind
  readonly queuedBytes: number
  readonly reservedOutputBytes: number
  readonly run: (signal: AbortSignal) => Promise<void>
}

/** Observable pressure without exposing queue implementation objects. */
export interface ReviewLoadPressure {
  readonly active: number
  readonly queued: number
  readonly queuedBytes: number
  readonly reservedOutputBytes: number
  readonly rejected: number
}

interface ScheduledTask extends ReviewLoadTask {
  readonly controller: AbortController
  reservationHeld: boolean
}

const LANES: readonly ReviewLoadLane[] = ["target", "viewport", "prefetch", "background"]

const MEBIBYTE = 1_024 * 1_024

/** D-12 scheduler ceilings; every lane separately bounds input, concurrency, and output. */
export const D12_REVIEW_LOAD_LIMITS: ReviewLoadSchedulerLimits = {
  maxConcurrency: 6,
  lanes: {
    target: {
      maxQueuedBytes: 2 * MEBIBYTE,
      maxConcurrency: 2,
      maxReservedOutputBytes: 16 * MEBIBYTE,
    },
    viewport: {
      maxQueuedBytes: 4 * MEBIBYTE,
      maxConcurrency: 4,
      maxReservedOutputBytes: 24 * MEBIBYTE,
    },
    prefetch: {
      maxQueuedBytes: 8 * MEBIBYTE,
      maxConcurrency: 2,
      maxReservedOutputBytes: 16 * MEBIBYTE,
    },
    background: {
      maxQueuedBytes: 2 * MEBIBYTE,
      maxConcurrency: 1,
      maxReservedOutputBytes: 8 * MEBIBYTE,
    },
  },
}

/** Latest-wins, priority-ordered scheduler with hard queue, concurrency, and reservation pressure. */
export class ReviewLoadScheduler {
  readonly #queues: Record<ReviewLoadLane, ScheduledTask[]> = {
    target: [],
    viewport: [],
    prefetch: [],
    background: [],
  }
  readonly #active = new Set<ScheduledTask>()
  readonly #queuedBytes: Record<ReviewLoadLane, number> = {
    target: 0,
    viewport: 0,
    prefetch: 0,
    background: 0,
  }
  readonly #reservedBytes: Record<ReviewLoadLane, number> = {
    target: 0,
    viewport: 0,
    prefetch: 0,
    background: 0,
  }
  readonly #rejected: Record<ReviewLoadLane, number> = {
    target: 0,
    viewport: 0,
    prefetch: 0,
    background: 0,
  }
  #direction: -1 | 0 | 1 = 0

  constructor(private readonly limits: ReviewLoadSchedulerLimits) {
    validateLimits(limits)
  }

  /** Admits work only when both queued input and reserved output fit. */
  schedule(task: ReviewLoadTask): boolean {
    validateTask(task)
    if (task.lane === "viewport") this.cancelLane("viewport")
    const limits = this.limits.lanes[task.lane]
    if (
      this.#queuedBytes[task.lane] + task.queuedBytes > limits.maxQueuedBytes ||
      this.#reservedBytes[task.lane] + task.reservedOutputBytes > limits.maxReservedOutputBytes
    ) {
      this.#rejected[task.lane] += 1
      return false
    }

    const scheduled: ScheduledTask = {
      ...task,
      controller: new AbortController(),
      reservationHeld: true,
    }
    this.#queues[task.lane].push(scheduled)
    this.#queuedBytes[task.lane] += task.queuedBytes
    this.#reservedBytes[task.lane] += task.reservedOutputBytes
    this.pump()
    return true
  }

  /** Conflates viewport demand and cancels speculative work on reversal or far seek. */
  updateDemand(direction: -1 | 0 | 1, farSeek: boolean): void {
    const reversed = direction !== 0 && this.#direction !== 0 && direction !== this.#direction
    this.cancelLane("viewport")
    if (reversed || farSeek) {
      this.cancelLane("prefetch")
      this.cancelWhere((task) => task.kind === "highlight" && task.lane !== "target")
    }
    this.#direction = direction
  }

  /** Cancels all work in a lane and releases queued reservations immediately. */
  cancelLane(lane: ReviewLoadLane): void {
    this.cancelWhere((task) => task.lane === lane)
  }

  /** Cancels all queued and active operations. */
  dispose(): void {
    this.cancelWhere(() => true)
  }

  /** Returns deterministic pressure counters for diagnostics and tests. */
  pressure(lane: ReviewLoadLane): ReviewLoadPressure {
    return {
      active: this.activeInLane(lane),
      queued: this.#queues[lane].length,
      queuedBytes: this.#queuedBytes[lane],
      reservedOutputBytes: this.#reservedBytes[lane],
      rejected: this.#rejected[lane],
    }
  }

  private cancelWhere(predicate: (task: ScheduledTask) => boolean): void {
    for (const lane of LANES) {
      const retained: ScheduledTask[] = []
      for (const task of this.#queues[lane]) {
        if (predicate(task)) {
          task.controller.abort()
          this.#queuedBytes[lane] -= task.queuedBytes
          this.releaseReservation(task)
        } else {
          retained.push(task)
        }
      }
      this.#queues[lane] = retained
    }
    for (const task of this.#active) {
      if (!predicate(task)) continue
      task.controller.abort()
      this.releaseReservation(task)
    }
  }

  private pump(): void {
    while (this.#active.size < this.limits.maxConcurrency) {
      const lane = LANES.find(
        (candidate) =>
          this.#queues[candidate].length > 0 &&
          this.activeInLane(candidate) < this.limits.lanes[candidate].maxConcurrency,
      )
      if (lane === undefined) return
      const task = this.#queues[lane].shift()
      if (task === undefined) return
      this.#queuedBytes[lane] -= task.queuedBytes
      this.#active.add(task)
      void task.run(task.controller.signal).then(
        () => this.finish(task),
        () => this.finish(task),
      )
    }
  }

  private finish(task: ScheduledTask): void {
    if (!this.#active.delete(task)) return
    this.releaseReservation(task)
    this.pump()
  }

  private releaseReservation(task: ScheduledTask): void {
    if (!task.reservationHeld) return
    task.reservationHeld = false
    this.#reservedBytes[task.lane] -= task.reservedOutputBytes
  }

  private activeInLane(lane: ReviewLoadLane): number {
    let count = 0
    for (const task of this.#active) if (task.lane === lane) count += 1
    return count
  }
}

const validateLimits = (limits: ReviewLoadSchedulerLimits) => {
  if (!Number.isSafeInteger(limits.maxConcurrency) || limits.maxConcurrency <= 0) {
    throw new RangeError("Global concurrency must be a positive safe integer")
  }
  for (const lane of LANES) {
    const value = limits.lanes[lane]
    if (
      !Number.isSafeInteger(value.maxQueuedBytes) ||
      value.maxQueuedBytes < 0 ||
      !Number.isSafeInteger(value.maxConcurrency) ||
      value.maxConcurrency <= 0 ||
      !Number.isSafeInteger(value.maxReservedOutputBytes) ||
      value.maxReservedOutputBytes < 0
    ) {
      throw new RangeError(`Invalid ${lane} scheduler limits`)
    }
  }
}

const validateTask = (task: ReviewLoadTask) => {
  if (
    !Number.isSafeInteger(task.queuedBytes) ||
    task.queuedBytes < 0 ||
    !Number.isSafeInteger(task.reservedOutputBytes) ||
    task.reservedOutputBytes < 0
  ) {
    throw new RangeError("Task byte pressure must use non-negative safe integers")
  }
}
