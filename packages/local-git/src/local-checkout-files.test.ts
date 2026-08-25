import { expect, it } from "@effect/vitest"
import {
  LOCAL_CHECKOUT_FILE_CHUNK_BYTES,
  LocalCheckoutFileContent,
  LocalCheckoutFileReadRejected,
  LOCAL_CHECKOUT_FILE_MAX_BYTES,
} from "@diffdash/domain/local-checkout-file"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { Effect, Result, Stream } from "effect"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LocalCheckoutFiles } from "./local-checkout-files"

const localCheckoutFilesLayer = LocalCheckoutFiles.layer

const withRepository = <A, R>(
  run: (rootPath: RepositoryCheckoutPath) => Effect.Effect<A, never, R>,
): Effect.Effect<A, never, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const rootPath = mkdtempSync(join(tmpdir(), "diffdash-checkout-files-"))
      execFileSync("git", ["init", "--quiet", rootPath])
      return RepositoryCheckoutPath.make(rootPath)
    }),
    run,
    (rootPath) => Effect.sync(() => rmSync(rootPath, { force: true, recursive: true })),
  )

it.live("reads UTF-8 text and returns typed recoverable file rejections", () =>
  withRepository((rootPath) =>
    Effect.gen(function* () {
      writeFileSync(join(rootPath, "source.ts"), "export const greeting = 'hello'\n")
      writeFileSync(join(rootPath, "binary.bin"), Uint8Array.from([1, 0, 2]))
      writeFileSync(join(rootPath, "invalid.txt"), Uint8Array.from([0xc3, 0x28]))
      writeFileSync(join(rootPath, "large.txt"), "x".repeat(LOCAL_CHECKOUT_FILE_MAX_BYTES + 1))
      mkdirSync(join(rootPath, "directory"))
      const outsidePath = join(rootPath, "..", `outside-${Date.now()}.txt`)
      writeFileSync(outsidePath, "outside\n")
      symlinkSync(outsidePath, join(rootPath, "outside-link.txt"))

      const files = yield* LocalCheckoutFiles
      expect(yield* files.read(rootPath, RepositoryRelativePath.make("source.ts"))).toEqual(
        LocalCheckoutFileContent.make({
          path: RepositoryRelativePath.make("source.ts"),
          content: "export const greeting = 'hello'\n",
        }),
      )
      expect(yield* files.read(rootPath, RepositoryRelativePath.make("missing.ts"))).toEqual(
        LocalCheckoutFileReadRejected.make({
          path: RepositoryRelativePath.make("missing.ts"),
          reason: "missing",
        }),
      )
      expect(yield* files.read(rootPath, RepositoryRelativePath.make("binary.bin"))).toMatchObject({
        _tag: "rejected",
        reason: "binary",
      })
      expect(yield* files.read(rootPath, RepositoryRelativePath.make("invalid.txt"))).toMatchObject(
        {
          _tag: "rejected",
          reason: "invalidUtf8",
        },
      )
      expect(yield* files.read(rootPath, RepositoryRelativePath.make("large.txt"))).toMatchObject({
        _tag: "rejected",
        reason: "oversized",
      })
      const streamedLargeFile = yield* Effect.result(
        Stream.runDrain(files.stream(rootPath, RepositoryRelativePath.make("large.txt"))),
      )
      expect(Result.isFailure(streamedLargeFile)).toBe(true)
      if (Result.isFailure(streamedLargeFile)) {
        expect(streamedLargeFile.failure).toMatchObject({ reason: "oversized" })
      }
      expect(yield* files.read(rootPath, RepositoryRelativePath.make("directory"))).toMatchObject({
        _tag: "rejected",
        reason: "notRegularFile",
      })
      expect(
        yield* files.read(rootPath, RepositoryRelativePath.make("outside-link.txt")),
      ).toMatchObject({ _tag: "rejected", reason: "unsafeSymlink" })

      rmSync(outsidePath, { force: true })
    }),
  ).pipe(Effect.provide(localCheckoutFilesLayer)),
)

it.live("streams large UTF-8 files in bounded chunks without splitting decoded content", () =>
  withRepository((rootPath) =>
    Effect.gen(function* () {
      const content = `${"a".repeat(LOCAL_CHECKOUT_FILE_CHUNK_BYTES - 1)}😀tail`
      writeFileSync(join(rootPath, "large-source.ts"), content)
      const files = yield* LocalCheckoutFiles

      const chunks = Array.from(
        yield* Stream.runCollect(
          files.stream(rootPath, RepositoryRelativePath.make("large-source.ts")),
        ).pipe(Effect.orDie),
      )

      expect(chunks).toHaveLength(2)
      expect(chunks.every(({ bytes }) => bytes.byteLength <= LOCAL_CHECKOUT_FILE_CHUNK_BYTES)).toBe(
        true,
      )
      expect(Buffer.concat(chunks.map(({ bytes }) => Buffer.from(bytes))).toString("utf8")).toBe(
        content,
      )
    }),
  ).pipe(Effect.provide(localCheckoutFilesLayer)),
)
