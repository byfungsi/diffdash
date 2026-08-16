import { type CoreStartupFailure } from "./core-startup-error"
import { CoreOperationService } from "./core-operation-service"
import { CoreDurableCommandService } from "./core-durable-command-coordinator"
import { CoreEventHub } from "./core-event-hub"
import { Context, Deferred, Effect, Layer } from "effect"

/** SQL-backed Core authorities installed exactly once after ownership authorization. */
export interface CoreRuntimeServicesValue {
  readonly operations: CoreOperationService["Service"]
  readonly commands: CoreDurableCommandService["Service"]
  readonly events: CoreEventHub["Service"]
}

/** Deferred authority allowing the control socket to precede SQL-backed runtime acquisition. */
export class CoreRuntimeServices extends Context.Service<
  CoreRuntimeServices,
  {
    readonly operations: Effect.Effect<CoreRuntimeServicesValue["operations"]>
    readonly commands: Effect.Effect<CoreRuntimeServicesValue["commands"]>
    readonly events: Effect.Effect<CoreRuntimeServicesValue["events"]>
    readonly install: (services: CoreRuntimeServicesValue) => Effect.Effect<boolean, never>
    readonly fail: (failure: CoreStartupFailure) => Effect.Effect<boolean, never>
  }
>()("@diffdash/core/CoreRuntimeServices") {}

/** Creates one deferred runtime authority for an aggregate Core server. */
export const coreRuntimeServicesLayer = Layer.effect(
  CoreRuntimeServices,
  Effect.gen(function* () {
    const runtime = yield* Deferred.make<CoreRuntimeServicesValue, CoreStartupFailure>()
    return CoreRuntimeServices.of({
      operations: Deferred.await(runtime).pipe(
        Effect.orDie,
        Effect.map((services) => services.operations),
      ),
      commands: Deferred.await(runtime).pipe(
        Effect.orDie,
        Effect.map((services) => services.commands),
      ),
      events: Deferred.await(runtime).pipe(
        Effect.orDie,
        Effect.map((services) => services.events),
      ),
      install: (services) => Deferred.succeed(runtime, services),
      fail: (failure) => Deferred.fail(runtime, failure),
    })
  }),
)

/** Adapts an already-composed operation service for focused RPC server fixtures. */
export const coreRuntimeOperationsLayer = Layer.effect(
  CoreRuntimeServices,
  Effect.gen(function* () {
    const operations = yield* CoreOperationService
    return CoreRuntimeServices.of({
      operations: Effect.succeed(operations),
      commands: Effect.die("Durable commands are not composed for this RPC audience."),
      events: Effect.die("Core events are not composed for this RPC audience."),
      install: () => Effect.succeed(false),
      fail: () => Effect.succeed(false),
    })
  }),
)

/** Adapts already-composed state-delivery services for focused RPC server fixtures. */
export const coreRuntimeStateDeliveryLayer = Layer.effect(
  CoreRuntimeServices,
  Effect.gen(function* () {
    const commands = yield* CoreDurableCommandService
    const events = yield* CoreEventHub
    return CoreRuntimeServices.of({
      operations: Effect.die("Application operations are not composed for this RPC audience."),
      commands: Effect.succeed(commands),
      events: Effect.succeed(events),
      install: () => Effect.succeed(false),
      fail: () => Effect.succeed(false),
    })
  }),
)
