import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { Context, Effect, Exit, Layer, Option, Schema, Stream } from "effect"

import type { AgentRunId, ReviewAgentProgressStage } from "../../shared/review-agent"
import type { PullRequestReviewSnapshot } from "../../shared/review-context"
import type { ReviewThreadId } from "../../shared/review-thread"
import { AppConfig } from "./app-config"
import { type CliStreamResult, type CliStreamRunner, CliStreamService } from "./cli-stream"

const MANIFEST_VERSION = 1
const MAX_POOL_SLOTS = 10
const LOCK_RETRY_MS = 50
const LOCK_TIMEOUT_MS = 5_000
const GIT_TIMEOUT_MS = 120_000
const REPOSITORY_SCOPED_GIT_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
] as const

const WorktreeLease = Schema.Struct({
  id: Schema.String,
  runId: Schema.String,
  threadId: Schema.String,
  instanceId: Schema.String,
  pid: Schema.Number,
  acquiredAt: Schema.String,
})

const WorktreeSlot = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  repo: Schema.String,
  state: Schema.Literal("preparing", "leased", "cleaning", "available", "quarantined"),
  headSha: Schema.NullOr(Schema.String),
  pullRequestNumber: Schema.NullOr(Schema.Number),
  lastThreadId: Schema.NullOr(Schema.String),
  lease: Schema.NullOr(WorktreeLease),
  createdAt: Schema.String,
  lastUsedAt: Schema.String,
  lastError: Schema.NullOr(Schema.String),
})

const WorktreeManifest = Schema.Struct({
  version: Schema.Literal(MANIFEST_VERSION),
  slots: Schema.Array(WorktreeSlot),
})

type Manifest = typeof WorktreeManifest.Type
type Slot = typeof WorktreeSlot.Type

/** Input required to materialize one exact GitHub pull-request workspace. */
export interface ReviewWorktreeInput {
  readonly runId: AgentRunId
  readonly threadId: ReviewThreadId
  readonly snapshot: PullRequestReviewSnapshot
  readonly sourcePath: string | null
}

/** One exclusively leased, detached review worktree. */
export interface ReviewWorktreeLease {
  readonly localPath: string
  readonly headSha: string
  readonly slotId: string
}

/** Recoverable failures preparing, leasing, or restoring an isolated review workspace. */
export class ReviewWorktreePoolError extends Schema.TaggedError<ReviewWorktreePoolError>()(
  "ReviewWorktreePoolError",
  {
    code: Schema.Literal(
      "link-required",
      "capacity",
      "lock",
      "manifest",
      "git",
      "revision-changed",
      "cleanup",
    ),
    operation: Schema.String,
    reason: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** Executes pull-request agent work inside an exclusively leased managed worktree. */
export class ReviewWorktreePool extends Context.Tag("@diffdash/ReviewWorktreePool")<
  ReviewWorktreePool,
  {
    readonly use: <A, E, R>(
      input: ReviewWorktreeInput,
      run: (lease: ReviewWorktreeLease) => Effect.Effect<A, E, R>,
      onProgress?: (stage: ReviewAgentProgressStage) => Effect.Effect<void>,
    ) => Effect.Effect<A, E | ReviewWorktreePoolError, R>
  }
>() {
  static readonly layer = Layer.effect(
    ReviewWorktreePool,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const cli = yield* CliStreamService
      const poolRoot = resolve(config.worktreePoolPath)
      const instanceId = randomUUID()

      const use = <A, E, R>(
        input: ReviewWorktreeInput,
        run: (lease: ReviewWorktreeLease) => Effect.Effect<A, E, R>,
        onProgress?: (stage: ReviewAgentProgressStage) => Effect.Effect<void>,
      ): Effect.Effect<A, E | ReviewWorktreePoolError, R> => {
        if (input.sourcePath === null) {
          return Effect.fail(
            poolError(
              "link-required",
              "acquire",
              `Link a local checkout for ${input.snapshot.detail.repoOwner}/${input.snapshot.detail.repoName} before running a review agent.`,
              new Error("Repository has no linked checkout"),
            ),
          )
        }

        return Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* reportProgress(onProgress, "reserving-workspace")
            const lease = yield* reserveAndPrepare(poolRoot, instanceId, cli, input, onProgress)
            const runExit = yield* restore(run(lease)).pipe(Effect.exit)
            yield* reportProgress(onProgress, "restoring-workspace")
            const cleanupExit = yield* restoreAndRelease(poolRoot, cli, input, lease).pipe(
              Effect.exit,
            )
            if (Exit.isFailure(cleanupExit)) return yield* Effect.failCause(cleanupExit.cause)
            if (Exit.isFailure(runExit)) return yield* Effect.failCause(runExit.cause)
            return runExit.value
          }),
        )
      }

      return ReviewWorktreePool.of({ use })
    }),
  )
}

