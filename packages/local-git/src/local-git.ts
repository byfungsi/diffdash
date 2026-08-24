import {
  Array as EffectArray,
  Context,
  Effect,
  Layer,
  Match,
  Option,
  Schema,
  SchemaGetter,
} from "effect"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  type DetectedRepositoryCheckout,
  RepositoryCheckoutPath,
} from "@diffdash/domain/repository"
import { DiffFileStatus } from "@diffdash/domain/diff"
import {
  codeLineChangesFromHunks,
  type CodeLineChangeRange,
} from "@diffdash/domain/code-line-change"
import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { GitCommitSha, RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import {
  BranchComparison,
  LastCommitComparison,
  type LocalReviewComparison,
  LocalReviewTarget,
  RevisionComparison,
  RevisionRangeComparison,
} from "@diffdash/domain/local-review"
import { ReviewKey, ReviewRevision } from "@diffdash/domain/review-identity"
import {
  ProcessService,
  ProcessOutputError,
  type ProcessResult,
  type ProcessExecutionError,
} from "@diffdash/process"
import { gitProcessRequest } from "./git-environment"
import { toError } from "./hosted-review-workspace-pool-error"

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

const GitWorkingTreeStatus = Schema.TaggedUnion({
  added: { code: Schema.String },
  deleted: { code: Schema.String },
  renamed: { code: Schema.String },
  modified: { code: Schema.String },
})

const GitWorkingTreeStatusFromCode = Schema.String.pipe(
  Schema.decodeTo(GitWorkingTreeStatus, {
    decode: SchemaGetter.transform((code) => {
      if (code === "??" || code.includes("A")) {
        return GitWorkingTreeStatus.cases.added.make({ code })
      }
      if (code.includes("D")) return GitWorkingTreeStatus.cases.deleted.make({ code })
      if (code.includes("R") || code.includes("C")) {
        return GitWorkingTreeStatus.cases.renamed.make({ code })
      }
      return GitWorkingTreeStatus.cases.modified.make({ code })
    }),
    encode: SchemaGetter.transform((status) =>
      GitWorkingTreeStatus.match(status, {
        added: ({ code }) => code,
        deleted: ({ code }) => code,
        renamed: ({ code }) => code,
        modified: ({ code }) => code,
      }),
    ),
  }),
)

/** The local review changed after its immutable coordinates were resolved. */
export class LocalReviewChangedError extends Schema.TaggedError<LocalReviewChangedError>()(
  "LocalReviewChangedError",
  { rootPath: RepositoryCheckoutPath },
) {}

/** A requested local comparison branch could not be resolved safely. */
export class LocalReviewTargetError extends Schema.TaggedError<LocalReviewTargetError>()(
  "LocalReviewTargetError",
  {
    operation: Schema.String,
    reason: Schema.String,
    cause: Schema.NullOr(Schema.ErrorInstance()),
  },
) {}

/** Temporary patch materialization failed before Git could consume its content. */
export class WorkspacePatchError extends Schema.TaggedError<WorkspacePatchError>()(
  "WorkspacePatchError",
  {
    operation: Schema.Literals(["create", "write", "remove"]),
    cause: Schema.ErrorInstance(),
  },
) {}

/** One configured local Git remote and all of its fetch URLs. */
export class LocalGitRemote extends Schema.Class<LocalGitRemote>("LocalGitRemote")({
  name: Schema.String,
  fetchUrls: Schema.Array(Schema.String),
}) {}

/** One worktree registered in a local Git repository. */
export class LocalGitWorktree extends Schema.Class<LocalGitWorktree>("LocalGitWorktree")({
  path: RepositoryCheckoutPath,
  isMain: Schema.Boolean,
  isBare: Schema.Boolean,
  isPrunable: Schema.Boolean,
}) {}

/** One changed file reported by a linked repository working tree. */
export class LocalGitWorkingTreeChange extends Schema.Class<LocalGitWorkingTreeChange>(
  "LocalGitWorkingTreeChange",
)({
  path: RepositoryRelativePath,
  status: DiffFileStatus,
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
    readonly listWorktrees: (
      localPath: RepositoryCheckoutPath,
    ) => Effect.Effect<readonly LocalGitWorktree[], ProcessExecutionError>
    readonly workingTreeChanges: (
      localPath: RepositoryCheckoutPath,
    ) => Effect.Effect<readonly LocalGitWorkingTreeChange[], ProcessExecutionError>
    readonly workingTreeFileLineChanges: (
      localPath: RepositoryCheckoutPath,
      path: RepositoryRelativePath,
    ) => Effect.Effect<readonly CodeLineChangeRange[], ProcessExecutionError>
    readonly applyWorkspacePatch: (
      localPath: RepositoryCheckoutPath,
      patch: Uint8Array,
    ) => Effect.Effect<void, ProcessExecutionError | WorkspacePatchError>
    readonly resolveBranchComparison: (
      localPath: RepositoryCheckoutPath,
      branchName: RepositoryComparisonRef | null,
    ) => Effect.Effect<LocalReviewTarget, ProcessExecutionError | LocalReviewTargetError>
    readonly resolveRevisionRangeComparison: (
      localPath: RepositoryCheckoutPath,
      baseRef: RepositoryComparisonRef,
      headRef: RepositoryComparisonRef,
    ) => Effect.Effect<LocalReviewTarget, ProcessExecutionError | LocalReviewTargetError>
    readonly resolveLastCommit: (
      localPath: RepositoryCheckoutPath,
    ) => Effect.Effect<LocalReviewTarget, ProcessExecutionError | LocalReviewTargetError>
    readonly validateLocalReviewTarget: (
      target: LocalReviewTarget,
    ) => Effect.Effect<LocalReviewTarget, ProcessExecutionError | LocalReviewChangedError>
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

      const listWorktrees = Effect.fn("GitService.listWorktrees")(function* (
        localPath: RepositoryCheckoutPath,
      ) {
        const result = yield* processes.run(
          gitProcessRequest(["-C", localPath, "worktree", "list", "--porcelain", "-z"]),
        )
        const records = result.stdout.split("\0\0").filter((record) => record.length > 0)
        return yield* Effect.forEach(records, (record, index) => {
          const fields = record.split("\0")
          const pathField = fields.find((field) => field.startsWith("worktree "))
          return Schema.decodeUnknownEffect(LocalGitWorktree)({
            path: pathField?.slice("worktree ".length),
            isMain: index === 0,
            isBare: fields.includes("bare"),
            isPrunable: fields.some(
              (field) => field === "prunable" || field.startsWith("prunable "),
            ),
          }).pipe(
            Effect.mapError((cause) =>
              invalidStdout(result, "Git returned invalid worktree porcelain output.", cause),
            ),
          )
        })
      })

      const workingTreeChanges = Effect.fn("GitService.workingTreeChanges")(function* (
        localPath: RepositoryCheckoutPath,
      ) {
        const result = yield* processes.run(
          gitProcessRequest([
            "-C",
            localPath,
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
          ]),
        )
        return yield* parseWorkingTreeChanges(result)
      })

      const workingTreeFileLineChanges = Effect.fn("GitService.workingTreeFileLineChanges")(
        function* (localPath: RepositoryCheckoutPath, path: RepositoryRelativePath) {
          const tracked = yield* processes.run(
            gitProcessRequest([
              "-C",
              localPath,
              "diff",
              "--no-ext-diff",
              "--no-color",
              "--unified=0",
              "HEAD",
              "--",
              path,
            ]),
          )
          if (tracked.stdout.length > 0) {
            return Option.match(
              EffectArray.findFirst(
                parseUnifiedDiff(tracked.stdout).files,
                (candidate) => candidate.path === path,
              ),
              { onNone: () => [], onSome: (file) => codeLineChangesFromHunks(file.hunks) },
            )
          }
          const status = yield* processes.run(
            gitProcessRequest([
              "-C",
              localPath,
              "status",
              "--porcelain=v1",
              "-z",
              "--untracked-files=all",
              "--",
              path,
            ]),
          )
          if (!status.stdout.startsWith("?? ")) return []
          const untracked = yield* processes
            .run(
              gitProcessRequest(
                [
                  "diff",
                  "--no-ext-diff",
                  "--no-color",
                  "--unified=0",
                  "--no-index",
                  "--",
                  "/dev/null",
                  path,
                ],
                { cwd: localPath },
              ),
            )
            .pipe(
              Effect.catchTag("ProcessExitError", (error) => {
                if (error.exitCode === 1) return Effect.succeed(error)
                return Effect.fail(error)
              }),
            )
          return Option.match(
            EffectArray.findFirst(
              parseUnifiedDiff(untracked.stdout).files,
              (candidate) => candidate.path === path,
            ),
            { onNone: () => [], onSome: (file) => codeLineChangesFromHunks(file.hunks) },
          )
        },
      )

      const applyWorkspacePatch = Effect.fn("GitService.applyWorkspacePatch")(
        (localPath: RepositoryCheckoutPath, patch: Uint8Array) =>
          Effect.scoped(
            Effect.gen(function* () {
              const directory = yield* Effect.acquireRelease(
                Effect.tryPromise({
                  try: () => mkdtemp(join(tmpdir(), "diffdash-workspace-patch-")),
                  catch: (cause) =>
                    WorkspacePatchError.make({ operation: "create", cause: toError(cause) }),
                }),
                (path) =>
                  Effect.tryPromise({
                    try: () => rm(path, { force: true, recursive: true }),
                    catch: (cause) =>
                      WorkspacePatchError.make({ operation: "remove", cause: toError(cause) }),
                  }).pipe(Effect.ignore),
              )
              const patchFilePath = join(directory, "workspace.patch")
              yield* Effect.tryPromise({
                try: () => writeFile(patchFilePath, patch),
                catch: (cause) =>
                  WorkspacePatchError.make({ operation: "write", cause: toError(cause) }),
              })
              yield* processes.run(
                gitProcessRequest(
                  [
                    "-C",
                    localPath,
                    "apply",
                    "--binary",
                    "--whitespace=nowarn",
                    "--",
                    patchFilePath,
                  ],
                  { timeoutMs: 60_000 },
                ),
              )
            }),
          ),
      )

      const resolveBranchComparison = Effect.fn("GitService.resolveBranchComparison")(function* (
        localPath: RepositoryCheckoutPath,
        requestedBranchName: RepositoryComparisonRef | null,
      ) {
        const rootPath = yield* detectRoot(localPath)
        const checkedOutBranch = yield* currentBranch(rootPath)
        const directRevision =
          requestedBranchName === null
            ? Option.none<GitCommitSha>()
            : yield* resolveDirectRevision(rootPath, requestedBranchName).pipe(
                Effect.provideService(ProcessService, processes),
              )
        if (requestedBranchName !== null && Option.isSome(directRevision)) {
          const baseSha = yield* resolveMergeBaseSha(
            rootPath,
            requestedBranchName,
            directRevision.value,
          ).pipe(Effect.provideService(ProcessService, processes))
          return LocalReviewTarget.make({
            kind: "local",
            rootPath,
            comparison: RevisionComparison.make({
              revision: requestedBranchName,
              baseSha: ReviewRevision.make(baseSha),
            }),
          })
        }
        const branchName = yield* requestedBranchName === null
          ? defaultOriginBranch(rootPath).pipe(Effect.provideService(ProcessService, processes))
          : validateBranchName(rootPath, requestedBranchName).pipe(
              Effect.provideService(ProcessService, processes),
            )
        let baseRef = RepositoryComparisonRef.make(
          checkedOutBranch === branchName
            ? `refs/heads/${branchName}`
            : `refs/remotes/origin/${branchName}`,
        )

        let targetSha = Option.none<GitCommitSha>()
        if (requestedBranchName !== null && checkedOutBranch !== branchName) {
          const localRef = RepositoryComparisonRef.make(`refs/heads/${branchName}`)
          targetSha = yield* resolveOptionalCommitSha(rootPath, localRef).pipe(
            Effect.provideService(ProcessService, processes),
          )
          if (Option.isSome(targetSha)) baseRef = localRef
          if (Option.isNone(targetSha)) {
            const tagRef = RepositoryComparisonRef.make(`refs/tags/${branchName}`)
            const tagSha = yield* resolveOptionalCommitSha(rootPath, tagRef).pipe(
              Effect.provideService(ProcessService, processes),
            )
            if (Option.isSome(tagSha)) {
              const baseSha = yield* resolveMergeBaseSha(
                rootPath,
                requestedBranchName,
                tagSha.value,
              ).pipe(Effect.provideService(ProcessService, processes))
              return LocalReviewTarget.make({
                kind: "local",
                rootPath,
                comparison: RevisionComparison.make({
                  revision: requestedBranchName,
                  baseSha: ReviewRevision.make(baseSha),
                }),
              })
            }
          }
        }

        if (checkedOutBranch !== branchName && Option.isNone(targetSha)) {
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
          targetSha = Option.some(
            yield* resolveCommitSha(rootPath, baseRef).pipe(
              Effect.provideService(ProcessService, processes),
            ),
          )
        }
        if (Option.isNone(targetSha)) {
          targetSha = Option.some(
            yield* resolveCommitSha(rootPath, baseRef).pipe(
              Effect.provideService(ProcessService, processes),
            ),
          )
        }
        const baseSha = yield* resolveMergeBaseSha(
          rootPath,
          branchName,
          Option.getOrThrow(targetSha),
        ).pipe(Effect.provideService(ProcessService, processes))

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

      const resolveRevisionRangeComparison = Effect.fn("GitService.resolveRevisionRangeComparison")(
        function* (
          localPath: RepositoryCheckoutPath,
          baseRef: RepositoryComparisonRef,
          headRef: RepositoryComparisonRef,
        ) {
          const rootPath = yield* detectRoot(localPath)
          const baseSha = yield* resolveRequiredRevision(rootPath, baseRef).pipe(
            Effect.provideService(ProcessService, processes),
          )
          const headSha = yield* resolveRequiredRevision(rootPath, headRef).pipe(
            Effect.provideService(ProcessService, processes),
          )
          yield* ensureRevisionRangeCheckout(rootPath, headSha).pipe(
            Effect.provideService(ProcessService, processes),
          )
          const mergeBaseSha = yield* resolveMergeBaseSha(rootPath, baseRef, baseSha, headSha).pipe(
            Effect.provideService(ProcessService, processes),
          )
          return LocalReviewTarget.make({
            kind: "local",
            rootPath,
            comparison: RevisionRangeComparison.make({
              baseRef,
              headRef,
              baseSha: ReviewRevision.make(baseSha),
              headSha: ReviewRevision.make(headSha),
              mergeBaseSha: ReviewRevision.make(mergeBaseSha),
            }),
          })
        },
      )

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

      const validateLocalReviewTarget = Effect.fn("GitService.validateLocalReviewTarget")(
        function* (target: LocalReviewTarget) {
          const rootPath = yield* detectRoot(target.rootPath)
          const canonical = LocalReviewTarget.make({ ...target, rootPath })
          if (Schema.is(RevisionRangeComparison)(canonical.comparison)) {
            yield* ensureRevisionRangeCheckout(rootPath, canonical.comparison.headSha).pipe(
              Effect.catchTag("LocalReviewTargetError", () =>
                LocalReviewChangedError.make({ rootPath }),
              ),
              Effect.provideService(ProcessService, processes),
            )
          }
          return canonical
        },
      )

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
        listWorktrees,
        applyWorkspacePatch,
        workingTreeChanges,
        workingTreeFileLineChanges,
        resolveBranchComparison,
        resolveRevisionRangeComparison,
        resolveLastCommit,
        validateLocalReviewTarget,
      })
    }),
  )
}

