import { Context, Effect, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import { basename } from "node:path"

import { parseUnifiedDiff } from "../../shared/diff-parser"
import {
  LocalReviewDetail,
  LocalReviewDiff,
  PullRequestFile,
  type DetectedRepositoryCheckout,
} from "../../shared/domain"
import { LocalReviewSnapshot } from "../../shared/review-context"
import { ReviewKey, ReviewRevision } from "../../shared/review-identity"
import { CliService, type CliError } from "./cli"

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

/** The local review changed while DiffDash was capturing one coherent snapshot. */
export class LocalReviewChangedError extends Schema.TaggedError<LocalReviewChangedError>()(
  "LocalReviewChangedError",
  {
    rootPath: Schema.String,
  },
) {}

/** Main-process service for local Git repository inspection. */
export class GitService extends Context.Tag("@diffdash/GitService")<
  GitService,
  {
    readonly detectRepository: (
      localPath: string,
    ) => Effect.Effect<DetectedRepositoryCheckout, CliError>
    readonly detectRoot: (localPath: string) => Effect.Effect<string, CliError>
    readonly currentBranch: (localPath: string) => Effect.Effect<string, CliError>
    readonly getLocalReviewDetail: (localPath: string) => Effect.Effect<LocalReviewDetail, CliError>
    readonly getLocalReviewDiff: (localPath: string) => Effect.Effect<LocalReviewDiff, CliError>
    readonly getLocalReviewSnapshot: (
      localPath: string,
    ) => Effect.Effect<LocalReviewSnapshot, CliError | LocalReviewChangedError>
  }
>() {
  static readonly layer = Layer.effect(
    GitService,
    Effect.gen(function* () {
      const cli = yield* CliService
      const detectRoot = Effect.fn("GitService.detectRoot")(function* (localPath: string) {
        const root = yield* cli.run("git", ["-C", localPath, "rev-parse", "--show-toplevel"])
        return root.stdout.trim()
      })

      const currentBranch = Effect.fn("GitService.currentBranch")(function* (localPath: string) {
        const branch = yield* cli.run("git", ["-C", localPath, "branch", "--show-current"])
        return branch.stdout.trim()
      })

      const getLocalReviewDiff = Effect.fn("GitService.getLocalReviewDiff")(function* (
        localPath: string,
      ) {
        const rootPath = yield* detectRoot(localPath)
        const baseSha = yield* currentHeadSha(rootPath).pipe(Effect.provideService(CliService, cli))
        const trackedDiff = yield* localTrackedDiff(rootPath, baseSha).pipe(
          Effect.provideService(CliService, cli),
        )
        const untrackedDiff = yield* localUntrackedDiff(rootPath).pipe(
          Effect.provideService(CliService, cli),
        )
        const diff = joinDiffSections([trackedDiff, untrackedDiff])
        const diffHash = createHash("sha256").update(diff).digest("hex")

        return LocalReviewDiff.make({
          rootPath,
          baseSha: baseSha ?? EMPTY_TREE_SHA,
          headSha: diffHash,
          diffHash,
          diff,
          fetchedAt: new Date().toISOString(),
        })
      })

      const getLocalReviewSnapshot = Effect.fn("GitService.getLocalReviewSnapshot")(function* (
        localPath: string,
      ) {
        let diff: LocalReviewDiff | null = null
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const before = yield* getLocalReviewDiff(localPath)
          const after = yield* getLocalReviewDiff(before.rootPath)
          if (
            before.rootPath === after.rootPath &&
            before.baseSha === after.baseSha &&
            before.diffHash === after.diffHash
          ) {
            diff = after
            break
          }
        }
        if (diff === null) {
          const rootPath = yield* detectRoot(localPath)
          return yield* LocalReviewChangedError.make({ rootPath })
        }
        const branchName = yield* currentBranch(diff.rootPath).pipe(
          Effect.map((branch) => (branch.length === 0 ? null : branch)),
          Effect.catchAll(() => Effect.succeed(null)),
        )
        const parsedDiff = parseUnifiedDiff(diff.diff)
        const detail = localReviewDetail(diff, branchName)

        return LocalReviewSnapshot.make({
          reviewKey: ReviewKey.make(
            `local:${createHash("sha256").update(diff.rootPath).digest("hex")}`,
          ),
          baseRevision: ReviewRevision.make(diff.baseSha),
          headRevision: ReviewRevision.make(diff.headSha),
          detail,
          diff,
          parsedDiff,
        })
      })

      return GitService.of({
        detectRepository: Effect.fn("GitService.detectRepository")(function* (localPath: string) {
          const rootPath = yield* detectRoot(localPath)
          const remote = yield* cli.run("git", ["-C", rootPath, "remote", "get-url", "origin"])
          return {
            rootPath,
            remoteUrl: remote.stdout.trim(),
          }
        }),
        detectRoot,
        currentBranch,
        getLocalReviewDetail: (localPath) =>
          Effect.gen(function* () {
            const diff = yield* getLocalReviewDiff(localPath)
            const branchName = yield* currentBranch(diff.rootPath).pipe(
              Effect.map((branch) => (branch.length === 0 ? null : branch)),
              Effect.catchAll(() => Effect.succeed(null)),
            )
            return localReviewDetail(diff, branchName)
          }),
        getLocalReviewDiff,
        getLocalReviewSnapshot,
      })
    }),
  )
}

