import { Cause, Effect, Exit, ManagedRuntime, Option } from "effect"
import type {
  CoreMethod,
  CoreMethodInput,
  CoreOperationOptions,
  CoreOperationOutput,
  EmbeddedCore,
} from "./core"
import type { CoreConfiguration } from "./core-configuration"
import { createCoreLayer } from "./core-layer"
import { CoreOperationService } from "./core-operation-service"

/** Creates the single managed embedded DiffDash Core runtime. */
export const createEmbeddedCore = (configuration: CoreConfiguration): EmbeddedCore => {
  const runtime = ManagedRuntime.make(createCoreLayer(configuration))
  const run = async <A, E>(program: Effect.Effect<A, E, CoreOperationService>): Promise<A> => {
    const exit = await runtime.runPromiseExit(program)
    if (Exit.isSuccess(exit)) return exit.value
    const failure = Cause.failureOption(exit.cause)
    if (Option.isSome(failure)) throw failure.value
    throw Cause.squash(exit.cause)
  }
  const execute: EmbeddedCore["execute"] = <Method extends CoreMethod>(
    method: Method,
    input: CoreMethodInput<Method>,
    options?: CoreOperationOptions,
  ): Promise<CoreOperationOutput<Method>> =>
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