const parseWorkingTreeChanges = Effect.fn("GitService.parseWorkingTreeChanges")(function* (
  result: ProcessResult,
) {
  const fields = result.stdout.split("\0")
  const parseFrom = (
    index: number,
  ): Effect.Effect<readonly LocalGitWorkingTreeChange[], ProcessExecutionError> =>
    Effect.gen(function* () {
      if (index >= fields.length) return []
      const field = Option.getOrElse(EffectArray.get(fields, index), () => "")
      if (field.length === 0) return yield* parseFrom(index + 1)
      if (field.length < 4 || field[2] !== " ") {
        return yield* Effect.fail(
          invalidStdout(
            result,
            "Git returned invalid working-tree status output.",
            new Error("Malformed porcelain record"),
          ),
        )
      }
      const code = field.slice(0, 2)
      if (code === "!!") return yield* parseFrom(index + 1)
      const workingTreeStatus = yield* Schema.decodeUnknownEffect(GitWorkingTreeStatusFromCode)(
        code,
      ).pipe(
        Effect.mapError((cause) =>
          invalidStdout(result, "Git returned an invalid working-tree status.", cause),
        ),
      )
      const path = yield* Schema.decodeUnknownEffect(RepositoryRelativePath)(field.slice(3)).pipe(
        Effect.mapError((cause) =>
          invalidStdout(result, "Git returned an invalid working-tree path.", cause),
        ),
      )
      const status = GitWorkingTreeStatus.match(workingTreeStatus, {
        added: () => "added" as const,
        deleted: () => "deleted" as const,
        renamed: () => "renamed" as const,
        modified: () => "modified" as const,
      })
      const nextIndex = status === "renamed" ? index + 2 : index + 1
      if (status === "renamed") {
        if (
          Option.match(EffectArray.get(fields, index + 1), {
            onNone: () => true,
            onSome: (value) => value.length === 0,
          })
        ) {
          return yield* Effect.fail(
            invalidStdout(
              result,
              "Git returned invalid working-tree rename output.",
              new Error("Missing rename source path"),
            ),
          )
        }
      }
      return EffectArray.prepend(
        yield* parseFrom(nextIndex),
        LocalGitWorkingTreeChange.make({ path, status }),
      )
    })
  return yield* parseFrom(0)
})

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

