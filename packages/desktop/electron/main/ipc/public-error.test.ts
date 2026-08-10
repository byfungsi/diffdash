import { ReviewSnapshotSearchResultTooLargeError } from "@diffdash/core"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { describe, expect, it } from "vitest"
import { toPublicIpcError } from "./public-error"

describe("toPublicIpcError", () => {
  it("maps Core-owned response budget failures at the Electron boundary", () => {
    const result = toPublicIpcError(
      ReviewSnapshotSearchResultTooLargeError.make({ maxResponseBytes: 1 }),
      InvokeChannel.searchReviewSnapshot,
    )

    expect(result).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      message: "One review search result exceeds the bounded response size.",
      operation: InvokeChannel.searchReviewSnapshot,
    })
  })
})
