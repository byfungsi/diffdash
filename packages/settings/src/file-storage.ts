import { Context, Effect, FileSystem, Layer, Match, Path, Ref, Schema } from "effect"
import type { PlatformError } from "effect"

const textEncoder = new TextEncoder()

/** Filesystem operations used by JSON-backed settings services. */
export interface FileStorageOperations {
  readonly readOptionalTextFile: (
    path: string,
  ) => Effect.Effect<string | null, PlatformError.PlatformError>
  readonly writePrettyJsonFile: (
    path: string,
    value: Schema.Json,
  ) => Effect.Effect<void, PlatformError.PlatformError>
}

/** Effect Platform-backed durable file storage for application settings and state. */
export class FileStorage extends Context.Service<FileStorage, FileStorageOperations>()(
  "@diffdash/settings/FileStorage",
) {
  static readonly layer = Layer.effect(
    FileStorage,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const pathService = yield* Path.Path

      const readOptionalTextFile = Effect.fn("FileStorage.readOptionalTextFile")(function* (
        path: string,
      ) {
        return yield* fileSystem.readFileString(path).pipe(
          Effect.catchIf(
            (error) =>
              Match.value(error.reason).pipe(
                Match.when({ _tag: "NotFound" }, () => true),
                Match.orElse(() => false),
              ),
            () => Effect.succeed(null),
          ),
        )
      })

      const writePrettyJsonFile = Effect.fn("FileStorage.writePrettyJsonFile")(function* (
        path: string,
        value: Schema.Json,
      ) {
        const content = textEncoder.encode(`${JSON.stringify(value, null, 2)}\n`)
        const directory = pathService.dirname(path)
        const temporaryPath = pathService.join(
          directory,
          `.${pathService.basename(path)}.${crypto.randomUUID()}.tmp`,
        )
        const temporaryCreated = yield* Ref.make(false)
        const removeTemporaryFile = Ref.get(temporaryCreated).pipe(
          Effect.flatMap((created) => (created ? fileSystem.remove(temporaryPath) : Effect.void)),
        )

        yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 })
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fileSystem.open(temporaryPath, { flag: "wx", mode: 0o600 })
            yield* Ref.set(temporaryCreated, true)
            yield* file.writeAll(content)
            yield* file.sync
          }),
        ).pipe(
          Effect.onError(() => removeTemporaryFile.pipe(Effect.orDie)),
          Effect.andThen(
            fileSystem
              .rename(temporaryPath, path)
              .pipe(Effect.onError(() => removeTemporaryFile.pipe(Effect.orDie))),
          ),
        )
      })

      return FileStorage.of({ readOptionalTextFile, writePrettyJsonFile })
    }),
  )
}
