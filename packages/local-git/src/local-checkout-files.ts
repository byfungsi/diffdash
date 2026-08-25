import {
  LOCAL_CHECKOUT_FILE_CHUNK_BYTES,
  LOCAL_CHECKOUT_FILE_MAX_BYTES,
  LocalCheckoutFileChunk,
  LocalCheckoutFileContent,
  LocalCheckoutFileReadError,
  LocalCheckoutFileReadRejected,
  type LocalCheckoutFileReadResult,
} from "@diffdash/domain/local-checkout-file"
import type { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"

/** Local Git and filesystem capability for bounded checkout source inspection. */
export class LocalCheckoutFiles extends Context.Service<
  LocalCheckoutFiles,
  {
    readonly read: (
      rootPath: RepositoryCheckoutPath,
      path: RepositoryRelativePath,
    ) => Effect.Effect<LocalCheckoutFileReadResult>
    readonly stream: (
      rootPath: RepositoryCheckoutPath,
      path: RepositoryRelativePath,
    ) => Stream.Stream<LocalCheckoutFileChunk, LocalCheckoutFileReadError>
  }
>()("@diffdash/local-git/LocalCheckoutFiles") {
  /** Production implementation backed by bounded Node filesystem inspection. */
  static readonly layer = Layer.sync(LocalCheckoutFiles, () => {
    const read = Effect.fn("LocalCheckoutFiles.read")(
      function* (rootPath: RepositoryCheckoutPath, path: RepositoryRelativePath) {
        return yield* Effect.acquireUseRelease(
          openSecureFile(rootPath, path),
          (descriptor) =>
            Effect.gen(function* () {
              const entry = yield* Effect.try({
                try: () => fstatSync(descriptor),
                catch: (cause) =>
                  new LocalCheckoutFileReadError({
                    path,
                    reason: isMissing(cause) ? "missing" : "ioFailure",
                  }),
              })
              if (!entry.isFile()) {
                return yield* new LocalCheckoutFileReadError({ path, reason: "notRegularFile" })
              }
              if (entry.size > LOCAL_CHECKOUT_FILE_MAX_BYTES) {
                return yield* new LocalCheckoutFileReadError({ path, reason: "oversized" })
              }

              const bytes = yield* Effect.try({
                try: () => {
                  const buffer = Buffer.allocUnsafe(LOCAL_CHECKOUT_FILE_MAX_BYTES + 1)
                  let byteLength = 0
                  while (byteLength < buffer.byteLength) {
                    const bytesRead = readSync(
                      descriptor,
                      buffer,
                      byteLength,
                      buffer.byteLength - byteLength,
                      null,
                    )
                    if (bytesRead === 0) break
                    byteLength += bytesRead
                  }
                  return buffer.subarray(0, byteLength)
                },
                catch: (cause) =>
                  new LocalCheckoutFileReadError({
                    path,
                    reason: isMissing(cause) ? "missing" : "ioFailure",
                  }),
              })
              if (bytes.byteLength > LOCAL_CHECKOUT_FILE_MAX_BYTES) {
                return yield* new LocalCheckoutFileReadError({ path, reason: "oversized" })
              }
              if (
                bytes.some(
                  (byte) =>
                    byte === 0 || (byte < 0x09 && byte !== 0) || (byte > 0x0d && byte < 0x20),
                )
              ) {
                return yield* new LocalCheckoutFileReadError({ path, reason: "binary" })
              }
              return yield* Option.match(decodeUtf8(bytes), {
                onNone: () => new LocalCheckoutFileReadError({ path, reason: "invalidUtf8" }),
                onSome: (content) =>
                  Effect.succeed(LocalCheckoutFileContent.make({ path, content })),
              })
            }),
          (descriptor) =>
            Effect.sync(() => {
              try {
                closeSync(descriptor)
              } catch {
                // The read outcome remains actionable even when descriptor cleanup fails.
              }
            }),
        )
      },
      Effect.catchTag("LocalCheckoutFileReadError", ({ path, reason }) =>
        Effect.succeed(LocalCheckoutFileReadRejected.make({ path, reason })),
      ),
    )

    const stream = (rootPath: RepositoryCheckoutPath, path: RepositoryRelativePath) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const descriptor = yield* Effect.acquireRelease(
            openSecureFile(rootPath, path),
            closeDescriptor,
          )
          const entry = yield* Effect.try({
            try: () => fstatSync(descriptor),
            catch: (cause) =>
              new LocalCheckoutFileReadError({
                path,
                reason: isMissing(cause) ? "missing" : "ioFailure",
              }),
          })
          if (!entry.isFile()) {
            return yield* new LocalCheckoutFileReadError({ path, reason: "notRegularFile" })
          }
          if (entry.size > LOCAL_CHECKOUT_FILE_MAX_BYTES) {
            return yield* new LocalCheckoutFileReadError({ path, reason: "oversized" })
          }

          const decoder = new TextDecoder("utf-8", { fatal: true })
          return Stream.unfold(0, (offset) =>
            Effect.try({
              try: () => {
                if (offset === entry.size) {
                  decoder.decode()
                  const current = fstatSync(descriptor)
                  if (
                    current.size !== entry.size ||
                    current.mtimeMs !== entry.mtimeMs ||
                    current.ctimeMs !== entry.ctimeMs
                  ) {
                    throw new Error("File changed while streaming")
                  }
                  return undefined
                }
                const byteLength = Math.min(LOCAL_CHECKOUT_FILE_CHUNK_BYTES, entry.size - offset)
                const buffer = Buffer.allocUnsafe(byteLength)
                const bytesRead = readSync(descriptor, buffer, 0, byteLength, offset)
                if (bytesRead === 0) throw new Error("File ended while streaming")
                const bytes = buffer.subarray(0, bytesRead)
                if (isBinary(bytes)) {
                  throw new LocalCheckoutFileReadError({ path, reason: "binary" })
                }
                decoder.decode(bytes, { stream: offset + bytesRead < entry.size })
                return [LocalCheckoutFileChunk.make({ path, bytes }), offset + bytesRead] as const
              },
              catch: (cause) =>
                cause instanceof LocalCheckoutFileReadError
                  ? cause
                  : new LocalCheckoutFileReadError({
                      path,
                      reason: cause instanceof TypeError ? "invalidUtf8" : "ioFailure",
                    }),
            }),
          )
        }),
      )

    return LocalCheckoutFiles.of({ read, stream })
  })
}

