import { Context, Effect, Layer, Match, Option, Schema } from "effect"
import { createHash } from "node:crypto"

import {
  type DetectedRepositoryCheckout,
  RepositoryCheckoutPath,
} from "@diffdash/domain/repository"
import { GitCommitSha, RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import {
  BranchComparison,
  LastCommitComparison,
  type LocalReviewComparison,
  LocalReviewTarget,
} from "@diffdash/domain/local-review"
import { ReviewKey, ReviewRevision } from "@diffdash/domain/review-identity"
import {
  ProcessService,
  ProcessOutputError,
  type ProcessResult,
  type ProcessExecutionError,
} from "@diffdash/process"
import { gitProcessRequest } from "./git-environment"

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
/** A requested local comparison branch could not be resolved safely. */
export class LocalReviewTargetError extends Schema.TaggedError<LocalReviewTargetError>()(
  "LocalReviewTargetError",
  {
    operation: Schema.String,
    reason: Schema.String,
    cause: Schema.NullOr(Schema.ErrorInstance()),
  },
) {}

/** One configured local Git remote and all of its fetch URLs. */
export class LocalGitRemote extends Schema.Class<LocalGitRemote>("LocalGitRemote")({
  name: Schema.String,
  fetchUrls: Schema.Array(Schema.String),
}) {}

/** Main-process service for local Git repository inspection. */
export class GitService extends Context.Service<
  GitService,
  {
    readonly detectRepository: (
      localPath: RepositoryCheckoutPath,
    ) => Effect.Effect<DetectedRepositoryCheckout, ProcessExecutionError>
    readonly detectRoot: (
      localPath: RepositoryCheckoutPath,
    ) => Effect.Effect<RepositoryCheckoutPath, ProcessExecutionError>
    readonly currentBranch: (
      localPath: RepositoryCheckoutPath,
    ) => Effect.Effect<RepositoryComparisonRef | null, ProcessExecutionError>
    readonly listRemotes: (
      localPath: RepositoryCheckoutPath,
    ) => Effect.Effect<readonly LocalGitRemote[], ProcessExecutionError>
    readonly resolveBranchComparison: (
      localPath: RepositoryCheckoutPath,
      branchName: RepositoryComparisonRef | null,
    ) => Effect.Effect<LocalReviewTarget, ProcessExecutionError | LocalReviewTargetError>
    readonly resolveLastCommit: (
      localPath: RepositoryCheckoutPath,
    ) => Effect.Effect<LocalReviewTarget, ProcessExecutionError | LocalReviewTargetError>
  }
>()("@diffdash/GitService") {
  static readonly layer = Layer.effect(
    GitService,
    Effect.gen(function* () {
      const processes = yield* ProcessService
      const detectRoot = Effect.fn("GitService.detectRoot")(function* (
        localPath: RepositoryCheckoutPath,
      ) {
        const root = yield* processes.run(
          gitProcessRequest(["-C", localPath, "rev-parse", "--show-toplevel"]),
        )
        return yield* parseCheckoutPath(root)
      })

      const currentBranch = Effect.fn("GitService.currentBranch")(function* (
        localPath: RepositoryCheckoutPath,
      ) {
        const result = yield* processes.run(
          gitProcessRequest(["-C", localPath, "branch", "--show-current"]),
        )
        const branch = result.stdout.trim()
        return branch.length === 0 ? null : yield* parseComparisonRef(result, branch)
      })

      const listRemotes = Effect.fn("GitService.listRemotes")(function* (
        localPath: RepositoryCheckoutPath,
      ) {
        const rootPath = yield* detectRoot(localPath)
        const names = yield* processes.run(gitProcessRequest(["-C", rootPath, "remote"]))
        return yield* Effect.forEach(
          names.stdout
            .split("\n")
            .map((name) => name.trim())
            .filter((name) => name.length > 0),
          (name) =>
            processes
              .run(gitProcessRequest(["-C", rootPath, "remote", "get-url", "--all", name]))
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

      const resolveBranchComparison = Effect.fn("GitService.resolveBranchComparison")(function* (
        localPath: RepositoryCheckoutPath,
        requestedBranchName: RepositoryComparisonRef | null,
      ) {
        const rootPath = yield* detectRoot(localPath)
        const checkedOutBranch = yield* currentBranch(rootPath)
        const branchName = yield* requestedBranchName === null
          ? defaultOriginBranch(rootPath).pipe(Effect.provideService(ProcessService, processes))
          : validateBranchName(rootPath, requestedBranchName).pipe(
              Effect.provideService(ProcessService, processes),
            )
        const baseRef = RepositoryComparisonRef.make(
          checkedOutBranch === branchName
            ? `refs/heads/${branchName}`
            : `refs/remotes/origin/${branchName}`,
        )

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
          comparison: BranchComparison.make({
            branchName,
            baseRef,
            baseSha: ReviewRevision.make(baseSha),
          }),
        })
      })

      const resolveLastCommit = Effect.fn("GitService.resolveLastCommit")(function* (
        localPath: RepositoryCheckoutPath,
      ) {
        const rootPath = yield* detectRoot(localPath)
        const revisions = yield* readLastCommitRevisions(rootPath).pipe(
          Effect.provideService(ProcessService, processes),
        )
        const baseSha = Option.match(revisions.parentSha, {
          onNone: () => ReviewRevision.make(EMPTY_TREE_SHA),
          onSome: ReviewRevision.make,
        })

        return LocalReviewTarget.make({
          kind: "local",
          rootPath,
          comparison: LastCommitComparison.make({
            baseSha,
            headSha: ReviewRevision.make(revisions.headSha),
          }),
        })
      })

      return GitService.of({
        detectRepository: Effect.fn("GitService.detectRepository")(function* (
          localPath: RepositoryCheckoutPath,
        ) {
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
        resolveLastCommit,
      })
    }),
  )
}

type LastCommitRevisions = {
  readonly headSha: GitCommitSha
  readonly parentSha: Option.Option<GitCommitSha>
}

const readLastCommitRevisions = Effect.fn("GitService.readLastCommitRevisions")(function* (
  rootPath: RepositoryCheckoutPath,
) {
  const processes = yield* ProcessService
  const result = yield* processes
    .run(gitProcessRequest(["-C", rootPath, "rev-list", "--parents", "-n", "1", "HEAD"]))
    .pipe(Effect.mapError(lastCommitResolutionError))
  return yield* parseLastCommitRevisions(result.stdout)
})

const parseLastCommitRevisions = Effect.fn("GitService.parseLastCommitRevisions")(function* (
  stdout: string,
) {
  const [head, parent] = stdout.trim().split(/\s+/)
  if (head === undefined || head.length === 0) return yield* lastCommitResolutionError(null)

  const headSha = yield* parseLastCommitRevision(head)
  const parentSha =
    parent === undefined
      ? Option.none<GitCommitSha>()
      : Option.some(yield* parseLastCommitRevision(parent))
  return { headSha, parentSha } satisfies LastCommitRevisions
})

const parseLastCommitRevision = (revision: string) =>
  Schema.decodeUnknownEffect(GitCommitSha)(revision).pipe(
    Effect.mapError((cause) => lastCommitResolutionError(cause)),
  )

const lastCommitResolutionError = (cause: Error | null) =>
  LocalReviewTargetError.make({
    operation: "lastCommit.resolve",
    reason: "The repository does not have a commit to review",
    cause,
  })

const resolveCommitSha = (rootPath: RepositoryCheckoutPath, ref: RepositoryComparisonRef) =>
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
    return yield* parseCommitSha(result)
  })

const resolveMergeBaseSha = (
  rootPath: RepositoryCheckoutPath,
  branchName: RepositoryComparisonRef,
  targetSha: GitCommitSha,
) =>
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
    return yield* parseCommitSha(result).pipe(
      Effect.mapError((cause) =>
        LocalReviewTargetError.make({
          operation: "branch.mergeBase",
          reason: `Branch ${branchName} does not share a common ancestor with the current HEAD`,
          cause,
        }),
      ),
    )
  })

