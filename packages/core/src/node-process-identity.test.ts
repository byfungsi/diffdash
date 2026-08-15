import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { nodeDatabaseOwnerInspector, readProcessStartIdentity } from "./node-process-identity"

describe("Node process identity", () => {
  it.effect(
    "derives a stable identity for the current process and distinguishes stale starts",
    () =>
      Effect.gen(function* () {
        const identity = yield* readProcessStartIdentity(process.pid)
        expect(identity.length).toBeGreaterThan(8)
        expect(yield* readProcessStartIdentity(process.pid)).toBe(identity)
        expect(
          yield* nodeDatabaseOwnerInspector.inspect({
            applicationInstance: "app",
            processEpoch: "epoch",
            pid: process.pid,
            processStartIdentity: identity,
            nonce: "owner-1",
          }),
        ).toBe("alive")
        expect(
          yield* nodeDatabaseOwnerInspector.inspect({
            applicationInstance: "app",
            processEpoch: "epoch",
            pid: process.pid,
            processStartIdentity: `${identity}-stale`,
            nonce: "owner-2",
          }),
        ).toBe("dead")
      }),
  )
})