interface Reservation {
  readonly slot: Slot
  readonly evicted: Slot | null
}

const reserveAndPrepare = (
  poolRoot: string,
  instanceId: string,
  cli: CliStreamRunner,
  input: ReviewWorktreeInput,
  onProgress?: (stage: ReviewAgentProgressStage) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    yield* fsOperation("mkdir.pool", () => mkdir(poolRoot, { recursive: true, mode: 0o700 }))
    const reservation = yield* mutateManifest(poolRoot, (manifest) =>
      reserveSlot(manifest, instanceId, input),
    )

    const slotPath = pathForSlot(poolRoot, reservation.slot)
    const lease = {
      localPath: slotPath,
      headSha: input.snapshot.headRevision,
      slotId: reservation.slot.id,
    } satisfies ReviewWorktreeLease

    const prepared = prepareSlot(poolRoot, cli, input, reservation, onProgress).pipe(
      Effect.tap(() =>
        mutateManifest(poolRoot, (manifest) => ({
          manifest: updateSlot(manifest, reservation.slot.id, (slot) => ({
            ...slot,
            state: "leased",
            headSha: input.snapshot.headRevision,
            pullRequestNumber: input.snapshot.detail.number,
            lastError: null,
          })),
          value: undefined,
        })),
      ),
      Effect.as(lease),
    )

    return yield* prepared.pipe(
      Effect.catchAll((cause) =>
        mutateManifest(poolRoot, (manifest) => ({
          manifest: updateSlot(manifest, reservation.slot.id, (slot) => ({
            ...slot,
            state: "quarantined",
            lease: null,
            lastError: cause.reason,
          })),
          value: undefined,
        })).pipe(Effect.zipRight(Effect.fail(cause))),
      ),
    )
  })

const prepareSlot = (
  poolRoot: string,
  cli: CliStreamRunner,
  input: ReviewWorktreeInput,
  reservation: Reservation,
  onProgress?: (stage: ReviewAgentProgressStage) => Effect.Effect<void>,
) => {
  const owner = input.snapshot.detail.repoOwner
  const repo = input.snapshot.detail.repoName
  const repositoryRoot = pathForRepository(poolRoot, owner, repo)

  const evicted = reservation.evicted
  const evict =
    evicted === null
      ? Effect.void
      : withFileLock(
          join(pathForRepository(poolRoot, evicted.owner, evicted.repo), "repository.lock"),
          () => evictSlot(poolRoot, cli, evicted),
        )

  return evict.pipe(
    Effect.zipRight(
      withFileLock(join(repositoryRoot, "repository.lock"), () =>
        Effect.gen(function* () {
          const sourcePath = input.sourcePath
          if (sourcePath === null) {
            return yield* poolError(
              "link-required",
              "prepare.source",
              `Link a local checkout for ${owner}/${repo} before running a review agent.`,
              new Error("Repository has no linked checkout"),
            )
          }
          yield* fsOperation("mkdir.repository", () =>
            mkdir(repositoryRoot, { recursive: true, mode: 0o700 }),
          )
          const barePath = join(repositoryRoot, "repository.git")
          const bareExists = yield* pathExists(barePath)
          if (!bareExists) {
            yield* reportProgress(onProgress, "creating-repository")
            yield* runGit(cli, ["clone", "--bare", "--no-hardlinks", "--", sourcePath, barePath])
          }
          const sourceRemote = yield* runGit(cli, ["-C", sourcePath, "remote", "get-url", "origin"])
          yield* runGit(cli, [
            "--git-dir",
            barePath,
            "remote",
            "set-url",
            "origin",
            sourceRemote.stdout.trim(),
          ])

          const pullRef = `refs/diffdash/pull/${input.snapshot.detail.number}/head`
          yield* reportProgress(onProgress, "fetching-pr-head")
          yield* runGit(cli, [
            "--git-dir",
            barePath,
            "fetch",
            "--no-tags",
            "--force",
            "origin",
            `+refs/pull/${input.snapshot.detail.number}/head:${pullRef}`,
          ])
          const fetched = yield* runGit(cli, [
            "--git-dir",
            barePath,
            "rev-parse",
            "--verify",
            `${pullRef}^{commit}`,
          ])
          const fetchedSha = fetched.stdout.trim()
          if (fetchedSha !== input.snapshot.headRevision) {
            return yield* poolError(
              "revision-changed",
              "prepare.verifyRevision",
              "The pull request changed while its isolated workspace was being prepared. Refresh the review and retry.",
              new Error(`Expected ${input.snapshot.headRevision}, fetched ${fetchedSha}`),
            )
          }

          yield* reportProgress(onProgress, "checking-out-revision")
          yield* recreateWorktree(
            cli,
            barePath,
            pathForSlot(poolRoot, reservation.slot),
            fetchedSha,
          )
        }),
      ),
    ),
  )
}

