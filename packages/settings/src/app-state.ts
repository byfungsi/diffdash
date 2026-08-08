import { Context, Effect, Layer, Schema } from "effect"

import { AppState as SharedAppState, DEFAULT_APP_STATE } from "@diffdash/domain/app-state"
import { FileStorage, type FileStorageOperations } from "./file-storage"

const AppStateFromJson = Schema.fromJsonString(SharedAppState)

/** A typed failure from reading or writing app-level state. */
export class AppStateError extends Schema.TaggedError<AppStateError>()("AppStateError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Main-process service for JSON-backed app-level state. */
export class AppState extends Context.Service<
  AppState,
  {
    readonly get: Effect.Effect<SharedAppState, AppStateError>
    readonly save: (state: SharedAppState) => Effect.Effect<SharedAppState, AppStateError>
  }
>()("@diffdash/AppState") {
  static readonly layer = (path: string) =>
    Layer.effect(
      AppState,
      Effect.gen(function* () {
        const storage = yield* FileStorage
        return AppState.of({
          get: readStateFile(storage, path).pipe(
            Effect.flatMap((content) => {
              if (content === null) return Effect.succeed(DEFAULT_APP_STATE)

              return Schema.decodeUnknownEffect(AppStateFromJson)(content).pipe(
                Effect.mapError((cause) => AppStateError.make({ operation: "read", cause })),
              )
            }),
          ),
          save: Effect.fn("AppState.save")(function (state) {
            return writeStateFile(storage, path, state).pipe(Effect.as(state))
          }),
        })
      }),
    )
}

const readStateFile = (
  storage: FileStorageOperations,
  path: string,
): Effect.Effect<string | null, AppStateError> =>
  storage
    .readOptionalTextFile(path)
    .pipe(Effect.mapError((error) => AppStateError.make({ operation: "read", cause: error })))

const writeStateFile = (
  storage: FileStorageOperations,
  path: string,
  state: SharedAppState,
): Effect.Effect<void, AppStateError> =>
  storage
    .writePrettyJsonFile(path, state)
    .pipe(Effect.mapError((error) => AppStateError.make({ operation: "write", cause: error })))
