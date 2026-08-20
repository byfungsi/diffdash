import {
  LOCAL_CHECKOUT_FILE_LIST_MAX_BYTES,
  LOCAL_CHECKOUT_FILE_LIST_MAX_ENTRIES,
  LOCAL_CHECKOUT_FILE_MAX_BYTES,
  LocalCheckoutFileContent,
  LocalCheckoutFileList,
  LocalCheckoutFileListRejected,
  LocalCheckoutFileListRejectionReason,
  type LocalCheckoutFileListResult,
  LocalCheckoutFileReadRejected,
  LocalCheckoutFileReadRejectionReason,
  type LocalCheckoutFileReadResult,
} from "@diffdash/domain/local-checkout-file"
import type { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { utf8ByteLength } from "@diffdash/domain/utf8"
import { ProcessOutputError, ProcessService, processRequest } from "@diffdash/process"
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"

class LocalCheckoutFileListError extends Schema.TaggedError<LocalCheckoutFileListError>()(
  "LocalCheckoutFileListError",
  { reason: LocalCheckoutFileListRejectionReason },
) {}

class LocalCheckoutFileReadError extends Schema.TaggedError<LocalCheckoutFileReadError>()(
  "LocalCheckoutFileReadError",
  { path: RepositoryRelativePath, reason: LocalCheckoutFileReadRejectionReason },
) {}

/** Local Git and filesystem capability for bounded checkout source inspection. */
export class LocalCheckoutFiles extends Context.Service<
  LocalCheckoutFiles,
  {
    readonly list: (rootPath: RepositoryCheckoutPath) => Effect.Effect<LocalCheckoutFileListResult>
    readonly read: (
      rootPath: RepositoryCheckoutPath,
      path: RepositoryRelativePath,
    ) => Effect.Effect<LocalCheckoutFileReadResult>
  }
>()("@diffdash/local-git/LocalCheckoutFiles") {
  /** Production implementation backed by bounded Git output and Node filesystem inspection. */
  static readonly layer = Layer.effect(
    LocalCheckoutFiles,
    Effect.gen(function* () {
      const processes = yield* ProcessService

      const list = Effect.fn("LocalCheckoutFiles.list")(
        function* (rootPath: RepositoryCheckoutPath) {
          const canonicalRootPath = yield* Effect.try({
            try: () => realpathSync(rootPath),
            catch: () => new LocalCheckoutFileListError({ reason: "checkoutUnavailable" }),
          })
          const rootIsDirectory = yield* Effect.try({
            try: () => statSync(canonicalRootPath).isDirectory(),
            catch: () => new LocalCheckoutFileListError({ reason: "checkoutUnavailable" }),
          })
          if (!rootIsDirectory) {
            return yield* new LocalCheckoutFileListError({ reason: "checkoutUnavailable" })
          }

          const events = yield* processes
            .streamBytes(
              processRequest(
                "git",
                [
                  "-C",
                  canonicalRootPath,
                  "ls-files",
                  "-z",
                  "--cached",
                  "--others",
                  "--exclude-standard",
                ],
                {
                  timeoutMs: 10_000,
                  stdout: { maxBytes: LOCAL_CHECKOUT_FILE_LIST_MAX_BYTES, overflow: "error" },
                  stderr: { maxBytes: 64 * 1_024, overflow: "truncate" },
                  maxStreamBytes: LOCAL_CHECKOUT_FILE_LIST_MAX_BYTES + 64 * 1_024,
                  maxBufferedBytes: 64 * 1_024,
                  maxReservedBytes: 64 * 1_024,
                },
              ),
            )
            .pipe(
              Stream.runCollect,
              Effect.mapError(
                (error) =>
                  new LocalCheckoutFileListError({
                    reason:
                      Schema.is(ProcessOutputError)(error) && error.limit !== "io"
                        ? "limitExceeded"
                        : "gitUnavailable",
                  }),
              ),
            )

          const chunks: Uint8Array[] = []
          let byteLength = 0
          for (const event of events) {
            if (!("bytes" in event)) continue
            chunks.push(event.bytes)
            byteLength += event.bytes.byteLength
          }
          if (byteLength > LOCAL_CHECKOUT_FILE_LIST_MAX_BYTES) {
            return yield* new LocalCheckoutFileListError({ reason: "limitExceeded" })
          }

          const output = new Uint8Array(byteLength)
          let offset = 0
          for (const chunk of chunks) {
            output.set(chunk, offset)
            offset += chunk.byteLength
          }

          const paths: RepositoryRelativePath[] = []
          let start = 0
          for (let index = 0; index <= output.length; index += 1) {
            if (index < output.length && output[index] !== 0) continue
            if (index === start) {
              start = index + 1
              continue
            }
            const decoded = yield* Option.match(decodeUtf8(output.subarray(start, index)), {
              onNone: () => new LocalCheckoutFileListError({ reason: "invalidPath" }),
              onSome: Effect.succeed,
            })
            const path = yield* Option.match(
              Schema.decodeUnknownOption(RepositoryRelativePath)(decoded),
              {
                onNone: () => new LocalCheckoutFileListError({ reason: "invalidPath" }),
                onSome: Effect.succeed,
              },
            )
            paths.push(path)
            if (paths.length > LOCAL_CHECKOUT_FILE_LIST_MAX_ENTRIES) {
              return yield* new LocalCheckoutFileListError({ reason: "limitExceeded" })
            }
            start = index + 1
          }

          paths.sort((left, right) => Number(left > right) - Number(left < right))
          const uniquePaths = paths.filter((path, index) => path !== paths[index - 1])
          if (utf8ByteLength(JSON.stringify(uniquePaths)) > LOCAL_CHECKOUT_FILE_LIST_MAX_BYTES) {
            return yield* new LocalCheckoutFileListError({ reason: "limitExceeded" })
          }
          return LocalCheckoutFileList.make({ paths: uniquePaths })
        },
        Effect.catchTag("LocalCheckoutFileListError", ({ reason }) =>
          Effect.succeed(LocalCheckoutFileListRejected.make({ reason })),
        ),
      )

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

      return LocalCheckoutFiles.of({ list, read })
    }),
  )
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