const restoreAndRelease = (
  poolRoot: string,
  cli: CliStreamRunner,
  input: ReviewWorktreeInput,
  lease: ReviewWorktreeLease,
) =>
  Effect.gen(function* () {
    yield* mutateManifest(poolRoot, (manifest) => ({
      manifest: updateSlot(manifest, lease.slotId, (slot) => ({ ...slot, state: "cleaning" })),
      value: undefined,
    }))
    const repositoryRoot = pathForRepository(
      poolRoot,
      input.snapshot.detail.repoOwner,
      input.snapshot.detail.repoName,
    )
    const barePath = join(repositoryRoot, "repository.git")

    const cleanup = withFileLock(join(repositoryRoot, "repository.lock"), () =>
      recreateWorktree(cli, barePath, lease.localPath, lease.headSha),
    ).pipe(
      Effect.mapError((cause) =>
        poolError(
          "cleanup",
          "release.restore",
          "DiffDash could not restore its isolated review workspace. The workspace was quarantined and will not be reused.",
          cause,
        ),
      ),
    )

    return yield* cleanup.pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          mutateManifest(poolRoot, (manifest) => ({
            manifest: updateSlot(manifest, lease.slotId, (slot) => ({
              ...slot,
              state: "quarantined",
              lease: null,
              lastError: cause.reason,
            })),
            value: undefined,
          })).pipe(Effect.zipRight(Effect.fail(cause))),
        onSuccess: () =>
          mutateManifest(poolRoot, (manifest) => ({
            manifest: updateSlot(manifest, lease.slotId, (slot) => ({
              ...slot,
              state: "available",
              lease: null,
              lastThreadId: String(input.threadId),
              lastUsedAt: new Date().toISOString(),
              lastError: null,
            })),
            value: undefined,
          })),
      }),
    )
  })

const recreateWorktree = (
  cli: CliStreamRunner,
  barePath: string,
  worktreePath: string,
  headSha: string,
) =>
  Effect.gen(function* () {
    if (yield* pathExists(worktreePath)) {
      yield* runGit(cli, [
        "--git-dir",
        barePath,
        "worktree",
        "remove",
        "--force",
        worktreePath,
      ]).pipe(Effect.catchAll(() => Effect.void))
      yield* fsOperation("worktree.removeDirectory", () =>
        rm(worktreePath, { recursive: true, force: true }),
      )
    }
    yield* runGit(cli, ["--git-dir", barePath, "worktree", "prune", "--expire", "now"])
    yield* runGit(cli, [
      "--git-dir",
      barePath,
      "worktree",
      "add",
      "--force",
      "--detach",
      worktreePath,
      headSha,
    ])
    yield* verifyWorktree(cli, worktreePath, headSha)
  })

