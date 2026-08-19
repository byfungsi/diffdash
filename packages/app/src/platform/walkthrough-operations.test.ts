import { makeHostedReviewLocator } from "@diffdash/domain/git-provider"
import { HostedReviewTarget } from "@diffdash/domain/review-thread"
import type { DiffDashBridgeApi } from "@diffdash/protocol/api"
import { WalkthroughBridgeOperationAccepted } from "@diffdash/protocol/walkthrough-operation"
import {
  WalkthroughCancelBridgeResult,
  WalkthroughGetOperationBridgeResult,
  WalkthroughBridgeOperationSnapshot,
  WalkthroughOperationBridgeHint,
} from "@diffdash/protocol/walkthrough-operation-state"
import { Schema } from "effect"
import { describe, expect, it, vi } from "vitest"

import { makeWalkthroughOperations } from "./walkthrough-operations"

const target = HostedReviewTarget.make({
  kind: "hosted",
  review: makeHostedReviewLocator("github", "fungsi", "diffdash", 51),
})

const operation = (stateVersion: number, state: "active" | "completed" | "cancelled") =>
  Schema.decodeUnknownSync(WalkthroughBridgeOperationSnapshot)({
    acceptedRequest: {
      applicationInstanceId: "app-accepted",
      processEpoch: "epoch-accepted",
      requestId: "h:accepted-request",
    },
    operationId: "operation-renderer",
    stateVersion,
    idempotencyKey: "w:renderer-operation",
    reviewGeneration: {
      kind: "hosted",
      projectId: "project-renderer",
      snapshotId: "snapshot:v1:00000000000000000000000000000000",
      reviewKey: "hosted-review:github:fungsi/diffdash#51",
      baseRevision: "base-renderer",
      headRevision: "head-renderer",
    },
    promptVersion: "walkthrough-v4",
    configuredRoute: { mode: "auto", quality: "balanced" },
    candidatePlanFingerprint: `walkthrough-plan:v1:${"0".repeat(64)}`,
    attempts: [],
    acceptedAt: "2026-08-15T10:00:00.000Z",
    updatedAt: "2026-08-15T10:00:01.000Z",
    ...(state === "active"
      ? { state, phase: "running" }
      : state === "cancelled"
        ? { state, terminalAt: "2026-08-15T10:00:02.000Z" }
        : {
            state,
            terminalAt: "2026-08-15T10:00:02.000Z",
            stored: {
              reviewGeneration: {
                kind: "hosted",
                projectId: "project-renderer",
                snapshotId: "snapshot:v1:00000000000000000000000000000000",
                reviewKey: "hosted-review:github:fungsi/diffdash#51",
                baseRevision: "base-renderer",
                headRevision: "head-renderer",
              },
              promptVersion: "walkthrough-v4",
              walkthrough: {
                title: "Review path",
                summary: "Follow the changed behavior.",
                chapters: [
                  {
                    id: "chapter-1",
                    title: "Core flow",
                    summary: "Inspect the core flow.",
                    stops: [
                      {
                        id: "stop-1",
                        title: "Entry point",
                        summary: "Review the entry point.",
                        risk: "review",
                        hunkIds: ["src/app.ts:hosted-review:github:fungsi/diffdash#51:h1"],
                      },
                    ],
                  },
                ],
                support: [],
              },
              createdAt: "2026-08-15T10:00:02.000Z",
            },
          }),
  })

const accepted = Schema.decodeUnknownSync(
  Schema.Union([Schema.TaggedStruct("Success", { value: WalkthroughBridgeOperationAccepted })]),
)({
  _tag: "Success" as const,
  value: {
    applicationInstanceId: "app-renderer",
    processEpoch: "epoch-renderer",
    requestId: "h:renderer-request",
    operationId: "operation-renderer",
    stateVersion: 1,
    created: true,
  },
})

const query = (snapshot: ReturnType<typeof operation>, processEpoch = "epoch-renderer") =>
  Schema.decodeUnknownSync(WalkthroughGetOperationBridgeResult)({
    _tag: "Success" as const,
    value: {
      applicationInstanceId: "app-renderer",
      processEpoch,
      requestId: "h:renderer-query",
      operationId: "operation-renderer",
      operation: snapshot,
    },
  })

const bridgeSuccess = <Value>(value: Value) => Promise.resolve({ _tag: "Success" as const, value })

