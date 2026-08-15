import { createHash } from "node:crypto"

import { Context, Effect, Layer, Schema } from "effect"

import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import {
  ProcessOutputError,
  ProcessService,
  type ProcessExecutionError,
  type ProcessResult,
} from "@diffdash/process"
import { gitProcessRequest } from "./git-environment"

/** Canonical filesystem locations that identify one Git checkout and its shared repository. */
export class CanonicalGitDirectories extends Schema.Class<CanonicalGitDirectories>(
  "CanonicalGitDirectories",
)({
  checkoutRoot: RepositoryCheckoutPath,
  worktreeGitDirectory: RepositoryCheckoutPath,
  commonGitDirectory: RepositoryCheckoutPath,
}) {}

/** Authoritative local Git state used to decide whether repository consumers are stale. */
export class CanonicalGitState extends Schema.Class<CanonicalGitState>("CanonicalGitState")({
  branchIntent: Schema.NullOr(Schema.String),
  resolvedHeadSha: Schema.NullOr(Schema.String),
  status: Schema.String,
  fingerprint: Schema.String,
}) {}

/** Local-only Git inspection used by repository watching; none of its commands contact remotes. */
export class RepositoryReconciler extends Context.Service<
  RepositoryReconciler,
  {
    readonly resolveDirectories: (
      checkoutPath: RepositoryCheckoutPath,
    ) => Effect.Effect<CanonicalGitDirectories, ProcessExecutionError>
    readonly readState: (
      checkoutPath: RepositoryCheckoutPath,
    ) => Effect.Effect<CanonicalGitState, ProcessExecutionError>
  }
>()("@diffdash/RepositoryReconciler") {
  /** Production reconciliation backed exclusively by read-only, repository-local Git commands. */
  static readonly layer = Layer.effect(
    RepositoryReconciler,
    Effect.gen(function* () {
      const processes = yield* ProcessService

      const resolveDirectories = Effect.fn("RepositoryReconciler.resolveDirectories")(function* (
        checkoutPath: RepositoryCheckoutPath,
      ) {
        const result = yield* processes.run(
          gitProcessRequest([
            "-C",
            checkoutPath,
            "rev-parse",
            "--path-format=absolute",
            "--show-toplevel",
            "--absolute-git-dir",
            "--git-common-dir",
          ]),
        )
        const [checkoutRoot, worktreeGitDirectory, commonGitDirectory] = result.stdout
          .trimEnd()
          .split("\n")
        return CanonicalGitDirectories.make({
          checkoutRoot: yield* parsePath(result, checkoutRoot),
          worktreeGitDirectory: yield* parsePath(result, worktreeGitDirectory),
          commonGitDirectory: yield* parsePath(result, commonGitDirectory),
        })
      })

      const optionalGitValue = (args: readonly string[]) =>
        processes.run(gitProcessRequest(args)).pipe(
          Effect.map((result) => result.stdout.trim() || null),
          Effect.catchTag("ProcessExitError", () => Effect.succeed(null)),
        )

      const readState = Effect.fn("RepositoryReconciler.readState")(function* (
        checkoutPath: RepositoryCheckoutPath,
      ) {
        const [branchIntent, resolvedHeadSha, status] = yield* Effect.all(
          [
            optionalGitValue(["-C", checkoutPath, "symbolic-ref", "--quiet", "--short", "HEAD"]),
            optionalGitValue(["-C", checkoutPath, "rev-parse", "--verify", "HEAD"]),
            processes.run(
              gitProcessRequest([
                "-C",
                checkoutPath,
                "status",
                "--porcelain=v2",
                "--branch",
                "--untracked-files=all",
              ]),
            ),
          ],
          { concurrency: 1 },
        )
        const canonicalStatus = status.stdout.trimEnd()
        const fingerprint = createHash("sha256")
          .update(branchIntent ?? "")
          .update("\0")
          .update(resolvedHeadSha ?? "")
          .update("\0")
          .update(canonicalStatus)
          .digest("hex")
        return CanonicalGitState.make({
          branchIntent,
          resolvedHeadSha,
          status: canonicalStatus,
          fingerprint,
        })
      })

      return RepositoryReconciler.of({ resolveDirectories, readState })
    }),
  )
}

const parsePath = (
  result: ProcessResult,
  path: string | undefined,
): Effect.Effect<RepositoryCheckoutPath, ProcessExecutionError> =>
  Schema.decodeUnknownEffect(RepositoryCheckoutPath)(path).pipe(
    Effect.mapError((cause) =>
      // Preserve the process failure vocabulary already used by the package boundary.
      ProcessOutputError.make({
        ...result,
        source: "stdout",
        limit: "io",
        message: "Git returned invalid canonical repository directories.",
        cause: Schema.is(Schema.ErrorInstance())(cause) ? cause : new Error(String(cause)),
      }),
    ),
  )
