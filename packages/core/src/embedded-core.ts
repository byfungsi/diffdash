import { Cause, Effect, Exit, ManagedRuntime, Match, Option } from "effect"
import type {
  CoreBoundaryFailure,
  CoreMethod,
  CoreMethodInput,
  CoreOperationOptions,
  CoreResult,
  CoreStartFailure,
  EmbeddedCore,
} from "./core-contract"
import { CoreLifecycleError } from "./core-contract"
import type { CoreConfiguration } from "./core-configuration"
import { createCoreLayer } from "./core-layer"
import { CoreOperationService } from "./core-operation-service"

type CoreLifecycle =
  | { readonly _tag: "created" }
  | {
      readonly _tag: "starting"
      readonly promise: Promise<CoreResult<void, CoreStartFailure>>
    }
  | { readonly _tag: "started" }
  | { readonly _tag: "failed"; readonly failure: CoreStartFailure }
  | { readonly _tag: "disposing"; readonly promise: Promise<void> }
  | { readonly _tag: "disposed" }

const unavailable = (
  state: "notStarted" | "starting" | "disposing" | "disposed",
): CoreResult<never, CoreLifecycleError> => ({
  ok: false,
  error: CoreLifecycleError.make({
    state,
    message: `DiffDash Core is ${state === "notStarted" ? "not started" : state}.`,
  }),
})

/** Creates the single managed embedded DiffDash Core runtime. */
export const createEmbeddedCore = (configuration: CoreConfiguration): EmbeddedCore => {
  const runtime = ManagedRuntime.make(createCoreLayer(configuration))
  let lifecycle: CoreLifecycle = { _tag: "created" }

  const runRuntime = async <A, E>(
    program: Effect.Effect<A, E, CoreOperationService>,
  ): Promise<CoreResult<A, E | CoreStartFailure>> => {
    const exit = await runtime.runPromiseExit(program)
    return coreResultFromExit(exit)
  }

  const run = <A, E>(
    program: Effect.Effect<A, E, CoreOperationService>,
  ): Promise<CoreResult<A, CoreBoundaryFailure<E>>> =>
    Match.value(lifecycle).pipe(
      Match.tag("started", () => runRuntime(program)),
      Match.tag("failed", ({ failure }) => Promise.resolve({ ok: false as const, error: failure })),
      Match.tag("created", () => Promise.resolve(unavailable("notStarted"))),
      Match.tag("starting", () => Promise.resolve(unavailable("starting"))),
      Match.tag("disposing", () => Promise.resolve(unavailable("disposing"))),
      Match.tag("disposed", () => Promise.resolve(unavailable("disposed"))),
      Match.exhaustive,
    )

  const start: EmbeddedCore["start"] = () =>
    Match.value(lifecycle).pipe(
      Match.tag("created", () => {
        const promise = runRuntime(
          Effect.flatMap(CoreOperationService, (operations) => operations.start),
        )
        lifecycle = { _tag: "starting", promise }
        void promise.then((result) => {
          if (lifecycle._tag !== "starting" || lifecycle.promise !== promise) return undefined
          lifecycle = result.ok ? { _tag: "started" } : { _tag: "failed", failure: result.error }
          return undefined
        })
        return promise
      }),
      Match.tag("starting", ({ promise }) => promise),
      Match.tag("started", () => Promise.resolve({ ok: true as const, value: undefined })),
      Match.tag("failed", ({ failure }) => Promise.resolve({ ok: false as const, error: failure })),
      Match.tag("disposing", () => Promise.resolve(unavailable("disposing"))),
      Match.tag("disposed", () => Promise.resolve(unavailable("disposed"))),
      Match.exhaustive,
    )

  const dispose = (): Promise<void> =>
    Match.value(lifecycle).pipe(
      Match.tag("disposing", ({ promise }) => promise),
      Match.tag("disposed", () => Promise.resolve()),
      Match.orElse((current) => {
        const started = current._tag === "starting" ? current.promise : Promise.resolve()
        const promise = started.then(() => runtime.dispose())
        lifecycle = { _tag: "disposing", promise }
        void promise.finally(() => {
          if (lifecycle._tag === "disposing" && lifecycle.promise === promise) {
            lifecycle = { _tag: "disposed" }
          }
        })
        return promise
      }),
    )

  const execute: EmbeddedCore["execute"] = <Method extends CoreMethod>(
    method: Method,
    input: CoreMethodInput<Method>,
    options?: CoreOperationOptions,
  ) =>
    run(
      Effect.flatMap(CoreOperationService, (operations) =>
        operations.execute(method, input, options),
      ),
    )

  return {
    start,
    execute,
    walkthroughs: {
      start: (request) =>
        run(
          Effect.flatMap(CoreOperationService, (operations) =>
            operations.walkthroughs.start(request),
          ),
        ),
      getOperation: (operationId) =>
        run(
          Effect.flatMap(CoreOperationService, (operations) =>
            operations.walkthroughs.getOperation(operationId),
          ),
        ),
      cancel: (operationId) =>
        run(
          Effect.flatMap(CoreOperationService, (operations) =>
            operations.walkthroughs.cancel(operationId),
          ),
        ),
      getStored: (request) =>
        run(
          Effect.flatMap(CoreOperationService, (operations) =>
            operations.walkthroughs.getStored(request).pipe(Effect.map(Option.getOrNull)),
          ),
        ),
    },
    dispose,
  }
}

/** Converts expected Effect failures to CoreResult while preserving defects as rejected promises. */
export const coreResultFromExit = <Value, Failure>(
  exit: Exit.Exit<Value, Failure>,
): CoreResult<Value, Failure> => {
  if (Exit.isSuccess(exit)) return { ok: true, value: exit.value }
  const defect = Cause.dieOption(exit.cause)
  if (Option.isSome(defect)) throw defect.value
  const failure = Cause.failureOption(exit.cause)
  if (Option.isSome(failure)) return { ok: false, error: failure.value }
  throw Cause.squash(exit.cause)
}