const openSecureFile = Effect.fn("LocalCheckoutFiles.openSecureFile")(function* (
  rootPath: RepositoryCheckoutPath,
  path: RepositoryRelativePath,
) {
  const checkoutRoot = yield* Effect.try({
    try: () => realpathSync(rootPath),
    catch: () => new LocalCheckoutFileReadError({ path, reason: "checkoutUnavailable" }),
  })
  const candidatePath = resolve(checkoutRoot, ...path.split(/[\\/]/u))
  if (!isContained(checkoutRoot, candidatePath)) {
    return yield* new LocalCheckoutFileReadError({ path, reason: "unsafeSymlink" })
  }
  const symbolicLink = yield* Effect.try({
    try: () => lstatSync(candidatePath).isSymbolicLink(),
    catch: (cause) =>
      new LocalCheckoutFileReadError({
        path,
        reason: isMissing(cause) ? "missing" : "ioFailure",
      }),
  })
  const resolvedPath = yield* Effect.try({
    try: () => realpathSync(candidatePath),
    catch: (cause) =>
      new LocalCheckoutFileReadError({
        path,
        reason:
          symbolicLink || hasErrorCode(cause, "ELOOP")
            ? "unsafeSymlink"
            : isMissing(cause)
              ? "missing"
              : "ioFailure",
      }),
  })
  if (!isContained(checkoutRoot, resolvedPath)) {
    return yield* new LocalCheckoutFileReadError({ path, reason: "unsafeSymlink" })
  }
  return yield* Effect.try({
    try: () =>
      openSync(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
    catch: (cause) =>
      new LocalCheckoutFileReadError({
        path,
        reason: isMissing(cause)
          ? "missing"
          : hasErrorCode(cause, "ELOOP")
            ? "unsafeSymlink"
            : "ioFailure",
      }),
  })
})

const decodeUtf8 = (bytes: Uint8Array): Option.Option<string> =>
  Option.liftThrowable((value: Uint8Array) =>
    new TextDecoder("utf-8", { fatal: true }).decode(value),
  )(bytes)

const isBinary = (bytes: Uint8Array): boolean =>
  bytes.some((byte) => byte === 0 || (byte < 0x09 && byte !== 0) || (byte > 0x0d && byte < 0x20))

const closeDescriptor = (descriptor: number) =>
  Effect.sync(() => {
    try {
      closeSync(descriptor)
    } catch {
      // The stream outcome remains actionable even when descriptor cleanup fails.
    }
  })

const isContained = (rootPath: string, candidatePath: string): boolean => {
  const child = relative(rootPath, candidatePath)
  return child === "" || (!child.startsWith("..") && !isAbsolute(child))
}

const hasErrorCode = (cause: unknown, code: string): boolean =>
  Schema.is(Schema.ErrorInstance())(cause) && "code" in cause && cause.code === code

const isMissing = (cause: unknown): boolean => hasErrorCode(cause, "ENOENT")
