import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Result } from "effect"

import { makeCoreHostRuntimePin } from "./core-host-runtime-pin"

describe("Core host runtime pin", () => {
  it.effect("allows same-runtime authorization repeatedly without filesystem prerequisites", () =>
    Effect.gen(function* () {
      const pin = yield* makeCoreHostRuntimePin()
      expect(yield* pin.selectedHost).toEqual(Option.none())
      yield* pin.pinBeforeOwnershipAuthorization("utility")
      yield* pin.pinBeforeOwnershipAuthorization("utility")
      expect(yield* pin.selectedHost).toEqual(Option.some("utility"))
    }),
  )

  it.effect("atomically accepts only one runtime across competing authorizations", () =>
    Effect.gen(function* () {
      const pin = yield* makeCoreHostRuntimePin()
      const results = yield* Effect.all(
        [
          Effect.result(pin.pinBeforeOwnershipAuthorization("bun")),
          Effect.result(pin.pinBeforeOwnershipAuthorization("utility")),
        ],
        { concurrency: "unbounded" },
      )
      expect(results.filter(Result.isSuccess)).toHaveLength(1)
      expect(results.filter(Result.isFailure)).toHaveLength(1)
    }),
  )
})
