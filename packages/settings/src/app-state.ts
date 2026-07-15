import { Context, Effect, Layer, Schema } from "effect"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { AppState as SharedAppState, DEFAULT_APP_STATE } from "@diffdash/domain/app-state"

const AppStateFromJson = Schema.parseJson(SharedAppState)

/** A typed failure from reading or writing app-level state. */
export class AppStateError extends Schema.TaggedError<AppStateError>()("AppStateError", {
  operation: Schema.String,
  cause: Schema.Defect,
}) {}

/** Main-process service for JSON-backed app-level state. */
export class AppState extends Context.Tag("@diffdash/AppState")<
  AppState,
  {
    readonly get: Effect.Effect<SharedAppState, AppStateError>
    readonly save: (state: SharedAppState) => Effect.Effect<SharedAppState, AppStateError>
  }
>() {
  static readonly layer = (path: string) =>
    Layer.succeed(
      AppState,
      AppState.of({
        get: readStateFile(path).pipe(
          Effect.flatMap((content) => {
            if (content === null) return Effect.succeed(DEFAULT_APP_STATE)

            return Schema.decodeUnknown(AppStateFromJson)(content).pipe(
              Effect.catchAll(() => Effect.succeed(DEFAULT_APP_STATE)),
            )
          }),
        ),
        save: Effect.fn("AppState.save")(function (state) {
          return writeStateFile(path, state).pipe(Effect.as(state))
        }),
      }),
    )
}

const readStateFile = (path: string): Effect.Effect<string | null, AppStateError> =>
  Effect.try({
    try: () => {
      try {
        return readFileSync(path, "utf8")
      } catch (cause) {
        if (isNodeError(cause) && cause.code === "ENOENT") return null
        throw cause
      }
    },
    catch: (cause) => AppStateError.make({ operation: "read", cause }),
  })

const writeStateFile = (path: string, state: SharedAppState): Effect.Effect<void, AppStateError> =>
  Effect.try({
    try: () => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8")
    },
    catch: (cause) => AppStateError.make({ operation: "write", cause }),
  })

const isNodeError = (cause: unknown): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause
