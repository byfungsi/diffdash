import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"

import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  CoreRequestContext,
  CoreRequestId,
  HostRequestContext,
  HostRequestId,
} from "./identity"

describe("Core RPC identity", () => {
  it("decodes bounded application, epoch, and origin-specific request identities", () => {
    const context = Schema.decodeUnknownSync(HostRequestContext)({
      applicationInstanceId: "app-1",
      processEpoch: "epoch-1",
      requestId: "h:request-1",
    })

    expect(context).toEqual({
      applicationInstanceId: ApplicationInstanceId.make("app-1"),
      processEpoch: CoreProcessEpoch.make("epoch-1"),
      requestId: HostRequestId.make("h:request-1"),
    })
    expect(
      Schema.decodeUnknownSync(CoreRequestContext)({
        applicationInstanceId: "app-1",
        processEpoch: "epoch-1",
        requestId: "c:request-1",
      }),
    ).toEqual({
      applicationInstanceId: ApplicationInstanceId.make("app-1"),
      processEpoch: CoreProcessEpoch.make("epoch-1"),
      requestId: CoreRequestId.make("c:request-1"),
    })
  })

  it("rejects crossed request namespaces and malformed identities", () => {
    expect(Result.isFailure(Schema.decodeUnknownResult(HostRequestId)("c:request-1"))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(CoreRequestId)("h:request-1"))).toBe(true)
    expect(
      Result.isFailure(Schema.decodeUnknownResult(HostRequestId)("h:request with spaces")),
    ).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(CoreProcessEpoch)(""))).toBe(true)
    expect(
      Result.isFailure(Schema.decodeUnknownResult(ApplicationInstanceId)("x".repeat(101))),
    ).toBe(true)
  })
})
