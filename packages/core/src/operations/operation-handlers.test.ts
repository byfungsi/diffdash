import { expect, expectTypeOf, it } from "@effect/vitest"
import { Effect } from "effect"
import { readFileSync } from "node:fs"

import { CoreMethod, type CoreMethod as CoreMethodType } from "../core-contract"
import { assertUniqueOperationHandlers, type OperationHandlers } from "./operation-handlers"

it("keeps the composed handler contract exhaustive over every Core method", () => {
  expectTypeOf<keyof OperationHandlers>().toEqualTypeOf<CoreMethodType>()
})

it("keeps Core RPC dispatch on the closed named operation surface", () => {
  const sources = [
    "../core-operation-service.ts",
    "../core-application-rpc-handlers.ts",
    "../core-business-rpc-handlers.ts",
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))

  expect(sources.join("\n")).not.toMatch(/operations\.execute|readonly execute: <Method/)
})

it("does not synthesize embedded ownership identities for durable operations", () => {
  const sources = ["thread-operation-handlers.ts", "walkthrough-operations.ts"].map((path) =>
    readFileSync(new URL(path, import.meta.url), "utf8"),
  )

  expect(sources.join("\n")).not.toMatch(/embedded-core|embedded-epoch/)
})

it("rejects a Core method owned by more than one capability", () => {
  expect(() =>
    assertUniqueOperationHandlers([
      { [CoreMethod.analyticsStart]: () => Effect.void },
      { [CoreMethod.analyticsStart]: () => Effect.void },
    ]),
  ).toThrow(/more than one handler/)
})
