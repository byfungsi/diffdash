import { expect, expectTypeOf, it } from "@effect/vitest"
import { Effect } from "effect"

import { CoreMethod, type CoreMethod as CoreMethodType } from "../core-contract"
import { assertUniqueOperationHandlers, type OperationHandlers } from "./operation-handlers"

it("keeps the composed handler contract exhaustive over every Core method", () => {
  expectTypeOf<keyof OperationHandlers>().toEqualTypeOf<CoreMethodType>()
})

it("rejects a Core method owned by more than one capability", () => {
  expect(() =>
    assertUniqueOperationHandlers([
      { [CoreMethod.analyticsStart]: () => Effect.void },
      { [CoreMethod.analyticsStart]: () => Effect.void },
    ]),
  ).toThrow(/more than one handler/)
})
