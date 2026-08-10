import { randomUUID } from "node:crypto"
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  closeSync,
  fchmodSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"

import { ExecutablePath } from "@diffdash/domain/executable-path"

const ProcessFileSystemOperation = Schema.Literals([
  "access",
  "ensure-directory",
  "inspect",
  "read-link",
  "read-text",
  "remove",
  "replace-executable",
  "symlink",
])

const toError = <A>(cause: A): Error =>
  Schema.is(Schema.ErrorInstance())(cause) ? cause : new Error(String(cause))

/** A typed failure from a Process-owned filesystem operation. */
export class ProcessFileSystemError extends Schema.TaggedError<ProcessFileSystemError>()(
  "ProcessFileSystemError",
  {
    operation: ProcessFileSystemOperation,
    path: Schema.String,
    cause: Schema.ErrorInstance(),
  },
) {}

/** File entry kinds needed by Process-owned executable installation. */
export type ProcessFileEntryType = "file" | "symbolic-link" | "other"

/** Metadata for an inspected filesystem entry without exposing Node stat types. */
export interface ProcessFileEntry {
  readonly type: ProcessFileEntryType
}

/** Access checks supported by Process-owned filesystem operations. */
export type ProcessFileAccess = "executable" | "writable"

/** Options for creating a directory through the Process filesystem seam. */
export interface ProcessDirectoryOptions {
  readonly recursive?: boolean
  readonly mode?: number
}

/** Filesystem capability used by Core prerequisite and startup operations. */
export interface ProcessFileSystemOperations {
  readonly exists: (path: string) => Effect.Effect<boolean>
  readonly ensureDirectory: (
    path: string,
    options?: ProcessDirectoryOptions,
  ) => Effect.Effect<void, ProcessFileSystemError>
  readonly access: (
    path: string,
    mode: ProcessFileAccess,
  ) => Effect.Effect<void, ProcessFileSystemError>
  readonly inspect: (path: string) => Effect.Effect<ProcessFileEntry | null, ProcessFileSystemError>
  readonly readLink: (path: string) => Effect.Effect<string, ProcessFileSystemError>
  readonly readText: (path: string) => Effect.Effect<string, ProcessFileSystemError>
  readonly remove: (path: string) => Effect.Effect<void, ProcessFileSystemError>
  readonly replaceExecutableAtomically: (
    path: ExecutablePath,
    content: string,
  ) => Effect.Effect<void, ProcessFileSystemError>
  readonly symlink: (
    sourcePath: string,
    targetPath: string,
  ) => Effect.Effect<void, ProcessFileSystemError>
}

/** Process-owned filesystem service for local executable and startup operations. */
export class ProcessFileSystem extends Context.Service<
  ProcessFileSystem,
  ProcessFileSystemOperations
>()("@diffdash/process/ProcessFileSystem") {
  static readonly layer = Layer.succeed(
    ProcessFileSystem,
    ProcessFileSystem.of({
      exists: (path) => Effect.sync(() => existsSync(path)),
      ensureDirectory: (path, options) =>
        attempt("ensure-directory", path, () => mkdirSync(path, options)),
      access: (path, mode) =>
        attempt("access", path, () =>
          accessSync(path, mode === "executable" ? constants.X_OK : constants.W_OK),
        ),
      inspect: (path) =>
        Effect.try({
          try: () => {
            try {
              const entry = lstatSync(path)
              return {
                type: entry.isSymbolicLink()
                  ? ("symbolic-link" as const)
                  : entry.isFile()
                    ? ("file" as const)
                    : ("other" as const),
              }
            } catch (cause) {
              if (Schema.is(Schema.ErrorInstance())(cause) && isNotFound(cause)) return null
              throw cause
            }
          },
          catch: (cause) =>
            ProcessFileSystemError.make({ operation: "inspect", path, cause: toError(cause) }),
        }),
      readLink: (path) => attempt("read-link", path, () => readlinkSync(path)),
      readText: (path) => attempt("read-text", path, () => readFileSync(path, "utf8")),
      remove: (path) => attempt("remove", path, () => unlinkSync(path)),
      replaceExecutableAtomically: (path, content) =>
        attempt("replace-executable", path, () => replaceExecutableAtomically(path, content)),
      symlink: (sourcePath, targetPath) =>
        attempt("symlink", targetPath, () => symlinkSync(sourcePath, targetPath)),
    }),
  )
}

/** Replaces an executable through a private, exclusive, same-directory temporary file. */
export const replaceExecutableAtomically = (targetPath: ExecutablePath, content: string) => {
  const temporaryPath = join(dirname(targetPath), `.${randomUUID()}.${process.pid}.tmp`)
  let descriptor: number | null = null
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    )
    writeFileSync(descriptor, content, { encoding: "utf8" })
    fchmodSync(descriptor, 0o755)
    closeSync(descriptor)
    descriptor = null
    renameSync(temporaryPath, targetPath)
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        // Continue cleanup after a failed close.
      }
    }
    try {
      unlinkSync(temporaryPath)
    } catch {
      // The rename removed the temporary path, or cleanup is already best effort.
    }
  }
}

const attempt = <A>(
  operation: ProcessFileSystemError["operation"],
  path: string,
  operationEffect: () => A,
): Effect.Effect<A, ProcessFileSystemError> =>
  Effect.try({
    try: operationEffect,
    catch: (cause) => ProcessFileSystemError.make({ operation, path, cause: toError(cause) }),
  })

const isNotFound = (cause: Error) => "code" in cause && cause.code === "ENOENT"