const validateBranchName = (
  rootPath: RepositoryCheckoutPath,
  requestedBranchName: RepositoryComparisonRef,
) =>
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
    return yield* Schema.decodeUnknownEffect(RepositoryComparisonRef)(branchName).pipe(
      Effect.mapError((cause) =>
        LocalReviewTargetError.make({
          operation: "branch.validate",
          reason: "Branch name cannot be empty",
          cause,
        }),
      ),
    )
  })

const defaultOriginBranch = (rootPath: RepositoryCheckoutPath) =>
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
    if (Option.isSome(local)) {
      const branchName = local.value.stdout.trim().replace(/^origin\//, "")
      if (branchName.length > 0) {
        const parsed = yield* parseComparisonRef(local.value, branchName)
        return yield* validateBranchName(rootPath, parsed)
      }
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
    const parsed = yield* parseComparisonRef(remote, match[1])
    return yield* validateBranchName(rootPath, parsed)
  })

/** Creates the stable review identity used by local streaming acquisition. */
export const makeLocalReviewKey = (
  rootPath: RepositoryCheckoutPath,
  comparison: LocalReviewComparison,
): ReviewKey => {
  const rootHash = createHash("sha256").update(rootPath).digest("hex")
  return ReviewKey.make(
    Match.value(comparison).pipe(
      Match.tag("workingTree", () => `local:${rootHash}`),
      Match.tag("branch", (branch) => {
        const refHash = createHash("sha256").update(branch.baseRef).digest("hex")
        return `local:${rootHash}:base:${refHash}`
      }),
      Match.tag("lastCommit", (commit) => `local:${rootHash}:commit:${commit.headSha}`),
      Match.exhaustive,
    ),
  )
}

const parseCheckoutPath = (result: ProcessResult) =>
  Schema.decodeUnknownEffect(RepositoryCheckoutPath)(result.stdout.trim()).pipe(
    Effect.mapError((cause) =>
      invalidStdout(result, "Git returned an invalid checkout path.", cause),
    ),
  )

const parseComparisonRef = (result: ProcessResult, value = result.stdout.trim()) =>
  Schema.decodeUnknownEffect(RepositoryComparisonRef)(value).pipe(
    Effect.mapError((cause) =>
      invalidStdout(result, "Git returned an invalid branch name.", cause),
    ),
  )

const parseCommitSha = (result: ProcessResult) =>
  Schema.decodeUnknownEffect(GitCommitSha)(result.stdout.trim()).pipe(
    Effect.mapError((cause) => invalidStdout(result, "Git returned an invalid commit SHA.", cause)),
  )

const invalidStdout = <A>(result: ProcessResult, message: string, cause: A) =>
  ProcessOutputError.make({
    ...result,
    source: "stdout",
    limit: "io",
    message,
    cause: Schema.is(Schema.ErrorInstance())(cause) ? cause : new Error(String(cause)),
  })