const verifyWorktree = (cli: CliStreamRunner, worktreePath: string, headSha: string) =>
  Effect.gen(function* () {
    const [head, branch, status, clean] = yield* Effect.all([
      runGit(cli, ["-C", worktreePath, "rev-parse", "--verify", "HEAD"]),
      runGit(cli, ["-C", worktreePath, "branch", "--show-current"]),
      runGit(cli, ["-C", worktreePath, "status", "--porcelain", "--untracked-files=all"]),
      runGit(cli, ["-C", worktreePath, "clean", "-ndx"]),
    ])
    if (
      head.stdout.trim() !== headSha ||
      branch.stdout.trim().length > 0 ||
      status.stdout.trim().length > 0 ||
      clean.stdout.trim().length > 0
    ) {
      return yield* poolError(
        "git",
        "worktree.verify",
        "The isolated review workspace could not be verified as clean at the expected revision.",
        new Error("Worktree verification failed"),
      )
    }
  })

const evictSlot = (poolRoot: string, cli: CliStreamRunner, slot: Slot) => {
  const repositoryRoot = pathForRepository(poolRoot, slot.owner, slot.repo)
  const barePath = join(repositoryRoot, "repository.git")
  const slotPath = pathForSlot(poolRoot, slot)
  return Effect.gen(function* () {
    if (yield* pathExists(barePath)) {
      yield* runGit(cli, ["--git-dir", barePath, "worktree", "remove", "--force", slotPath]).pipe(
        Effect.catchAll(() => Effect.void),
      )
      yield* runGit(cli, ["--git-dir", barePath, "worktree", "prune", "--expire", "now"]).pipe(
        Effect.catchAll(() => Effect.void),
      )
    }
    yield* fsOperation("evict.remove", () => rm(slotPath, { recursive: true, force: true }))
  })
}

const reserveSlot = (
  manifest: Manifest,
  instanceId: string,
  input: ReviewWorktreeInput,
): { readonly manifest: Manifest; readonly value: Reservation } => {
  const now = new Date().toISOString()
  const owner = input.snapshot.detail.repoOwner
  const repo = input.snapshot.detail.repoName
  const recovered = manifest.slots.map((slot) =>
    slot.state !== "available" && slot.state !== "quarantined" && !isProcessAlive(slot.lease?.pid)
      ? { ...slot, state: "available" as const, lease: null }
      : slot,
  )
  const available = recovered.filter((slot) => slot.state === "available")
  const preferredCandidates = available.filter((slot) => sameRepository(slot, owner, repo))
  // oxlint-disable-next-line unicorn/no-array-sort -- Sort mutates only the new filtered array.
  preferredCandidates.sort((left, right) => {
    const leftThread = left.lastThreadId === String(input.threadId) ? 0 : 1
    const rightThread = right.lastThreadId === String(input.threadId) ? 0 : 1
    const leftSha = left.headSha === input.snapshot.headRevision ? 0 : 1
    const rightSha = right.headSha === input.snapshot.headRevision ? 0 : 1
    return (
      leftThread - rightThread ||
      leftSha - rightSha ||
      left.lastUsedAt.localeCompare(right.lastUsedAt)
    )
  })
  const preferred = preferredCandidates[0]
  const lruCandidates = [...available]
  // oxlint-disable-next-line unicorn/no-array-sort -- Sort mutates only the new copied array.
  lruCandidates.sort((left, right) => left.lastUsedAt.localeCompare(right.lastUsedAt))
  const lru = lruCandidates[0]
  const existing = preferred ?? (recovered.length >= MAX_POOL_SLOTS ? lru : undefined)

  if (existing === undefined && recovered.length >= MAX_POOL_SLOTS) {
    throw poolError(
      "capacity",
      "reserve",
      "All 10 isolated review worktrees are busy. Wait for another review to finish, then retry.",
      new Error("Worktree pool is at capacity"),
    )
  }

  const id = existing?.id ?? createHash("sha256").update(randomUUID()).digest("hex").slice(0, 12)
  const lease = {
    id: randomUUID(),
    runId: String(input.runId),
    threadId: String(input.threadId),
    instanceId,
    pid: process.pid,
    acquiredAt: now,
  }
  const slot: Slot = {
    id,
    owner,
    repo,
    state: "preparing",
    headSha: input.snapshot.headRevision,
    pullRequestNumber: input.snapshot.detail.number,
    lastThreadId: existing?.lastThreadId ?? null,
    lease,
    createdAt: existing?.createdAt ?? now,
    lastUsedAt: now,
    lastError: null,
  }
  const slots =
    existing === undefined
      ? [...recovered, slot]
      : recovered.map((item) => (item.id === id ? slot : item))
  return {
    manifest: { version: MANIFEST_VERSION, slots },
    value: {
      slot,
      evicted: existing !== undefined && !sameRepository(existing, owner, repo) ? existing : null,
    },
  }
}

