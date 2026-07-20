import { Effect, Schema, type Scope } from "effect"
import { chmod, mkdir, mkdtemp, open, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

/** A typed failure while creating a secure temporary resource. */
export class TempResourceError extends Schema.TaggedError<TempResourceError>()(
  "TempResourceError",
  {
    operation: Schema.Literal("create-directory", "create-file", "prepare-output-path"),
    path: Schema.NullOr(Schema.String),
    cause: Schema.Defect,
  },
) {}

/** Options controlling a private scoped temporary directory. */
export interface TempDirectoryOptions {
  readonly parentDirectory?: string
  readonly prefix?: string
}

/** Options controlling a file or output path inside a private temporary directory. */
export interface TempFileOptions extends TempDirectoryOptions {
  readonly fileName: string
}

/** Creates a mode-0700 temporary directory and removes it when the enclosing scope closes. */
export const makeTempDirectoryScoped = (
  options: TempDirectoryOptions = {},
): Effect.Effect<string, TempResourceError, Scope.Scope> =>
  Effect.acquireRelease(createTempDirectory(options), removeTempDirectory)

/** Creates an exclusive mode-0600 file and removes its private directory when the scope closes. */
export const makeTempFileScoped = (
  content: string | Uint8Array,
  options: TempFileOptions,
): Effect.Effect<string, TempResourceError, Scope.Scope> =>
  Effect.gen(function* () {
    const fileName = yield* validatePathComponent(options.fileName, "create-file")
    const directory = yield* makeTempDirectoryScoped(options)
    const path = join(directory, fileName)
    yield* writePrivateFile(path, content)
    return path
  })

/** Reserves an absent path in a private directory for an external CLI to create. */
export const makeTempOutputPathScoped = (
  options: TempFileOptions,
): Effect.Effect<string, TempResourceError, Scope.Scope> =>
  Effect.gen(function* () {
    const fileName = yield* validatePathComponent(options.fileName, "prepare-output-path")
    const directory = yield* makeTempDirectoryScoped(options)
    return join(directory, fileName)
  })

const createTempDirectory = (options: TempDirectoryOptions) =>
  Effect.gen(function* () {
    const prefix = yield* validatePathComponent(options.prefix ?? "diffdash-", "create-directory")
    const parentDirectory = options.parentDirectory ?? tmpdir()
    yield* fsEffect("create-directory", parentDirectory, () =>
      mkdir(parentDirectory, { recursive: true }),
    )
    const directory = yield* fsEffect("create-directory", parentDirectory, () =>
      mkdtemp(join(parentDirectory, prefix)),
    )
    return yield* fsEffect("create-directory", directory, () => chmod(directory, 0o700)).pipe(
      Effect.as(directory),
      Effect.tapError(() => removeTempDirectory(directory)),
    )
  })

const writePrivateFile = (path: string, content: string | Uint8Array) =>
  Effect.acquireUseRelease(
    fsEffect("create-file", path, () => open(path, "wx", 0o600)),
    (handle) =>
      Effect.gen(function* () {
        yield* fsEffect("create-file", path, () => handle.writeFile(content))
        yield* fsEffect("create-file", path, () => handle.chmod(0o600))
      }),
    (handle) => Effect.promise(() => handle.close()),
  )

const fsEffect = <A>(
  operation: TempResourceError["operation"],
  path: string,
  run: () => PromiseLike<A>,
) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => TempResourceError.make({ operation, path, cause }),
  })

const removeTempDirectory = (directory: string) =>
  Effect.promise(() => rm(directory, { force: true, recursive: true }))

const validatePathComponent = (
  value: string,
  operation: TempResourceError["operation"],
): Effect.Effect<string, TempResourceError> =>
  value.length > 0 && value !== "." && value !== ".." && basename(value) === value
    ? Effect.succeed(value)
    : TempResourceError.make({
        operation,
        path: null,
        cause: new TypeError("Temporary resource names must be single path components"),
      })
