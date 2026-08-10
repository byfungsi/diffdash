import { Cause, Effect, Exit, ManagedRuntime, Match, Option, Result } from "effect"
import * as DatabaseNode from "@diffdash/persistence/database-node"
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
import type { CoreStartupFailure } from "./core-startup-error"
import { captureCoreDefect, type CapturedCoreDefect } from "./core-defect-boundary"
import { productionProviderComposition, type CoreProviderComposition } from "./provider-composition"

// Binding preserves the service key while avoiding React hook lint treating Effect's use as React.use.
const withCoreOperations = CoreOperationService.use.bind(CoreOperationService)

type CoreLifecycle =
  | { readonly _tag: "created" }
  | {
      readonly _tag: "starting"
      readonly promise: Promise<CoreResult<void, CoreStartFailure>>
    }
  | { readonly _tag: "started" }
  | { readonly _tag: "failed"; readonly failure: CoreStartFailure }
  | { readonly _tag: "defective"; readonly defect: CapturedCoreDefect }
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

/** Minimal managed-runtime boundary owned by the embedded Core lifecycle. */
export interface EmbeddedCoreRuntime {
  readonly runPromiseExit: <A, E>(
    program: Effect.Effect<A, E, CoreOperationService>,
  ) => Promise<Exit.Exit<A, E | CoreStartupFailure>>
  readonly dispose: () => Promise<void>
}

/** Builds the embedded Core facade around one managed runtime. */
export const makeEmbeddedCore = (runtime: EmbeddedCoreRuntime): EmbeddedCore => {
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
      Match.tag("defective", ({ defect }) => Promise.reject(defect.cause)),
      Match.tag("created", () => Promise.resolve(unavailable("notStarted"))),
      Match.tag("starting", () => Promise.resolve(unavailable("starting"))),
      Match.tag("disposing", () => Promise.resolve(unavailable("disposing"))),
      Match.tag("disposed", () => Promise.resolve(unavailable("disposed"))),
      Match.exhaustive,
    )

  const start: EmbeddedCore["start"] = () =>
    Match.value(lifecycle).pipe(
      Match.tag("created", () => {
        const promise = runRuntime(withCoreOperations((operations) => operations.start))
        lifecycle = { _tag: "starting", promise }
        void promise.then(
          (result) => {
            const isCurrentStart = Match.value(lifecycle).pipe(
              Match.tag("starting", ({ promise: currentPromise }) => currentPromise === promise),
              Match.orElse(() => false),
            )
            if (!isCurrentStart) return undefined
            lifecycle = result.ok ? { _tag: "started" } : { _tag: "failed", failure: result.error }
            return undefined
          },
          (defect) => {
            const isCurrentStart = Match.value(lifecycle).pipe(
              Match.tag("starting", ({ promise: currentPromise }) => currentPromise === promise),
              Match.orElse(() => false),
            )
            if (!isCurrentStart) return undefined
            lifecycle = { _tag: "defective", defect: captureCoreDefect(defect) }
            return undefined
          },
        )
        return promise
      }),
      Match.tag("starting", ({ promise }) => promise),
      Match.tag("started", () => Promise.resolve({ ok: true as const, value: undefined })),
      Match.tag("failed", ({ failure }) => Promise.resolve({ ok: false as const, error: failure })),
      Match.tag("defective", ({ defect }) => Promise.reject(defect.cause)),
      Match.tag("disposing", () => Promise.resolve(unavailable("disposing"))),
      Match.tag("disposed", () => Promise.resolve(unavailable("disposed"))),
      Match.exhaustive,
    )

  const dispose = (): Promise<void> =>
    Match.value(lifecycle).pipe(
      Match.tag("disposing", ({ promise }) => promise),
      Match.tag("disposed", () => Promise.resolve()),
      Match.orElse((current) => {
        const started = Match.value(current).pipe(
          Match.tag("starting", ({ promise }) =>
            promise.then(
              () => undefined,
              () => undefined,
            ),
          ),
          Match.orElse(() => Promise.resolve()),
        )
        const promise = started.then(() => runtime.dispose())
        lifecycle = { _tag: "disposing", promise }
        const finishDisposal = () => {
          const isCurrentDisposal = Match.value(lifecycle).pipe(
            Match.tag("disposing", ({ promise: currentPromise }) => currentPromise === promise),
            Match.orElse(() => false),
          )
          if (isCurrentDisposal) {
            lifecycle = { _tag: "disposed" }
          }
        }
        void promise.then(finishDisposal, finishDisposal)
        return promise
      }),
    )

  const execute: EmbeddedCore["execute"] = <Method extends CoreMethod>(
    method: Method,
    input: CoreMethodInput<Method>,
    options?: CoreOperationOptions,
  ) => run(withCoreOperations((operations) => operations.execute(method, input, options)))

  return {
    start,
    execute,
    walkthroughs: {
      start: (request) =>
        run(withCoreOperations((operations) => operations.walkthroughs.start(request))),
      getOperation: (operationId) =>
        run(withCoreOperations((operations) => operations.walkthroughs.getOperation(operationId))),
      cancel: (operationId) =>
        run(withCoreOperations((operations) => operations.walkthroughs.cancel(operationId))),
      getStored: (request) =>
        run(
          withCoreOperations((operations) =>
            operations.walkthroughs.getStored(request).pipe(Effect.map(Option.getOrNull)),
          ),
        ),
    },
    dispose,
  }
}

/** Creates the single managed embedded DiffDash Core runtime from a required provider composition. */
export const createEmbeddedCoreWithProviderComposition = (
  configuration: CoreConfiguration,
  providerComposition: CoreProviderComposition,
): EmbeddedCore =>
  makeEmbeddedCore(
    ManagedRuntime.make(
      createCoreLayer(
        configuration,
        DatabaseNode.layer(configuration.paths.database),
        providerComposition,
      ),
    ),
  )

/** Creates the production embedded DiffDash Core runtime. */
export const createEmbeddedCore = (configuration: CoreConfiguration): EmbeddedCore =>
  createEmbeddedCoreWithProviderComposition(configuration, productionProviderComposition)

/** Converts expected Effect failures to CoreResult while preserving defects as rejected promises. */
export const coreResultFromExit = <Value, Failure>(
  exit: Exit.Exit<Value, Failure>,
): CoreResult<Value, Failure> => {
  if (Exit.isSuccess(exit)) return { ok: true, value: exit.value }
  const defect = Cause.findDefect(exit.cause)
  if (Result.isSuccess(defect)) throw captureCoreDefect(defect.success).cause
  const failure = Cause.findErrorOption(exit.cause)
  if (Option.isSome(failure)) return { ok: false, error: failure.value }
  throw Cause.squash(exit.cause)
}