const resolveOptionalCommitSha = (rootPath: RepositoryCheckoutPath, ref: RepositoryComparisonRef) =>
  resolveCommitSha(rootPath, ref).pipe(
    Effect.map(Option.some),
    Effect.catchTag("ProcessExitError", () => Effect.succeed(Option.none<GitCommitSha>())),
  )

const resolveRequiredRevision = (rootPath: RepositoryCheckoutPath, ref: RepositoryComparisonRef) =>
  resolveCommitSha(rootPath, ref).pipe(
    Effect.mapError((cause) =>
      LocalReviewTargetError.make({
        operation: "revision.resolve",
        reason: `Revision ${ref} was not found in the local repository`,
        cause,
      }),
    ),
  )

const resolveDirectRevision = (
  rootPath: RepositoryCheckoutPath,
  ref: RepositoryComparisonRef,
): Effect.Effect<
  Option.Option<GitCommitSha>,
  LocalReviewTargetError | ProcessExecutionError,
  ProcessService
> =>
  ref === "HEAD" || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(ref) || ref.startsWith("refs/")
    ? resolveRequiredRevision(rootPath, ref).pipe(Effect.map(Option.some))
    : Effect.succeed(Option.none())

const resolveMergeBaseSha = (
  rootPath: RepositoryCheckoutPath,
  branchName: RepositoryComparisonRef,
  targetSha: GitCommitSha,
  headRevision: GitCommitSha | "HEAD" = "HEAD",
) =>
  Effect.gen(function* () {
    const processes = yield* ProcessService
    const result = yield* processes
      .run(gitProcessRequest(["-C", rootPath, "merge-base", targetSha, headRevision]))
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

const ensureRevisionRangeCheckout = (rootPath: RepositoryCheckoutPath, headSha: string) =>
  Effect.gen(function* () {
    const processes = yield* ProcessService
    const checkoutHead = yield* resolveCommitSha(rootPath, RepositoryComparisonRef.make("HEAD"))
    const status = yield* processes.run(
      gitProcessRequest(["-C", rootPath, "status", "--porcelain", "--untracked-files=all"]),
    )
    if (checkoutHead !== headSha || status.stdout.trim().length > 0) {
      return yield* LocalReviewTargetError.make({
        operation: "revisionRange.checkout",
        reason:
          "Local repository comparisons require the requested head to be checked out with no local changes",
        cause: null,
      })
    }
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
      Match.tag("revision", (revision) => {
        const refHash = createHash("sha256").update(revision.revision).digest("hex")
        return `local:${rootHash}:revision:${refHash}`
      }),
      Match.tag(
        "revisionRange",
        (range) =>
          `local:${rootHash}:range:${range.baseSha}:${range.headSha}:${range.mergeBaseSha}`,
      ),
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
