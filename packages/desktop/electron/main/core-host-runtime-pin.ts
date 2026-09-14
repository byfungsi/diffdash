import { Effect, Option, Ref, Schema } from "effect"

import { CoreHostKind } from "./core-host-selection"

/** Rejects a runtime switch after ownership authorization has begun in this application. */
export class CoreHostRuntimePinError extends Schema.TaggedError<CoreHostRuntimePinError>()(
  "CoreHostRuntimePinError",
  { pinnedHost: CoreHostKind, requestedHost: CoreHostKind },
) {}

/** Application-lifetime runtime choice shared by initial startup and supervised Core restarts. */
export interface CoreHostRuntimePin {
  readonly selectedHost: Effect.Effect<Option.Option<CoreHostKind>>
  readonly pinBeforeOwnershipAuthorization: (
    host: CoreHostKind,
  ) => Effect.Effect<void, CoreHostRuntimePinError>
}

/** Pins the first authorized runtime atomically; a new Electron application gets a fresh pin. */
export const makeCoreHostRuntimePin = Effect.fn("makeCoreHostRuntimePin")(
  function* (): Effect.fn.Return<CoreHostRuntimePin> {
    const selectedHost = yield* Ref.make(Option.none<CoreHostKind>())
    const pinBeforeOwnershipAuthorization = Effect.fn(
      "CoreHostRuntimePin.pinBeforeOwnershipAuthorization",
    )(function* (requestedHost: CoreHostKind) {
      const pinnedHost = yield* Ref.modify(selectedHost, (current) => {
        const pinned = Option.getOrElse(current, () => requestedHost)
        return [pinned, Option.some(pinned)] as const
      })
      if (pinnedHost !== requestedHost) {
        yield* CoreHostRuntimePinError.make({ pinnedHost, requestedHost })
      }
    })
    return { selectedHost: Ref.get(selectedHost), pinBeforeOwnershipAuthorization }
  },
)