const mutateManifest = <A>(
  poolRoot: string,
  change: (manifest: Manifest) => { readonly manifest: Manifest; readonly value: A },
): Effect.Effect<A, ReviewWorktreePoolError> =>
  withFileLock(join(poolRoot, "manifest.lock"), () =>
    Effect.gen(function* () {
      const manifestPath = join(poolRoot, "manifest.json")
      const manifest = yield* readManifest(manifestPath)
      const changed = yield* Effect.try({
        try: () => change(manifest),
        catch: (cause) =>
          cause instanceof ReviewWorktreePoolError
            ? cause
            : poolError(
                "manifest",
                "manifest.change",
                "Could not update the worktree pool manifest.",
                cause,
              ),
      })
      yield* writeManifest(manifestPath, changed.manifest)
      return changed.value
    }),
  )

const readManifest = (manifestPath: string): Effect.Effect<Manifest, ReviewWorktreePoolError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const json = JSON.parse(await readFile(manifestPath, "utf8")) as unknown
        return await Effect.runPromise(Schema.decodeUnknown(WorktreeManifest)(json))
      } catch (cause) {
        if (isNodeError(cause, "ENOENT")) return { version: MANIFEST_VERSION, slots: [] }
        throw cause
      }
    },
    catch: (cause) =>
      poolError(
        "manifest",
        "manifest.read",
        "DiffDash could not read its isolated worktree manifest.",
        cause,
      ),
  })

const writeManifest = (manifestPath: string, manifest: Manifest) =>
  fsOperation("manifest.write", async () => {
    const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    await rename(temporaryPath, manifestPath)
  })

const withFileLock = <A, E, R>(
  lockPath: string,
  use: () => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ReviewWorktreePoolError, R> =>
  Effect.acquireUseRelease(acquireFileLock(lockPath), use, (token) =>
    releaseFileLock(lockPath, token),
  )

const acquireFileLock = (lockPath: string) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
      const token = randomUUID()
      const startedAt = Date.now()
      for (;;) {
        try {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Lock attempts must be serialized.
          const handle = await open(
            lockPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
            0o600,
          )
          // oxlint-disable-next-line eslint/no-await-in-loop -- The acquired handle must be written before closing.
          await handle.writeFile(
            JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }),
          )
          // oxlint-disable-next-line eslint/no-await-in-loop -- Lock publication requires closing this handle first.
          await handle.close()
          return token
        } catch (cause) {
          if (!isNodeError(cause, "EEXIST")) throw cause
          // oxlint-disable-next-line eslint/no-await-in-loop -- Each retry must inspect the current owner.
          const owner = await readLockOwner(lockPath)
          if (owner !== null && !isProcessAlive(owner.pid)) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- A stale lock must be removed before retrying.
            await rm(lockPath, { force: true })
            continue
          }
          if (Date.now() - startedAt >= LOCK_TIMEOUT_MS)
            throw new Error(`Timed out waiting for ${lockPath}`, { cause })
          // oxlint-disable-next-line eslint/no-await-in-loop -- Backoff intentionally precedes the next lock attempt.
          await new Promise((resolvePromise) => setTimeout(resolvePromise, LOCK_RETRY_MS))
        }
      }
    },
    catch: (cause) =>
      poolError(
        "lock",
        "lock.acquire",
        "DiffDash could not lock its isolated worktree pool.",
        cause,
      ),
  })

const releaseFileLock = (lockPath: string, token: string) =>
  Effect.promise(async () => {
    const owner = await readLockOwner(lockPath)
    if (owner?.token === token) await rm(lockPath, { force: true })
  })

