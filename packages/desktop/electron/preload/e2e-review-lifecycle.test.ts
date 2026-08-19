import { InvokeChannel } from "@diffdash/protocol/channels"
import { describe, expect, it, vi } from "vitest"

import { createDiffDashE2eDiagnosticsBridgeApi } from "./e2e-review-lifecycle"
import { createRendererTransport, type RendererIpc } from "./transport"

describe("E2E review lifecycle preload bridge", () => {
  it("routes both diagnostics calls through their typed invoke contracts", async () => {
    const invoke = vi.fn<RendererIpc["invoke"]>(async (channel) =>
      channel === InvokeChannel.e2eReviewLifecycleDiagnostics
        ? {
            _tag: "Success",
            value: {
              acquisitions: {
                activeOperationIds: [],
                started: 1,
                completed: 0,
                superseded: 1,
                drained: 1,
                failed: 0,
                lastStartedOperationId: "core:prior",
                lastSupersededOperationId: "core:prior",
                lastDrainedOperationId: "core:prior",
              },
              sessions: {
                activeSessionId: "session:replacement",
                opened: 2,
                disposed: 1,
                lastDisposedSessionId: "session:prior",
              },
            },
          }
        : { _tag: "Success", value: { armed: true } },
    )
    const ipc: RendererIpc = {
      invoke,
      on: () => undefined,
      removeListener: () => undefined,
    }
    const api = createDiffDashE2eDiagnosticsBridgeApi(createRendererTransport(ipc))

    await expect(api.reviewLifecycle()).resolves.toMatchObject({ _tag: "Success" })
    await expect(api.holdNextReviewAcquisition()).resolves.toEqual({
      _tag: "Success",
      value: { armed: true },
    })
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      InvokeChannel.e2eReviewLifecycleDiagnostics,
      InvokeChannel.e2eHoldNextReviewAcquisition,
    ])
  })
})
