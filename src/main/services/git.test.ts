import { describe, expect, it } from "@effect/vitest"
import { Effect, Either, Layer } from "effect"

import { CliError, CliService, type CliResult } from "./cli"
import { GitService, LocalReviewChangedError } from "./git"

const makeCliResult = (stdout: string, args: readonly string[]): CliResult => ({
  args,
  command: "git",
  cwd: null,
  exitCode: 0,
  stderr: "",
  stdout,
})

describe("GitService", () => {
  it.effect(
    "detects a local Git checkout root and origin URL without parsing provider identity",
    () =>
      Effect.gen(function* () {
        const calls: CliResult[] = []
        const cliLayer = Layer.succeed(
          CliService,
          CliService.of({
            run: (_command, args) => {
              const result = makeCliResult(
                args.includes("rev-parse")
                  ? "/workspace/repo\n"
                  : "git@example.com:owner/repo.git\n",
                args,
              )
              calls.push(result)
              return Effect.succeed(result)
            },
          }),
        )
        const layer = GitService.layer.pipe(Layer.provide(cliLayer))

        const service = yield* GitService.pipe(Effect.provide(layer))
        const detected = yield* service.detectRepository("/workspace/repo/src")

        expect(detected).toEqual({
          remoteUrl: "git@example.com:owner/repo.git",
          rootPath: "/workspace/repo",
        })
        expect(calls.map((call) => call.args)).toEqual([
          ["-C", "/workspace/repo/src", "rev-parse", "--show-toplevel"],
          ["-C", "/workspace/repo", "remote", "get-url", "origin"],
        ])
      }),
  )

  it.effect("builds local review details from tracked and untracked changes", () =>
    Effect.gen(function* () {
      const trackedDiff = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,1 +1,1 @@
-old
+new`
      const untrackedDiff = `diff --git a/notes.txt b/notes.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/notes.txt
@@ -0,0 +1 @@
+note`
      const calls: Array<{ readonly args: readonly string[]; readonly cwd: string | undefined }> =
        []
      const cliLayer = Layer.succeed(
        CliService,
        CliService.of({
          run: (command, args, options) => {
            calls.push({ args: [...args], cwd: options?.cwd })
            const joined = args.join(" ")
            if (joined.includes("rev-parse --show-toplevel")) {
              return Effect.succeed(makeCliResult("/workspace/repo\n", args))
            }
            if (joined.includes("branch --show-current")) {
              return Effect.succeed(makeCliResult("feature/local\n", args))
            }
            if (joined.includes("rev-parse --verify HEAD")) {
              return Effect.succeed(
                makeCliResult("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", args),
              )
            }
            if (joined.includes("diff --no-ext-diff bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --")) {
              return Effect.succeed(makeCliResult(trackedDiff, args))
            }
            if (joined.includes("ls-files --others --exclude-standard -z")) {
              return Effect.succeed(makeCliResult("notes.txt\0", args))
            }
            if (args[0] === "diff" && args.includes("--no-index")) {
              return Effect.fail(
                CliError.make({
                  command,
                  args: [...args],
                  cwd: options?.cwd ?? null,
                  exitCode: 1,
                  stdout: untrackedDiff,
                  stderr: "",
                  cause: null,
                }),
              )
            }

            throw new Error(`Unexpected git call: ${joined}`)
          },
        }),
      )
      const layer = GitService.layer.pipe(Layer.provide(cliLayer))

      const service = yield* GitService.pipe(Effect.provide(layer))
      const detail = yield* service.getLocalReviewDetail("/workspace/repo/src")
      const diff = yield* service.getLocalReviewDiff("/workspace/repo/src")
      const snapshot = yield* service.getLocalReviewSnapshot("/workspace/repo/src")

      expect(detail).toMatchObject({
        branchName: "feature/local",
        repoName: "repo",
        rootPath: "/workspace/repo",
        title: "Local changes",
      })
      expect(detail.files.map((file) => file.path)).toEqual(["src/app.ts", "notes.txt"])
      expect(detail.files.map((file) => file.changeType)).toEqual(["modified", "added"])
      expect(diff.diff).toContain("diff --git a/src/app.ts b/src/app.ts")
      expect(diff.diff).toContain("diff --git a/notes.txt b/notes.txt")
      expect(snapshot.baseRevision).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
      expect(snapshot.headRevision).toBe(diff.headSha)
      expect(calls.some((call) => call.cwd === "/workspace/repo")).toBe(true)
    }),
  )

  it.effect("FUN-80 AC: rejects a local snapshot that changes during repeated capture", () =>
    Effect.gen(function* () {
      let diffRead = 0
      const cliLayer = Layer.succeed(
        CliService,
        CliService.of({
          run: (_command, args) => {
            const joined = args.join(" ")
            if (joined.includes("rev-parse --show-toplevel")) {
              return Effect.succeed(makeCliResult("/workspace/repo\n", args))
            }
            if (joined.includes("rev-parse --verify HEAD")) {
              return Effect.succeed(
                makeCliResult("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", args),
              )
            }
            if (joined.includes("diff --no-ext-diff bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --")) {
              diffRead += 1
              return Effect.succeed(
                makeCliResult(
                  `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old
+new-${diffRead}`,
                  args,
                ),
              )
            }
            if (joined.includes("ls-files --others --exclude-standard -z")) {
              return Effect.succeed(makeCliResult("", args))
            }
            throw new Error(`Unexpected git call: ${joined}`)
          },
        }),
      )
      const layer = GitService.layer.pipe(Layer.provide(cliLayer))
      const service = yield* GitService.pipe(Effect.provide(layer))
      const result = yield* Effect.either(service.getLocalReviewSnapshot("/workspace/repo"))

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(LocalReviewChangedError)
    }),
  )
})