const readLockOwner = async (
  lockPath: string,
): Promise<{ readonly token: string; readonly pid: number } | null> => {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as unknown
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "token" in parsed &&
      typeof parsed.token === "string" &&
      "pid" in parsed &&
      typeof parsed.pid === "number"
    ) {
      return { token: parsed.token, pid: parsed.pid }
    }
  } catch {
    const details = await stat(lockPath).catch(() => null)
    if (details !== null && Date.now() - details.mtimeMs > LOCK_TIMEOUT_MS)
      await rm(lockPath, { force: true })
  }
  return null
}

const runGit = (cli: CliStreamRunner, args: readonly string[]) =>
  cli
    .stream("git", args, {
      timeoutMs: GIT_TIMEOUT_MS,
      killAfterMs: 1_000,
      maxOutputBytes: 1024 * 1024,
      env: { GIT_TERMINAL_PROMPT: "0" },
      unsetEnv: REPOSITORY_SCOPED_GIT_ENV,
    })
    .pipe(
      Stream.runLast,
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              poolError(
                "git",
                "git.run",
                "A Git command ended without a result.",
                new Error("No exit event"),
              ),
            ),
          onSome: (event) => {
            const { _tag: tag } = event
            return tag === "CliExit"
              ? Effect.succeed(event.result)
              : Effect.fail(
                  poolError(
                    "git",
                    "git.run",
                    "A Git command ended without an exit event.",
                    new Error(event.line),
                  ),
                )
          },
        }),
      ),
      Effect.mapError((cause) =>
        cause instanceof ReviewWorktreePoolError
          ? cause
          : poolError(
              "git",
              "git.run",
              "DiffDash could not prepare its isolated Git workspace.",
              cause,
            ),
      ),
    ) as Effect.Effect<CliStreamResult, ReviewWorktreePoolError>

const pathExists = (path: string) =>
  Effect.promise(async () => {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  })

const reportProgress = (
  reporter: ((stage: ReviewAgentProgressStage) => Effect.Effect<void>) | undefined,
  stage: ReviewAgentProgressStage,
) => reporter?.(stage) ?? Effect.void

const fsOperation = (operation: string, run: () => Promise<unknown>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      poolError(
        "manifest",
        operation,
        "DiffDash could not update its isolated workspace files.",
        cause,
      ),
  }).pipe(Effect.asVoid)

const updateSlot = (
  manifest: Manifest,
  slotId: string,
  update: (slot: Slot) => Slot,
): Manifest => ({
  ...manifest,
  slots: manifest.slots.map((slot) => (slot.id === slotId ? update(slot) : slot)),
})

const pathForRepository = (poolRoot: string, owner: string, repo: string) => {
  const path = resolve(poolRoot, safeSegment(owner), safeSegment(repo))
  assertContained(poolRoot, path)
  return path
}

const pathForSlot = (poolRoot: string, slot: Pick<Slot, "owner" | "repo" | "id">) => {
  const path = resolve(pathForRepository(poolRoot, slot.owner, slot.repo), safeSegment(slot.id))
  assertContained(poolRoot, path)
  return path
}

const safeSegment = (value: string) => {
  if (!/^[a-zA-Z0-9_.-]+$/u.test(value) || value === "." || value === "..") {
    throw poolError(
      "manifest",
      "path.segment",
      "The repository identity cannot be represented safely in the worktree pool.",
      new Error(`Unsafe path segment: ${value}`),
    )
  }
  return value.toLowerCase()
}

const assertContained = (root: string, path: string) => {
  const child = relative(resolve(root), resolve(path))
  if (child.startsWith("..") || resolve(path) === resolve(root)) {
    throw poolError(
      "manifest",
      "path.containment",
      "A managed worktree path escaped the configured pool root.",
      new Error(path),
    )
  }
}

const sameRepository = (slot: Pick<Slot, "owner" | "repo">, owner: string, repo: string) =>
  slot.owner.toLowerCase() === owner.toLowerCase() && slot.repo.toLowerCase() === repo.toLowerCase()

const isProcessAlive = (pid: number | undefined) => {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return isNodeError(cause, "EPERM")
  }
}

const isNodeError = (cause: unknown, code: string): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause && cause.code === code

const poolError = (
  code: ReviewWorktreePoolError["code"],
  operation: string,
  reason: string,
  cause: unknown,
) => ReviewWorktreePoolError.make({ code, operation, reason, cause })