const currentHeadSha = (rootPath: string) =>
  Effect.gen(function* () {
    const cli = yield* CliService
    return yield* cli.run("git", ["-C", rootPath, "rev-parse", "--verify", "HEAD"]).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.catchAll(() => Effect.succeed(null)),
    )
  })

const localTrackedDiff = (rootPath: string, baseSha: string | null) =>
  Effect.gen(function* () {
    const cli = yield* CliService
    const args =
      baseSha === null
        ? ["-C", rootPath, "diff", "--cached", "--no-ext-diff", "--"]
        : ["-C", rootPath, "diff", "--no-ext-diff", baseSha, "--"]
    const result = yield* cli.run("git", args, { timeoutMs: 60_000 })
    return result.stdout
  })

const localUntrackedDiff = (rootPath: string) =>
  Effect.gen(function* () {
    const cli = yield* CliService
    const untracked = yield* cli.run(
      "git",
      ["-C", rootPath, "ls-files", "--others", "--exclude-standard", "-z"],
      { timeoutMs: 20_000 },
    )
    const paths = splitNul(untracked.stdout)
    const diffs = yield* Effect.forEach(paths, (path) => untrackedFileDiff(rootPath, path))
    return joinDiffSections(diffs)
  })

const untrackedFileDiff = (rootPath: string, path: string) =>
  Effect.gen(function* () {
    const cli = yield* CliService
    return yield* cli
      .run("git", ["diff", "--no-ext-diff", "--no-index", "--", "/dev/null", path], {
        cwd: rootPath,
        timeoutMs: 60_000,
      })
      .pipe(
        Effect.map((result) => result.stdout),
        Effect.catchAll((error) =>
          error.exitCode === 1 ? Effect.succeed(error.stdout ?? "") : Effect.fail(error),
        ),
      )
  })

const splitNul = (output: string) => output.split("\0").filter((path) => path.length > 0)

const joinDiffSections = (sections: readonly string[]) =>
  sections
    .map((section) => section.trimEnd())
    .filter((section) => section.length > 0)
    .join("\n")

const localReviewDetail = (diff: LocalReviewDiff, branchName: string | null) => {
  const parsedDiff = parseUnifiedDiff(diff.diff)
  const repoName = basename(diff.rootPath) || diff.rootPath
  return LocalReviewDetail.make({
    rootPath: diff.rootPath,
    repoName,
    branchName,
    baseSha: diff.baseSha,
    headSha: diff.headSha,
    diffHash: diff.diffHash,
    title: "Local changes",
    files: parsedDiff.files.map((file) =>
      PullRequestFile.make({
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status,
      }),
    ),
    fetchedAt: diff.fetchedAt,
  })
}
