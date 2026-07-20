import { Context, Effect, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import { basename } from "node:path"

import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { VERY_LARGE_DIFF_CHARACTER_THRESHOLD } from "@diffdash/domain/large-diff-policy"
import { LocalReviewDetail, LocalReviewDiff } from "@diffdash/domain/local-review"
import { ChangedFile } from "@diffdash/domain/git-provider"
import type { DetectedRepositoryCheckout } from "@diffdash/domain/repository"
import {
  BranchComparison,
  type LocalReviewComparison,
  LocalReviewTarget,
  workingTreeReviewTarget,
} from "@diffdash/domain/local-review"
import { LocalReviewSnapshot } from "@diffdash/domain/review-context"
import {
  makeReviewSnapshotId,
  ReviewDiffIdentity,
  ReviewKey,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import {
  ProcessService,
  type ProcessExecutionError,
  type ProcessOutputPolicyInput,
} from "@diffdash/process"
import { gitProcessRequest } from "./git-environment"

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
const COMPLETE_DIFF_STDOUT = {
  maxBytes: VERY_LARGE_DIFF_CHARACTER_THRESHOLD * 4,
  overflow: "error",
} satisfies ProcessOutputPolicyInput

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

/** Test seam for observing local unified-diff parsing without module mocking. */
export interface GitServiceLayerOptions {
  readonly parseDiff?: typeof parseUnifiedDiff
}

/** One configured local Git remote and all of its fetch URLs. */
export class LocalGitRemote extends Schema.Class<LocalGitRemote>("LocalGitRemote")({
  name: Schema.String,
  fetchUrls: Schema.Array(Schema.String),
}) {}

/** Main-process service for local Git repository inspection. */
export class GitService extends Context.Tag("@diffdash/GitService")<
  GitService,
  {
    readonly detectRepository: (
      localPath: string,
    ) => Effect.Effect<DetectedRepositoryCheckout, ProcessExecutionError>
    readonly detectRoot: (localPath: string) => Effect.Effect<string, ProcessExecutionError>
    readonly currentBranch: (localPath: string) => Effect.Effect<string, ProcessExecutionError>
    readonly listRemotes: (
      localPath: string,
    ) => Effect.Effect<readonly LocalGitRemote[], ProcessExecutionError>
    readonly resolveBranchComparison: (
      localPath: string,
      branchName: string | null,
    ) => Effect.Effect<LocalReviewTarget, ProcessExecutionError | LocalReviewTargetError>
    readonly getLocalReviewDetail: (
      target: LocalReviewInput,
    ) => Effect.Effect<LocalReviewDetail, ProcessExecutionError>
    readonly getLocalReviewDiff: (
      target: LocalReviewInput,
    ) => Effect.Effect<LocalReviewDiff, ProcessExecutionError>
    readonly getLocalReviewSnapshot: (
      target: LocalReviewInput,
    ) => Effect.Effect<LocalReviewSnapshot, ProcessExecutionError | LocalReviewChangedError>
  }
>() {
  /** Builds the local Git layer with an optional parser test seam. */
  static readonly layerWith = (options: GitServiceLayerOptions = {}) =>
    Layer.effect(
      GitService,
      Effect.gen(function* () {
        const processes = yield* ProcessService
        const parseDiff = options.parseDiff ?? parseUnifiedDiff
        const detectRoot = Effect.fn("GitService.detectRoot")(function* (localPath: string) {
          const root = yield* processes.run(
            gitProcessRequest(["-C", localPath, "rev-parse", "--show-toplevel"]),
          )
          return root.stdout.trim()
        })

        const currentBranch = Effect.fn("GitService.currentBranch")(function* (localPath: string) {
          const branch = yield* processes.run(
            gitProcessRequest(["-C", localPath, "branch", "--show-current"]),
          )
          return branch.stdout.trim()
        })

        const listRemotes = Effect.fn("GitService.listRemotes")(function* (localPath: string) {
          const rootPath = yield* detectRoot(localPath)
          const names = yield* processes.run(gitProcessRequest(["-C", rootPath, "remote"]))
          return yield* Effect.forEach(
            names.stdout
              .split("\n")
              .map((name) => name.trim())
              .filter((name) => name.length > 0),
            (name) =>
              processes
                .run(
                  gitProcessRequest(["-C", rootPath, "config", "--get-all", `remote.${name}.url`]),
                )
                .pipe(
                  Effect.map((result) =>
                    LocalGitRemote.make({
                      name,
                      fetchUrls: result.stdout
                        .split("\n")
                        .map((url) => url.trim())
                        .filter((url) => url.length > 0),
                    }),
                  ),
                ),
            { concurrency: 1 },
          )
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
            ? defaultOriginBranch(rootPath).pipe(Effect.provideService(ProcessService, processes))
            : validateBranchName(rootPath, requestedBranchName).pipe(
                Effect.provideService(ProcessService, processes),
              )
          const baseRef =
            checkedOutBranch === branchName
              ? `refs/heads/${branchName}`
              : `refs/remotes/origin/${branchName}`

          if (checkedOutBranch !== branchName) {
            yield* processes.run(
              gitProcessRequest(
                [
                  "-C",
                  rootPath,
                  "fetch",
                  "--no-tags",
                  "origin",
                  `+refs/heads/${branchName}:${baseRef}`,
                ],
                { timeoutMs: 60_000 },
              ),
            )
          }
          const targetSha = yield* resolveCommitSha(rootPath, baseRef).pipe(
            Effect.provideService(ProcessService, processes),
          )
          const baseSha = yield* resolveMergeBaseSha(rootPath, branchName, targetSha).pipe(
            Effect.provideService(ProcessService, processes),
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
            Effect.provideService(ProcessService, processes),
          )
          const trackedDiff = yield* localTrackedDiff(rootPath, baseSha).pipe(
            Effect.provideService(ProcessService, processes),
          )
          const untrackedDiff = yield* localUntrackedDiff(rootPath).pipe(
            Effect.provideService(ProcessService, processes),
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
          const parsedDiff = parseDiff(diff.diff)
          const detail = localReviewDetail(diff, branchName, parsedDiff)
          const reviewKey = ReviewKey.make(localReviewKey(diff.rootPath, diff.comparison))
          const baseRevision = ReviewRevision.make(diff.baseSha)
          const headRevision = ReviewRevision.make(diff.headSha)

          return LocalReviewSnapshot.make({
            snapshotId: makeReviewSnapshotId({
              reviewKey,
              baseRevision,
              headRevision,
              diffIdentity: ReviewDiffIdentity.make(diff.diffHash),
            }),
            reviewKey,
            baseRevision,
            headRevision,
            detail,
            diff,
            parsedDiff,
          })
        })

        return GitService.of({
          detectRepository: Effect.fn("GitService.detectRepository")(function* (localPath: string) {
            const rootPath = yield* detectRoot(localPath)
            const remote = yield* processes.run(
              gitProcessRequest(["-C", rootPath, "remote", "get-url", "origin"]),
            )
            return {
              rootPath,
              remoteUrl: remote.stdout.trim(),
            }
          }),
          detectRoot,
          currentBranch,
          listRemotes,
          resolveBranchComparison,
          getLocalReviewDetail: (input) =>
            Effect.gen(function* () {
              const diff = yield* getLocalReviewDiff(input)
              const branchName = yield* currentBranch(diff.rootPath).pipe(
                Effect.map((branch) => (branch.length === 0 ? null : branch)),
                Effect.catchAll(() => Effect.succeed(null)),
              )
              return localReviewDetail(diff, branchName, parseDiff(diff.diff))
            }),
          getLocalReviewDiff,
          getLocalReviewSnapshot,
        })
      }),
    )

  static readonly layer = GitService.layerWith()
}

const currentHeadSha = (rootPath: string) =>
  Effect.gen(function* () {
    const processes = yield* ProcessService
    return yield* processes
      .run(gitProcessRequest(["-C", rootPath, "rev-parse", "--verify", "HEAD"]))
      .pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.catchAll(() => Effect.succeed(null)),
      )
  })

const resolveCommitSha = (rootPath: string, ref: string) =>
  Effect.gen(function* () {
    const processes = yield* ProcessService
    const result = yield* processes.run(
      gitProcessRequest([
        "-C",
        rootPath,
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${ref}^{commit}`,
      ]),
    )
    return result.stdout.trim()
  })

const resolveMergeBaseSha = (rootPath: string, branchName: string, targetSha: string) =>
  Effect.gen(function* () {
    const processes = yield* ProcessService
    const result = yield* processes
      .run(gitProcessRequest(["-C", rootPath, "merge-base", targetSha, "HEAD"]))
      .pipe(
        Effect.catchTag("ProcessExitError", (cause) =>
          Effect.fail<ProcessExecutionError | LocalReviewTargetError>(
            cause.exitCode === 1
              ? LocalReviewTargetError.make({
                  operation: "branch.mergeBase",
                  reason: `Branch ${branchName} does not share a common ancestor with the current HEAD`,
                  cause,
                })
              : cause,
          ),
        ),
      )
    const mergeBaseSha = result.stdout.trim()
    if (mergeBaseSha.length === 0) {
      return yield* LocalReviewTargetError.make({
        operation: "branch.mergeBase",
        reason: `Branch ${branchName} does not share a common ancestor with the current HEAD`,
        cause: null,
      })
    }
    return mergeBaseSha
  })

const localReviewBaseSha = (target: LocalReviewTarget) =>
  target.comparison["_tag"] === "workingTree"
    ? currentHeadSha(target.rootPath)
    : Effect.succeed(target.comparison.baseSha)

const validateBranchName = (rootPath: string, requestedBranchName: string) =>
  Effect.gen(function* () {
    const processes = yield* ProcessService
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
    yield* processes.run(
      gitProcessRequest(["-C", rootPath, "check-ref-format", "--branch", branchName]),
    )
    return branchName
  })

const defaultOriginBranch = (rootPath: string) =>
  Effect.gen(function* () {
    const processes = yield* ProcessService
    const local = yield* processes
      .run(
        gitProcessRequest([
          "-C",
          rootPath,
          "symbolic-ref",
          "--quiet",
          "--short",
          "refs/remotes/origin/HEAD",
        ]),
      )
      .pipe(Effect.option)
    if (local["_tag"] === "Some") {
      const branchName = local.value.stdout.trim().replace(/^origin\//, "")
      if (branchName.length > 0) return yield* validateBranchName(rootPath, branchName)
    }

    const remote = yield* processes.run(
      gitProcessRequest(["-C", rootPath, "ls-remote", "--symref", "origin", "HEAD"], {
        timeoutMs: 30_000,
      }),
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
    const processes = yield* ProcessService
    const args =
      baseSha === null
        ? ["-C", rootPath, "diff", "--cached", "--no-ext-diff", "--"]
        : ["-C", rootPath, "diff", "--no-ext-diff", baseSha, "--"]
    const result = yield* processes.run(
      gitProcessRequest(args, {
        timeoutMs: 60_000,
        stdout: COMPLETE_DIFF_STDOUT,
      }),
    )
    return result.stdout
  })

const localUntrackedDiff = (rootPath: string) =>
  Effect.gen(function* () {
    const processes = yield* ProcessService
    const untracked = yield* processes.run(
      gitProcessRequest(["-C", rootPath, "ls-files", "--others", "--exclude-standard", "-z"], {
        timeoutMs: 20_000,
      }),
    )
    const paths = splitNul(untracked.stdout)
    const diffs = yield* Effect.forEach(paths, (path) => untrackedFileDiff(rootPath, path))
    return joinDiffSections(diffs)
  })

const untrackedFileDiff = (rootPath: string, path: string) =>
  Effect.gen(function* () {
    const processes = yield* ProcessService
    return yield* processes
      .run(
        gitProcessRequest(["diff", "--no-ext-diff", "--no-index", "--", "/dev/null", path], {
          cwd: rootPath,
          timeoutMs: 60_000,
          stdout: COMPLETE_DIFF_STDOUT,
        }),
      )
      .pipe(
        Effect.map((result) => result.stdout),
        Effect.catchTag("ProcessExitError", (error) =>
          error.exitCode === 1 ? Effect.succeed(error.stdout) : Effect.fail(error),
        ),
      )
  })

const splitNul = (output: string) => output.split("\0").filter((path) => path.length > 0)

const joinDiffSections = (sections: readonly string[]) =>
  sections
    .map((section) => section.trimEnd())
    .filter((section) => section.length > 0)
    .join("\n")

const localReviewDetail = (
  diff: LocalReviewDiff,
  branchName: string | null,
  parsedDiff: ReturnType<typeof parseUnifiedDiff>,
) => {
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
      ChangedFile.make({
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
