/* oxlint-disable eslint/no-underscore-dangle -- Tests assert Effect-compatible _tag discriminants. */
import { ReviewFileId, ReviewProjectId, ReviewSnapshotId } from "@diffdash/domain/review-identity"
import {
  FileReviewNavigationTarget,
  ReviewLocationV1,
  ReviewNavigationBehavior,
  ReviewNavigationInput,
  type ReviewNavigationOrigin,
  ReviewSnapshotAddress,
} from "@diffdash/domain/review-navigation"
import { Registry } from "@effect-atom/atom-react"
import { transportError } from "@diffdash/protocol/transport-error"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  type MountedReviewAnchor,
  type ResolvedReviewNavigationTarget,
  ReviewNavigationSnapshotExpiredError,
  type ReviewNavigationScheduler,
  ReviewNavigatorController,
  type ReviewViewportBridge,
  reviewNavigationPresentationAtom,
} from "./review-navigation"

const projectId = ReviewProjectId.make("github:fungsi/diffdash")
const snapshotId = ReviewSnapshotId.make("snapshot:v1:1234567890abcdef1234567890abcdef")
const replacementSnapshotId = ReviewSnapshotId.make("snapshot:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
const fileId = ReviewFileId.make("file:src/app.ts")
const otherFileId = ReviewFileId.make("file:src/other.ts")
const address = ReviewSnapshotAddress.make({ projectId, snapshotId })
const behavior = ReviewNavigationBehavior.make({
  alignment: "start",
  focus: "preserve",
  selection: "update",
  visibility: "temporarily-reveal",
})

const inputFor = (
  targetFileId: ReviewFileId,
  snapshot = address,
  origin: ReviewNavigationOrigin = "file-tree",
) =>
  ReviewNavigationInput.make({
    location: ReviewLocationV1.make({
      version: 1,
      snapshot,
      target: FileReviewNavigationTarget.make({ fileId: targetFileId }),
    }),
    behavior,
    origin,
  })

const mountedAnchor: MountedReviewAnchor = {
  generation: 1,
  measure: () => ({}) as DOMRect,
  focus: () => true,
  isConnected: () => true,
}

const resolvedTarget = (target: FileReviewNavigationTarget): ResolvedReviewNavigationTarget => ({
  target,
  fileId: target.fileId,
  anchorKey: `file:${target.fileId}`,
})

const immediateBridge = (): ReviewViewportBridge => ({
  resolveTarget: async (target) => resolvedTarget(target as FileReviewNavigationTarget),
  loadTarget: async () => undefined,
  reacquireSnapshot: async (expectedSnapshotId) => expectedSnapshotId,
  prepareSurface: async () => undefined,
  waitForAnchor: async () => mountedAnchor,
  position: async () => undefined,
  activateWindow: async () => undefined,
  focus: async () => undefined,
  verify: async () => undefined,
})

const deferred = <Value>() => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

const fakeTimerScheduler = (): ReviewNavigationScheduler => ({
  now: Date.now,
  schedule: (delayMs, task) => {
    const timer = setTimeout(task, delayMs)
    return () => clearTimeout(timer)
  },
})

const registries: Registry.Registry[] = []
const controllers: ReviewNavigatorController[] = []

const makeController = (options?: ConstructorParameters<typeof ReviewNavigatorController>[1]) => {
  const registry = Registry.make()
  const controller = new ReviewNavigatorController(registry, options)
  registries.push(registry)
  controllers.push(controller)
  controller.attach({ projectId, snapshotId }, immediateBridge())
  return { controller, registry }
}

afterEach(() => {
  vi.useRealTimers()
  for (const controller of controllers.splice(0)) controller.dispose()
  for (const registry of registries.splice(0)) registry.dispose()
})

describe("ReviewNavigatorController", () => {
  it("FUN-212 AC: reports every active phase through the public subscription", async () => {
    const { controller } = makeController()
    const statuses: string[] = []
    const unsubscribe = controller.subscribeStatus((status) => {
      statuses.push(status._tag === "idle" ? "idle" : status.phase)
    })

    const outcome = await controller.navigate(inputFor(fileId))

    unsubscribe()
    expect(outcome._tag).toBe("completed")
    expect(statuses).toEqual([
      "idle",
      "validating",
      "resolving",
      "loading-resource",
      "preparing-surface",
      "awaiting-mount",
      "positioning",
      "verifying",
      "idle",
    ])
  })

  it("FUN-212 AC: supersedes old work and ignores its late completion", async () => {
    const firstResolution = deferred<ResolvedReviewNavigationTarget>()
    const bridge = immediateBridge()
    let resolutionCount = 0
    const controlledBridge: ReviewViewportBridge = {
      ...bridge,
      resolveTarget: async (target) => {
        resolutionCount += 1
        return resolutionCount === 1
          ? firstResolution.promise
          : resolvedTarget(target as FileReviewNavigationTarget)
      },
    }
    const { controller, registry } = makeController()
    controller.attach({ projectId, snapshotId }, controlledBridge)

    const first = controller.navigate(inputFor(fileId))
    const second = controller.navigate(inputFor(otherFileId))
    const firstOutcome = await first
    const secondOutcome = await second
    firstResolution.resolve(resolvedTarget(FileReviewNavigationTarget.make({ fileId })))
    await Promise.resolve()

    expect(firstOutcome._tag).toBe("superseded")
    expect(secondOutcome._tag).toBe("completed")
    expect(controller.getStatus()._tag).toBe("idle")
    expect(registry.get(reviewNavigationPresentationAtom).requestId).toBeNull()
  })

  it("rejects other-project and other-snapshot locations without executing the bridge", async () => {
    const bridge = immediateBridge()
    const resolveTarget = vi.fn<ReviewViewportBridge["resolveTarget"]>(bridge.resolveTarget)
    const { controller } = makeController()
    controller.attach({ projectId, snapshotId }, { ...bridge, resolveTarget })
    const otherProject = ReviewSnapshotAddress.make({
      projectId: ReviewProjectId.make("github:fungsi/other"),
      snapshotId,
    })
    const otherSnapshot = ReviewSnapshotAddress.make({
      projectId,
      snapshotId: ReviewSnapshotId.make("snapshot:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    })

    const projectOutcome = await controller.navigate(inputFor(fileId, otherProject))
    const snapshotOutcome = await controller.navigate(inputFor(fileId, otherSnapshot))

    expect(projectOutcome).toMatchObject({ _tag: "unavailable", reason: "projectNotActive" })
    expect(snapshotOutcome).toMatchObject({ _tag: "unavailable", reason: "snapshotNotActive" })
    expect(resolveTarget).not.toHaveBeenCalled()
  })

  it("cancels exactly once and clears every request-owned presentation lease", async () => {
    const never = deferred<ResolvedReviewNavigationTarget>()
    const { controller, registry } = makeController()
    controller.attach(
      { projectId, snapshotId },
      { ...immediateBridge(), resolveTarget: async () => never.promise },
    )
    const navigation = controller.navigate(inputFor(fileId))

    expect(registry.get(reviewNavigationPresentationAtom)).toMatchObject({
      selectedFileId: fileId,
      pinnedFileIds: [fileId],
    })
    controller.cancelForUser()
    controller.cancelForUser()
    const outcome = await navigation

    expect(outcome).toMatchObject({ _tag: "cancelled", reason: "user" })
    expect(registry.get(reviewNavigationPresentationAtom)).toMatchObject({
      requestId: null,
      selectedFileId: null,
      forceVisibleFileIds: [],
      forceExpandedFileIds: [],
      pinnedFileIds: [],
    })
  })

  it("cancels an active request only when its origin is allowed", async () => {
    const never = deferred<ResolvedReviewNavigationTarget>()
    const { controller } = makeController()
    controller.attach(
      { projectId, snapshotId },
      { ...immediateBridge(), resolveTarget: async () => never.promise },
    )

    const unrelated = controller.navigate(inputFor(fileId))
    expect(controller.cancelActiveForOrigins(["search-preview", "search-activation"])).toBe(false)
    expect(controller.getStatus()).toMatchObject({ _tag: "active", origin: "file-tree" })
    controller.cancelActive()
    await unrelated

    const search = controller.navigate(inputFor(fileId, address, "search-preview"))
    expect(controller.cancelActiveForOrigins(["search-preview", "search-activation"])).toBe(true)
    await expect(search).resolves.toMatchObject({ _tag: "cancelled", reason: "caller" })
  })

  it("cancels snapshot replacement as a review change and rejects stale completion", async () => {
    const staleResolution = deferred<ResolvedReviewNavigationTarget>()
    const { controller, registry } = makeController()
    controller.attach(
      { projectId, snapshotId },
      { ...immediateBridge(), resolveTarget: async () => staleResolution.promise },
    )
    const staleNavigation = controller.navigate(inputFor(fileId))

    controller.attach({ projectId, snapshotId: replacementSnapshotId }, immediateBridge())
    const staleOutcome = await staleNavigation
    staleResolution.resolve(resolvedTarget(FileReviewNavigationTarget.make({ fileId })))
    await Promise.resolve()

    expect(staleOutcome).toMatchObject({ _tag: "cancelled", reason: "review-changed" })
    expect(controller.getStatus()._tag).toBe("idle")
    expect(registry.get(reviewNavigationPresentationAtom).requestId).toBeNull()
    await expect(controller.navigate(inputFor(fileId))).resolves.toMatchObject({
      _tag: "unavailable",
      reason: "snapshotNotActive",
    })
    await expect(
      controller.navigate(
        inputFor(
          fileId,
          ReviewSnapshotAddress.make({ projectId, snapshotId: replacementSnapshotId }),
        ),
      ),
    ).resolves.toMatchObject({ _tag: "completed" })
  })

  it("uses a real wall-clock deadline and unlocks terminally", async () => {
    vi.useFakeTimers()
    const never = deferred<ResolvedReviewNavigationTarget>()
    const { controller } = makeController({
      budgets: { requestMs: 500 },
      scheduler: fakeTimerScheduler(),
    })
    controller.attach(
      { projectId, snapshotId },
      { ...immediateBridge(), resolveTarget: async () => never.promise },
    )
    const navigation = controller.navigate(inputFor(fileId))

    await vi.advanceTimersByTimeAsync(500)
    const outcome = await navigation

    expect(outcome).toMatchObject({ _tag: "failed", reason: "deadlineExceeded" })
    expect(controller.getStatus()._tag).toBe("idle")
  })

  it("retries only typed transient IPC failures on the injected schedule", async () => {
    vi.useFakeTimers()
    const bridge = immediateBridge()
    const resolveTarget = vi
      .fn<ReviewViewportBridge["resolveTarget"]>()
      .mockRejectedValueOnce(transportError("IPC_FAILURE", "First transient failure"))
      .mockRejectedValueOnce(transportError("IPC_FAILURE", "Second transient failure"))
      .mockImplementation(bridge.resolveTarget)
    const { controller } = makeController({ scheduler: fakeTimerScheduler() })
    controller.attach({ projectId, snapshotId }, { ...bridge, resolveTarget })

    const navigation = controller.navigate(inputFor(fileId))
    await vi.advanceTimersByTimeAsync(100)
    expect(resolveTarget).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(300)

    await expect(navigation).resolves.toMatchObject({ _tag: "completed" })
    expect(resolveTarget).toHaveBeenCalledTimes(3)
  })

  it("bounds mount waiting by its phase budget", async () => {
    vi.useFakeTimers()
    const never = deferred<MountedReviewAnchor>()
    const bridge = immediateBridge()
    const { controller } = makeController({
      budgets: { requestMs: 5_000, awaitingMountMs: 250 },
      scheduler: fakeTimerScheduler(),
    })
    controller.attach(
      { projectId, snapshotId },
      { ...bridge, waitForAnchor: async () => never.promise },
    )

    const navigation = controller.navigate(inputFor(fileId))
    await vi.advanceTimersByTimeAsync(250)

    await expect(navigation).resolves.toMatchObject({
      _tag: "failed",
      phase: "awaiting-mount",
      reason: "positioningFailed",
    })
  })

  it("reacquires an expired snapshot exactly once and retries only the exact ID", async () => {
    const bridge = immediateBridge()
    const loadTarget = vi
      .fn<ReviewViewportBridge["loadTarget"]>()
      .mockRejectedValueOnce(new ReviewNavigationSnapshotExpiredError())
      .mockImplementation(bridge.loadTarget)
    const reacquireSnapshot = vi.fn<ReviewViewportBridge["reacquireSnapshot"]>(
      async () => snapshotId,
    )
    const { controller } = makeController()
    controller.attach({ projectId, snapshotId }, { ...bridge, loadTarget, reacquireSnapshot })

    await expect(controller.navigate(inputFor(fileId))).resolves.toMatchObject({
      _tag: "completed",
    })
    expect(reacquireSnapshot).toHaveBeenCalledOnce()
    expect(loadTarget).toHaveBeenCalledTimes(2)
  })

  it("rejects a changed snapshot after reacquisition without retrying the target", async () => {
    const bridge = immediateBridge()
    const loadTarget = vi
      .fn<ReviewViewportBridge["loadTarget"]>()
      .mockRejectedValue(new ReviewNavigationSnapshotExpiredError())
    const { controller } = makeController()
    controller.attach(
      { projectId, snapshotId },
      {
        ...bridge,
        loadTarget,
        reacquireSnapshot: async () => replacementSnapshotId,
      },
    )

    await expect(controller.navigate(inputFor(fileId))).resolves.toMatchObject({
      _tag: "unavailable",
      reason: "snapshotChanged",
    })
    expect(loadTarget).toHaveBeenCalledOnce()
  })

  it("bounds snapshot reacquisition independently", async () => {
    vi.useFakeTimers()
    const bridge = immediateBridge()
    const never = deferred<ReviewSnapshotId>()
    const { controller } = makeController({
      budgets: { requestMs: 5_000, snapshotReacquisitionMs: 200 },
      scheduler: fakeTimerScheduler(),
    })
    controller.attach(
      { projectId, snapshotId },
      {
        ...bridge,
        loadTarget: async () => {
          throw new ReviewNavigationSnapshotExpiredError()
        },
        reacquireSnapshot: async () => never.promise,
      },
    )

    const navigation = controller.navigate(inputFor(fileId))
    await vi.advanceTimersByTimeAsync(200)

    await expect(navigation).resolves.toMatchObject({
      _tag: "failed",
      phase: "loading-resource",
      reason: "snapshotLoadFailed",
    })
  })
})
