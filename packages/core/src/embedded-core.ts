import { Cause, Effect, Exit, ManagedRuntime, Option } from "effect"
import type {
  CoreMethod,
  CoreBoundaryFailure,
  CoreMethodInput,
  CoreOperationOptions,
  CoreResult,
  EmbeddedCore,
} from "./core"
import type { CoreConfiguration } from "./core-configuration"
import { createCoreLayer } from "./core-layer"
import { CoreOperationService } from "./core-operation-service"

/** Creates the single managed embedded DiffDash Core runtime. */
export const createEmbeddedCore = (configuration: CoreConfiguration): EmbeddedCore => {
  const runtime = ManagedRuntime.make(createCoreLayer(configuration))
  const run = async <A, E>(
    program: Effect.Effect<A, E, CoreOperationService>,
  ): Promise<CoreResult<A, CoreBoundaryFailure<E>>> => {
    const exit = await runtime.runPromiseExit(program)
    return coreResultFromExit(exit)
  }
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
    start: () => run(Effect.flatMap(CoreOperationService, (operations) => operations.start)),
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
            operations.walkthroughs.getStored(request),
          ),
        ),
    },
    dispose: () => runtime.dispose(),
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
