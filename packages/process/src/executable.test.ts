import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { findExecutableInPath } from "./executable"

const makeTempDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "diffdash-executable-test-"))),
  (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
)

describe("findExecutableInPath", () => {
  it.scopedLive("finds an executable in an explicit PATH", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const executable = join(directory, "diffdash-test")
      yield* Effect.promise(async () => {
        await writeFile(executable, "#!/bin/sh\n", "utf8")
        await chmod(executable, 0o755)
      })

      const found = yield* findExecutableInPath("diffdash-test", { envPath: directory })

      expect(Option.getOrNull(found)).toBe(resolve(executable))
    }),
  )

  it.live("returns None when no executable candidate exists", () =>
    Effect.gen(function* () {
      const found = yield* findExecutableInPath("diffdash-command-that-does-not-exist", {
        envPath: "",
      })
      expect(Option.isNone(found)).toBe(true)
    }),
  )
})
