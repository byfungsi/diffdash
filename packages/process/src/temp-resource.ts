import { Context, Effect, FileSystem, Layer, Path, Schema, type Scope } from "effect"
import { tmpdir } from "node:os"

/** A typed failure while creating a secure temporary resource. */
export class TempResourceError extends Schema.TaggedError<TempResourceError>()(
  "TempResourceError",
  {
    operation: Schema.Literals(["create-directory", "create-file", "prepare-output-path"]),
    path: Schema.NullOr(Schema.String),
    cause: Schema.ErrorInstance(),
  },
) {}

/** Options controlling a private scoped temporary directory. */
export interface TempDirectoryOptions {
  readonly parentDirectory?: string
  readonly prefix?: string
  readonly resourceClass?: TempResourceClass
}

/** Catalog class selected by the producer creating a temporary resource. */
export type TempResourceClass = "agentTemp" | "processTemp"

/** Verified directory emitted only after the temporary-resource producer creates it. */
export interface CreatedTempResource {
  readonly directory: string
  readonly parentDirectory: string
  readonly resourceClass: TempResourceClass
}

/** Optional lifecycle authority installed by an owning composition root. */
export interface TempResourceLifecycle {
  readonly manage: (resource: CreatedTempResource) => Effect.Effect<void, Error, Scope.Scope>
}

/** Options controlling a file or output path inside a private temporary directory. */
export interface TempFileOptions extends TempDirectoryOptions {
  readonly fileName: string
}

/** Scoped temporary-resource operations consumed by local CLI providers. */
export interface TempResourceOperations {
  readonly makeTempDirectoryScoped: (
    options?: TempDirectoryOptions,
  ) => Effect.Effect<string, TempResourceError, Scope.Scope>
  readonly makeTempFileScoped: (
    content: string | Uint8Array,
    options: TempFileOptions,
  ) => Effect.Effect<string, TempResourceError, Scope.Scope>
  readonly makeTempOutputPathScoped: (
    options: TempFileOptions,
  ) => Effect.Effect<string, TempResourceError, Scope.Scope>
}

/** Effect Platform-backed service for private scoped temporary resources. */
export class TempResources extends Context.Service<TempResources, TempResourceOperations>()(
  "@diffdash/process/TempResources",
) {
  /** Default temporary-resource implementation with scope-owned cleanup. */
  static get layer() {
    return makeTempResourcesLayer()
  }

  /** Builds temporary resources with lifecycle integration selected by a composition root. */
  static readonly layerWithLifecycle = (lifecycle: TempResourceLifecycle) =>
    makeTempResourcesLayer(lifecycle)
}

function makeTempResourcesLayer(lifecycle?: TempResourceLifecycle) {
  return Layer.effect(
    TempResources,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const pathService = yield* Path.Path

      const makeTempDirectoryScoped = (
        options: TempDirectoryOptions = {},
      ): Effect.Effect<string, TempResourceError, Scope.Scope> => {
        const parentDirectory = options.parentDirectory ?? tmpdir()
        return Effect.gen(function* () {
          const prefix = yield* validatePathComponent(
            pathService,
            options.prefix ?? "diffdash-",
            "create-directory",
          )
          yield* fileSystem.makeDirectory(parentDirectory, { recursive: true, mode: 0o700 })
          const directory = yield* fileSystem.makeTempDirectory({
            directory: parentDirectory,
            prefix,
          })
          yield* fileSystem.chmod(directory, 0o700)
          if (lifecycle === undefined) {
            yield* Effect.addFinalizer(() =>
              fileSystem.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
            )
          } else {
            yield* lifecycle
              .manage({
                directory,
                parentDirectory,
                resourceClass: options.resourceClass ?? "processTemp",
              })
              .pipe(
                Effect.onError(() =>
                  fileSystem
                    .remove(directory, { recursive: true, force: true })
                    .pipe(Effect.ignore),
                ),
              )
          }
          return directory
        }).pipe(
          Effect.mapError((cause) =>
            TempResourceError.make({ operation: "create-directory", path: parentDirectory, cause }),
          ),
        )
      }

      const makeTempFileScoped = (
        content: string | Uint8Array,
        options: TempFileOptions,
      ): Effect.Effect<string, TempResourceError, Scope.Scope> =>
        Effect.gen(function* () {
          const fileName = yield* validatePathComponent(
            pathService,
            options.fileName,
            "create-file",
          )
          const directory = yield* makeTempDirectoryScoped(options)
          const path = pathService.join(directory, fileName)
          yield* Effect.scoped(
            Effect.gen(function* () {
              const file = yield* fileSystem.open(path, { flag: "wx", mode: 0o600 })
              yield* file.writeAll(
                typeof content === "string" ? new TextEncoder().encode(content) : content,
              )
              yield* fileSystem.chmod(path, 0o600)
            }),
          ).pipe(
            Effect.mapError((cause) =>
              TempResourceError.make({ operation: "create-file", path, cause }),
            ),
          )
          return path
        })

      const makeTempOutputPathScoped = (
        options: TempFileOptions,
      ): Effect.Effect<string, TempResourceError, Scope.Scope> =>
        Effect.gen(function* () {
          const fileName = yield* validatePathComponent(
            pathService,
            options.fileName,
            "prepare-output-path",
          )
          const directory = yield* makeTempDirectoryScoped(options)
          return pathService.join(directory, fileName)
        })

      return TempResources.of({
        makeTempDirectoryScoped,
        makeTempFileScoped,
        makeTempOutputPathScoped,
      })
    }),
  )
}

const validatePathComponent = (
  pathService: Path.Path,
  value: string,
  operation: TempResourceError["operation"],
): Effect.Effect<string, TempResourceError> =>
  value.length > 0 && value !== "." && value !== ".." && pathService.basename(value) === value
    ? Effect.succeed(value)
    : TempResourceError.make({
        operation,
        path: null,
        cause: new TypeError("Temporary resource names must be single path components"),
      })
