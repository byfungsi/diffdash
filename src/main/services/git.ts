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
import {
  BranchComparison,
  type LocalReviewComparison,
  LocalReviewTarget,
  workingTreeReviewTarget,
} from "../../shared/local-review"
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

/** A requested local comparison branch could not be resolved safely. */
export class LocalReviewTargetError extends Schema.TaggedError<LocalReviewTargetError>()(
  "LocalReviewTargetError",
  {
    operation: Schema.String,
    reason: Schema.String,
    cause: Schema.NullOr(Schema.Defect),
  },
) {}

type LocalReviewInput = string | LocalReviewTarget

/** Main-process service for local Git repository inspection. */
export class GitService extends Context.Tag("@diffdash/GitService")<
  GitService,
  {
    readonly detectRepository: (
      localPath: string,
    ) => Effect.Effect<DetectedRepositoryCheckout, CliError>
    readonly detectRoot: (localPath: string) => Effect.Effect<string, CliError>
    readonly currentBranch: (localPath: string) => Effect.Effect<string, CliError>
    readonly resolveBranchComparison: (
      localPath: string,
      branchName: string | null,
    ) => Effect.Effect<LocalReviewTarget, CliError | LocalReviewTargetError>
    readonly getLocalReviewDetail: (
      target: LocalReviewInput,
    ) => Effect.Effect<LocalReviewDetail, CliError>
    readonly getLocalReviewDiff: (
      target: LocalReviewInput,
    ) => Effect.Effect<LocalReviewDiff, CliError>
    readonly getLocalReviewSnapshot: (
      target: LocalReviewInput,
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

      const canonicalTarget = Effect.fn("GitService.canonicalTarget")(function* (
        input: LocalReviewInput,
      ) {
        const target = typeof input === "string" ? workingTreeReviewTarget(input) : input
        const rootPath = yield* detectRoot(target.rootPath)
        return LocalReviewTarget.make({ ...target, rootPath })
      })

      const resolveBranchComparison = Effect.fn("GitService.resolveBranchComparison")(function* (
        localPath: string,
        requestedBranchName: string | null,
      ) {
        const rootPath = yield* detectRoot(localPath)
        const checkedOutBranch = yield* currentBranch(rootPath)
        const branchName = yield* requestedBranchName === null
          ? defaultOriginBranch(rootPath).pipe(Effect.provideService(CliService, cli))
          : validateBranchName(rootPath, requestedBranchName).pipe(
              Effect.provideService(CliService, cli),
            )
        const baseRef =
          checkedOutBranch === branchName
            ? `refs/heads/${branchName}`
            : `refs/remotes/origin/${branchName}`

        if (checkedOutBranch !== branchName) {
          yield* cli.run(
            "git",
            [
              "-C",
              rootPath,
              "fetch",
              "--no-tags",
              "origin",
              `+refs/heads/${branchName}:${baseRef}`,
            ],
            { timeoutMs: 60_000 },
          )
        }
        const baseSha = yield* resolveCommitSha(rootPath, baseRef).pipe(
          Effect.provideService(CliService, cli),
        )

        return LocalReviewTarget.make({
          kind: "local",
          rootPath,
          comparison: BranchComparison.make({ branchName, baseRef, baseSha }),
        })
      })

      const getLocalReviewDiff = Effect.fn("GitService.getLocalReviewDiff")(function* (
        input: LocalReviewInput,
      ) {
        const target = yield* canonicalTarget(input)
        const rootPath = target.rootPath
        const baseSha = yield* localReviewBaseSha(target).pipe(
          Effect.provideService(CliService, cli),
        )
        const trackedDiff = yield* localTrackedDiff(rootPath, baseSha).pipe(
          Effect.provideService(CliService, cli),
        )
        const untrackedDiff = yield* localUntrackedDiff(rootPath).pipe(
          Effect.provideService(CliService, cli),
        )
        const diff = joinDiffSections([trackedDiff, untrackedDiff])
        const diffHash = localDiffHash(target.comparison, baseSha ?? EMPTY_TREE_SHA, diff)

        return LocalReviewDiff.make({
          rootPath,
          comparison: target.comparison,
          baseSha: baseSha ?? EMPTY_TREE_SHA,
          headSha: diffHash,
          diffHash,
          diff,
          fetchedAt: new Date().toISOString(),
        })
      })

      const getLocalReviewSnapshot = Effect.fn("GitService.getLocalReviewSnapshot")(function* (
        input: LocalReviewInput,
      ) {
        const target = yield* canonicalTarget(input)
        let diff: LocalReviewDiff | null = null
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const before = yield* getLocalReviewDiff(target)
          const after = yield* getLocalReviewDiff(target)
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
          return yield* LocalReviewChangedError.make({ rootPath: target.rootPath })
        }
        const branchName = yield* currentBranch(diff.rootPath).pipe(
          Effect.map((branch) => (branch.length === 0 ? null : branch)),
          Effect.catchAll(() => Effect.succeed(null)),
        )
        const parsedDiff = parseUnifiedDiff(diff.diff)
        const detail = localReviewDetail(diff, branchName)

        return LocalReviewSnapshot.make({
          reviewKey: ReviewKey.make(localReviewKey(diff.rootPath, diff.comparison)),
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
        resolveBranchComparison,
        getLocalReviewDetail: (input) =>
          Effect.gen(function* () {
            const diff = yield* getLocalReviewDiff(input)
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

const resolveCommitSha = (rootPath: string, ref: string) =>
  Effect.gen(function* () {
    const cli = yield* CliService
    const result = yield* cli.run("git", [
      "-C",
      rootPath,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ])
    return result.stdout.trim()
  })

const localReviewBaseSha = (target: LocalReviewTarget) =>
  target.comparison["_tag"] === "workingTree"
    ? currentHeadSha(target.rootPath)
    : Effect.succeed(target.comparison.baseSha)

const validateBranchName = (rootPath: string, requestedBranchName: string) =>
  Effect.gen(function* () {
    const cli = yield* CliService
    const branchName = requestedBranchName.startsWith("origin/")
      ? requestedBranchName.slice("origin/".length)
      : requestedBranchName
    if (branchName.length === 0) {
      return yield* LocalReviewTargetError.make({
        operation: "branch.validate",
        reason: "Branch name cannot be empty",
        cause: null,
      })
    }
    yield* cli.run("git", ["-C", rootPath, "check-ref-format", "--branch", branchName])
    return branchName
  })

const defaultOriginBranch = (rootPath: string) =>
  Effect.gen(function* () {
    const cli = yield* CliService
    const local = yield* cli
      .run("git", [
        "-C",
        rootPath,
        "symbolic-ref",
        "--quiet",
        "--short",
        "refs/remotes/origin/HEAD",
      ])
      .pipe(Effect.option)
    if (local["_tag"] === "Some") {
      const branchName = local.value.stdout.trim().replace(/^origin\//, "")
      if (branchName.length > 0) return yield* validateBranchName(rootPath, branchName)
    }

    const remote = yield* cli.run(
      "git",
      ["-C", rootPath, "ls-remote", "--symref", "origin", "HEAD"],
      {
        timeoutMs: 30_000,
      },
    )
    const match = /^ref:\s+refs\/heads\/([^\t\n]+)\s+HEAD$/m.exec(remote.stdout)
    if (match?.[1] === undefined) {
      return yield* LocalReviewTargetError.make({
        operation: "branch.default",
        reason: "Could not determine the default branch for origin",
        cause: null,
      })
    }
    return yield* validateBranchName(rootPath, match[1])
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
    comparison: diff.comparison,
    baseSha: diff.baseSha,
    headSha: diff.headSha,
    diffHash: diff.diffHash,
    title:
      diff.comparison["_tag"] === "workingTree"
        ? "Local changes"
        : `Changes vs ${diff.comparison.branchName}`,
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

const localDiffHash = (comparison: LocalReviewComparison, baseSha: string, diff: string) => {
  const hash = createHash("sha256")
  if (comparison["_tag"] === "branch") {
    hash.update("branch\0").update(comparison.baseRef).update("\0").update(baseSha).update("\0")
  }
  return hash.update(diff).digest("hex")
}

const localReviewKey = (rootPath: string, comparison: LocalReviewComparison) => {
  const rootHash = createHash("sha256").update(rootPath).digest("hex")
  if (comparison["_tag"] === "workingTree") return `local:${rootHash}`
  const refHash = createHash("sha256").update(comparison.baseRef).digest("hex")
  return `local:${rootHash}:base:${refHash}`
}