const makeApi = () => {
  type HintListener = Parameters<DiffDashBridgeApi["walkthroughOperations"]["onHint"]>[0]
  const hintListeners = new Set<HintListener>()
  const start = vi.fn<DiffDashBridgeApi["walkthroughOperations"]["start"]>(() =>
    bridgeSuccess(accepted),
  )
  const getOperation = vi.fn<DiffDashBridgeApi["walkthroughOperations"]["getOperation"]>(() =>
    bridgeSuccess(query(operation(3, "completed"))),
  )
  const cancel = vi.fn<DiffDashBridgeApi["walkthroughOperations"]["cancel"]>(() =>
    bridgeSuccess(
      Schema.decodeUnknownSync(WalkthroughCancelBridgeResult)({
        _tag: "Success" as const,
        value: {
          applicationInstanceId: "app-renderer",
          processEpoch: "epoch-renderer",
          requestId: "h:renderer-cancel",
          operationId: "operation-renderer",
          status: "cancelled" as const,
          operation: operation(3, "cancelled"),
        },
      }),
    ),
  )
  const getStored = vi.fn<DiffDashBridgeApi["walkthroughOperations"]["getStored"]>(() =>
    bridgeSuccess({ _tag: "Success" as const, value: { status: "notFound" as const } }),
  )
  const api = {
    start,
    getOperation,
    cancel,
    getStored,
    onHint: (listener: HintListener) => {
      hintListeners.add(listener)
      return () => hintListeners.delete(listener)
    },
  } satisfies DiffDashBridgeApi["walkthroughOperations"]
  return { api, cancel, getOperation, getStored, hintListeners, start }
}

describe("walkthrough operations", () => {
  it("retains its idempotency key when acceptance transport is retried", async () => {
    const fixture = makeApi()
    fixture.start.mockRejectedValueOnce(new Error("response dropped"))
    const session = makeWalkthroughOperations(fixture.api, 1).open(target)

    const first = session.start(false)
    await vi.waitFor(() => expect(fixture.start).toHaveBeenCalledOnce())
    await expect(first).rejects.toMatchObject({ code: "RENDERER_API_FAILURE" })
    const stored = await session.start(false)

    expect(fixture.start).toHaveBeenCalledTimes(2)
    expect(fixture.start.mock.calls[0]?.[0].idempotencyKey).toBe(
      fixture.start.mock.calls[1]?.[0].idempotencyKey,
    )
    expect(stored.prNumber).toBe(51)
    session.dispose()
  })

  it("converges through a bounded query when every hint is dropped", async () => {
    const fixture = makeApi()
    const session = makeWalkthroughOperations(fixture.api, 1).open(target)

    const pending = session.start(false)
    await vi.waitFor(() => expect(fixture.getOperation).toHaveBeenCalled())
    await vi.waitFor(() =>
      expect(session.state()).toMatchObject({
        status: "terminal",
        operation: { state: "completed" },
      }),
    )
    await expect(pending).resolves.toMatchObject({ headSha: "head-renderer" })
    session.dispose()
  })

  it("loads the exact stored generation through a one-shot query", async () => {
    const fixture = makeApi()
    const completed = operation(3, "completed")
    if (completed.state !== "completed") throw new Error("Expected completed operation fixture")
    fixture.getStored.mockImplementationOnce(() =>
      bridgeSuccess({
        _tag: "Success",
        value: { status: "found", stored: completed.stored },
      }),
    )
    const session = makeWalkthroughOperations(fixture.api, 1).open(target)

    await expect(session.getStored()).resolves.toMatchObject({
      prNumber: 51,
      headSha: "head-renderer",
    })
    expect(fixture.getOperation).not.toHaveBeenCalled()
    session.dispose()
  })

  it("uses hints only to trigger an authoritative query", async () => {
    const fixture = makeApi()
    fixture.getOperation.mockResolvedValueOnce(await bridgeSuccess(query(operation(2, "active"))))
    const session = makeWalkthroughOperations(fixture.api, 10_000).open(target)
    const pending = session.start(false)
    await vi.waitFor(() => expect(fixture.getOperation).toHaveBeenCalledOnce())

    for (const listener of fixture.hintListeners) {
      listener({
        _tag: "Success",
        value: Schema.decodeUnknownSync(WalkthroughOperationBridgeHint)({
          applicationInstanceId: "stale-app",
          processEpoch: "stale-epoch",
          sequence: 999,
          operationId: "operation-renderer",
          stateVersion: 999,
          kind: "operationTerminal",
        }),
      })
    }
    await vi.waitFor(() => expect(fixture.getOperation).toHaveBeenCalledTimes(2))
    await expect(pending).resolves.toMatchObject({ headSha: "head-renderer" })
    session.dispose()
  })

  it("does not let an older query overwrite a newer cancellation snapshot", async () => {
    const fixture = makeApi()
    let resolveOldQuery!: (value: Awaited<ReturnType<typeof fixture.api.getOperation>>) => void
    fixture.getOperation.mockImplementationOnce(
      () => new Promise((resolve) => (resolveOldQuery = resolve)),
    )
    const session = makeWalkthroughOperations(fixture.api, 10_000).open(target)
    const pending = session.start(false)
    void pending.catch(() => undefined)
    await vi.waitFor(() => expect(fixture.getOperation).toHaveBeenCalledOnce())

    await session.cancel()
    resolveOldQuery(await bridgeSuccess(query(operation(2, "active"), "stale-epoch")))
    await expect(pending).rejects.toMatchObject({ state: "cancelled", stateVersion: 3 })
    expect(session.state()).toMatchObject({
      status: "terminal",
      operation: { state: "cancelled", stateVersion: 3 },
    })
    session.dispose()
  })
})
