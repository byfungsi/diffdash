import { makeHostedReviewLocator } from "@diffdash/domain/git-provider"
import { HostedReviewTarget } from "@diffdash/domain/review-thread"
import { StoredWalkthrough, Walkthrough } from "@diffdash/domain/walkthrough"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Either, Exit, Scope } from "effect"

import {
  type WalkthroughOperationAccepted,
  WalkthroughOperationCapacityExceeded,
} from "../core-contract"
import { makeWalkthroughLifecycle } from "./walkthrough-operations"

const target = HostedReviewTarget.make({
  kind: "hosted",
  review: makeHostedReviewLocator("fixture", "platform/backend", "service", 73),
})

const request = { target, regenerate: true } as const

const storedWalkthrough = StoredWalkthrough.make({
  repoId: "fixture:platform/backend/service",
  prNumber: 73,
  reviewKey: "fixture:platform/backend/service#73",
  baseSha: "b".repeat(40),
  headSha: "a".repeat(40),
  promptVersion: "walkthrough-v1",
  walkthrough: Walkthrough.make({
    title: "Fixture review path",
    summary: "Review the fixture path.",
    chapters: [],
    support: [],
  }),
  createdAt: "2026-08-07T00:00:00.000Z",
})

describe("Walkthrough lifecycle", () => {
  it.scoped("starts, completes, retains its result, and preserves completed cancellation", () =>
    Effect.gen(function* () {
      const lifecycle = yield* makeWalkthroughLifecycle(() => Effect.succeed(storedWalkthrough))
      const accepted = yield* lifecycle.start(request)

      expect(yield* lifecycle.getOperation(accepted.operationId)).toMatchObject({
        _tag: "completed",
        walkthrough: storedWalkthrough,
      })
      expect(yield* lifecycle.cancel(accepted.operationId)).toMatchObject({
        _tag: "completed",
        walkthrough: storedWalkthrough,
      })
    }),
  )

  it.scoped("evicts the oldest terminal operation in FIFO map order", () =>
    Effect.gen(function* () {
      const lifecycle = yield* makeWalkthroughLifecycle(() => Effect.succeed(storedWalkthrough))
      const oldest = yield* lifecycle.start(request)
      yield* lifecycle.getOperation(oldest.operationId)
      const retained = yield* lifecycle.start(request)
      yield* lifecycle.getOperation(retained.operationId)

      for (let index = 0; index < 63; index += 1) {
        const accepted = yield* lifecycle.start(request)
        yield* lifecycle.getOperation(accepted.operationId)
      }

      expect(Either.isLeft(yield* Effect.either(lifecycle.getOperation(oldest.operationId)))).toBe(
        true,
      )
      expect(yield* lifecycle.getOperation(retained.operationId)).toMatchObject({
        _tag: "completed",
      })
    }),
  )

  it.scoped("rejects capacity when every retained operation is active", () =>
    Effect.gen(function* () {
      const lifecycle = yield* makeWalkthroughLifecycle(() => Effect.never)
      const accepted: Array<WalkthroughOperationAccepted> = []

      for (let index = 0; index < 64; index += 1) {
        accepted.push(yield* lifecycle.start(request))
      }

      const rejected = yield* Effect.either(lifecycle.start(request))
      expect(Either.isLeft(rejected)).toBe(true)
      if (Either.isLeft(rejected)) {
        expect(rejected.left).toBeInstanceOf(WalkthroughOperationCapacityExceeded)
      }

      const first = accepted[0]
      expect(first).toBeDefined()
      if (first === undefined) throw new Error("Expected one accepted walkthrough operation")
      expect(yield* lifecycle.cancel(first.operationId)).toMatchObject({ _tag: "cancelled" })
      expect(yield* lifecycle.start(request)).toHaveProperty("operationId")
    }),
  )

  it.scoped("interrupts active generation when its owning scope closes", () =>
    Effect.gen(function* () {
      const lifecycleScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(lifecycleScope, Exit.void))
      const lifecycle = yield* makeWalkthroughLifecycle(() => Effect.never).pipe(
        Effect.provideService(Scope.Scope, lifecycleScope),
      )
      const accepted = yield* lifecycle.start(request)

      yield* Scope.close(lifecycleScope, Exit.void)

      expect(yield* lifecycle.getOperation(accepted.operationId)).toMatchObject({
        _tag: "cancelled",
      })
    }),
  )
})
