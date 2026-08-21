import {
  LOCAL_CHECKOUT_FILE_MAX_BYTES,
  LocalCheckoutFileContent,
  LocalCheckoutFileReadRejected,
  LocalCheckoutFileReadRejectionReason,
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
import { Context, Effect, Layer, Option, Schema } from "effect"

class LocalCheckoutFileReadError extends Schema.TaggedError<LocalCheckoutFileReadError>()(
  "LocalCheckoutFileReadError",
  { path: RepositoryRelativePath, reason: LocalCheckoutFileReadRejectionReason },
) {}

/** Local Git and filesystem capability for bounded checkout source inspection. */
export class LocalCheckoutFiles extends Context.Service<
  LocalCheckoutFiles,
  {
    readonly read: (
      rootPath: RepositoryCheckoutPath,
      path: RepositoryRelativePath,
    ) => Effect.Effect<LocalCheckoutFileReadResult>
  }
>()("@diffdash/local-git/LocalCheckoutFiles") {
  /** Production implementation backed by bounded Node filesystem inspection. */
  static readonly layer = Layer.sync(LocalCheckoutFiles, () => {
    const read = Effect.fn("LocalCheckoutFiles.read")(
      function* (rootPath: RepositoryCheckoutPath, path: RepositoryRelativePath) {
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
          catch: (cause) => {
            if (symbolicLink) {
              return new LocalCheckoutFileReadError({ path, reason: "unsafeSymlink" })
            }
            return new LocalCheckoutFileReadError({
              path,
              reason: isMissing(cause) ? "missing" : "ioFailure",
            })
          },
        })
        if (!isContained(checkoutRoot, resolvedPath)) {
          return yield* new LocalCheckoutFileReadError({ path, reason: "unsafeSymlink" })
        }

        return yield* Effect.acquireUseRelease(
          Effect.try({
            try: () =>
              openSync(
                resolvedPath,
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
              ),
            catch: (cause) => {
              if (isMissing(cause)) {
                return new LocalCheckoutFileReadError({ path, reason: "missing" })
              }
              return new LocalCheckoutFileReadError({
                path,
                reason: hasErrorCode(cause, "ELOOP") ? "unsafeSymlink" : "ioFailure",
              })
            },
          }),
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

    return LocalCheckoutFiles.of({ read })
  })
}

const decodeUtf8 = (bytes: Uint8Array): Option.Option<string> =>
  Option.liftThrowable((value: Uint8Array) =>
    new TextDecoder("utf-8", { fatal: true }).decode(value),
  )(bytes)

const isContained = (rootPath: string, candidatePath: string): boolean => {
  const child = relative(rootPath, candidatePath)
  return child === "" || (!child.startsWith("..") && !isAbsolute(child))
}

const hasErrorCode = (cause: unknown, code: string): boolean =>
  Schema.is(Schema.ErrorInstance())(cause) && "code" in cause && cause.code === code

const isMissing = (cause: unknown): boolean => hasErrorCode(cause, "ENOENT")
