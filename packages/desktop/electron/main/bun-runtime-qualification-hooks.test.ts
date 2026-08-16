import { describe, expect, it } from "@effect/vitest"
import { Effect, Ref } from "effect"

import {
  makeBunRuntimeQualificationHooks,
  retryBunCoreHealthProbe,
  type BunRuntimeQualificationExecutor,
  type BunRuntimeQualificationOptions,
} from "./bun-runtime-qualification-hooks"
import { BunRuntimeProbeError, type BunRuntimeCandidate } from "./core-bun-runtime"

const candidate: BunRuntimeCandidate = {
  executablePath: "/Applications/DiffDash.app/private/bun",
  source: "system",
}

describe("production Bun runtime qualification hooks", () => {
  it.effect("retries transient Core health failures within its attempt budget", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      yield* retryBunCoreHealthProbe(
        Ref.updateAndGet(attempts, (current) => current + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt < 3
              ? BunRuntimeProbeError.make({ safeMessage: "A Bun runtime probe failed." })
              : Effect.void,
          ),
        ),
      )

      expect(yield* Ref.get(attempts)).toBe(3)
    }),
  )

  it.effect(
    "routes every capability through the executable seam without exposing process output",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make<ReadonlyArray<string>>([])
        const record = (capability: string) =>
          Ref.update(calls, (current) => [...current, capability])
        const executor: BunRuntimeQualificationExecutor = {
          runtimeFacts: (received) =>
            record(`runtime:${received.executablePath}`).pipe(
              Effect.as({ version: "1.2.23", architecture: "arm64" }),
            ),
          runScriptProbe: (received, capability) =>
            record(`${capability}:${received.executablePath}`),
          runCoreHealthProbe: (received) => record(`health:${received.executablePath}`),
        }
        // SAFETY: The injected executor owns all behavior, so the production-only options are never read.
        const options = {} as BunRuntimeQualificationOptions
        const hooks = makeBunRuntimeQualificationHooks(options, executor)

        expect(yield* hooks.runtimeFacts(candidate)).toEqual({
          version: "1.2.23",
          architecture: "arm64",
        })
        yield* hooks.worker(candidate)
        yield* hooks.processCancellation(candidate)
        yield* hooks.filesystem(candidate)
        yield* hooks.socket(candidate)
        yield* hooks.sqlite(candidate)
        yield* hooks.effect(candidate)
        yield* hooks.artifact(candidate)
        yield* hooks.coreHealth(candidate)

        expect(yield* Ref.get(calls)).toEqual([
          `runtime:${candidate.executablePath}`,
          `worker:${candidate.executablePath}`,
          `processCancellation:${candidate.executablePath}`,
          `filesystem:${candidate.executablePath}`,
          `socket:${candidate.executablePath}`,
          `sqlite:${candidate.executablePath}`,
          `health:${candidate.executablePath}`,
          `health:${candidate.executablePath}`,
          `health:${candidate.executablePath}`,
        ])
      }),
  )
})
