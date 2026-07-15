import { execFileSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Fiber, Layer } from "effect"

import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { PullRequestDetail, PullRequestDiff, ReviewActor } from "@diffdash/domain/pull-request"
import { AgentRunId } from "@diffdash/domain/review-agent"
import { PullRequestReviewSnapshot } from "@diffdash/domain/review-context"
import { ReviewKey, ReviewRevision } from "@diffdash/domain/review-identity"
import { ReviewThreadId } from "@diffdash/domain/review-thread"
import { AppConfig } from "./app-config"
import { CliStreamService } from "@diffdash/process/cli-stream"
import { ReviewWorktreePool, ReviewWorktreePoolError } from "./review-worktree-pool"

interface GitFixture {
  readonly root: string
  readonly source: string
  readonly remote: string
  readonly pool: string
  readonly remotePool: string
  readonly baseSha: string
  readonly headSha: string
  readonly secondHeadSha: string
  readonly snapshot: PullRequestReviewSnapshot
  readonly secondSnapshot: PullRequestReviewSnapshot
}

const fixture = Effect.acquireRelease(Effect.sync(makeGitFixture), (value) =>
  Effect.sync(() => rmSync(value.root, { recursive: true, force: true })),
)

describe("ReviewWorktreePool", () => {
  it.scoped(
    "leases the exact PR head without changing the user's checkout and rebuilds it clean",
    () =>
      Effect.gen(function* () {
        const value = yield* fixture
        const beforeBranch = git(value.source, "branch", "--show-current")
        const beforeStatus = git(value.source, "status", "--porcelain", "--untracked-files=all")
        let leasedPath = ""
        const firstUseProgress: string[] = []
        const inheritedGitIndexFile = process.env.GIT_INDEX_FILE
        process.env.GIT_INDEX_FILE = ".git/index"

        yield* Effect.gen(function* () {
          const pool = yield* ReviewWorktreePool
          yield* pool.use(
            {
              runId: AgentRunId.make("run-worktree"),
              threadId: ReviewThreadId.make("thread-worktree"),
              snapshot: value.snapshot,
              sourcePath: value.source,
            },
            (lease) =>
              Effect.promise(async () => {
                leasedPath = lease.localPath
                expect(lease.localPath.startsWith(value.pool)).toBe(true)
                expect(git(lease.localPath, "rev-parse", "HEAD")).toBe(value.headSha)
                expect(git(lease.localPath, "branch", "--show-current")).toBe("")
                expect(await readFile(join(lease.localPath, "tracked.txt"), "utf8")).toBe(
                  "feature\n",
                )

                await writeFile(join(lease.localPath, "tracked.txt"), "contaminated\n")
                await writeFile(join(lease.localPath, "untracked.txt"), "untracked\n")
                await writeFile(join(lease.localPath, "cache.log"), "ignored\n")
              }),
            (stage) => Effect.sync(() => firstUseProgress.push(stage)),
          )
        }).pipe(
          Effect.provide(poolLayer(value)),
          Effect.ensuring(
            Effect.sync(() => {
              if (inheritedGitIndexFile === undefined) delete process.env.GIT_INDEX_FILE
              else process.env.GIT_INDEX_FILE = inheritedGitIndexFile
            }),
          ),
        )

        expect(git(value.source, "branch", "--show-current")).toBe(beforeBranch)
        expect(git(value.source, "status", "--porcelain", "--untracked-files=all")).toBe(
          beforeStatus,
        )
        expect(git(leasedPath, "rev-parse", "HEAD")).toBe(value.headSha)
        expect(git(leasedPath, "branch", "--show-current")).toBe("")
        expect(git(leasedPath, "status", "--porcelain", "--untracked-files=all")).toBe("")
        expect(readFileSync(join(leasedPath, "tracked.txt"), "utf8")).toBe("feature\n")
        expect(() => readFileSync(join(leasedPath, "untracked.txt"), "utf8")).toThrow(/ENOENT/u)
        expect(() => readFileSync(join(leasedPath, "cache.log"), "utf8")).toThrow(/ENOENT/u)
        expect(firstUseProgress).toEqual([
          "reserving-workspace",
          "creating-repository",
          "fetching-pr-head",
          "checking-out-revision",
          "restoring-workspace",
        ])

        const reusedProgress: string[] = []
        yield* Effect.gen(function* () {
          const pool = yield* ReviewWorktreePool
          yield* pool.use(
            {
              runId: AgentRunId.make("run-worktree-reused"),
              threadId: ReviewThreadId.make("thread-worktree-reused"),
              snapshot: value.snapshot,
              sourcePath: value.source,
            },
            () => Effect.void,
            (stage) => Effect.sync(() => reusedProgress.push(stage)),
          )
        }).pipe(Effect.provide(poolLayer(value)))
        expect(reusedProgress).toEqual([
          "reserving-workspace",
          "fetching-pr-head",
          "checking-out-revision",
          "restoring-workspace",
        ])
      }),
  )

  it.scoped("rejects an eleventh lease while all ten global slots are active", () =>
    Effect.gen(function* () {
      const value = yield* fixture
      yield* Effect.promise(async () => {
        await mkdir(value.pool, { recursive: true })
        const now = new Date().toISOString()
        await writeFile(
          join(value.pool, "manifest.json"),
          JSON.stringify({
            version: 1,
            slots: Array.from({ length: 10 }, (_, index) => ({
              id: `slot-${index}`,
              owner: "other",
              repo: `repo-${index}`,
              state: "leased",
              headSha: "head",
              pullRequestNumber: index + 1,
              lastThreadId: null,
              lease: {
                id: `lease-${index}`,
                runId: `run-${index}`,
                threadId: `thread-${index}`,
                instanceId: "active-instance",
                pid: process.pid,
                acquiredAt: now,
              },
              createdAt: now,
              lastUsedAt: now,
              lastError: null,
            })),
          }),
        )
      })

      const error = yield* Effect.gen(function* () {
        const pool = yield* ReviewWorktreePool
        return yield* pool
          .use(
            {
              runId: AgentRunId.make("run-capacity"),
              threadId: ReviewThreadId.make("thread-capacity"),
              snapshot: value.snapshot,
              sourcePath: value.source,
            },
            () => Effect.void,
          )
          .pipe(Effect.flip)
      }).pipe(Effect.provide(poolLayer(value)))

      expect(error).toBeInstanceOf(ReviewWorktreePoolError)
      expect(error).toMatchObject({ code: "capacity" })
    }),
  )

  it.scoped("recovers a dead lease and stale manifest lock before reusing the slot", () =>
    Effect.gen(function* () {
      const value = yield* fixture
      const deadPid = 2_147_483_647
      expect(() => process.kill(deadPid, 0)).toThrow(/ESRCH/u)
      mkdirSync(value.pool, { recursive: true })
      const staleAt = "2000-01-01T00:00:00.000Z"
      writeFileSync(
        join(value.pool, "manifest.json"),
        JSON.stringify({
          version: 1,
          slots: [
            {
              id: "stale-slot",
              owner: "Acme",
              repo: "Widget",
              state: "leased",
              headSha: value.baseSha,
              pullRequestNumber: 1,
              lastThreadId: "thread-stale",
              lease: {
                id: "lease-stale",
                runId: "run-stale",
                threadId: "thread-stale",
                instanceId: "dead-instance",
                pid: deadPid,
                acquiredAt: staleAt,
              },
              createdAt: staleAt,
              lastUsedAt: staleAt,
              lastError: null,
            },
          ],
        }),
      )
      writeFileSync(
        join(value.pool, "manifest.lock"),
        JSON.stringify({ token: "stale-lock", pid: deadPid, createdAt: staleAt }),
      )

      let leasedSlot = ""
      yield* Effect.gen(function* () {
        const pool = yield* ReviewWorktreePool
        yield* pool.use(
          {
            runId: AgentRunId.make("run-recovered"),
            threadId: ReviewThreadId.make("thread-recovered"),
            snapshot: value.snapshot,
            sourcePath: value.source,
          },
          (lease) => Effect.sync(() => (leasedSlot = lease.slotId)),
        )
      }).pipe(Effect.provide(poolLayer(value)))

      const manifest = JSON.parse(readFileSync(join(value.pool, "manifest.json"), "utf8")) as {
        readonly slots: ReadonlyArray<{
          readonly id: string
          readonly state: string
          readonly lease: unknown
          readonly lastThreadId: string | null
        }>
      }
      expect(leasedSlot).toBe("stale-slot")
      expect(manifest.slots).toHaveLength(1)
      expect(manifest.slots[0]).toMatchObject({
        id: "stale-slot",
        state: "available",
        lease: null,
        lastThreadId: "thread-recovered",
      })
      expect(existsSync(join(value.pool, "manifest.lock"))).toBe(false)
    }),
  )

  it.scoped("quarantines a slot when post-provider workspace restoration fails", () =>
    Effect.gen(function* () {
      const value = yield* fixture
      let providerStarted = false

      const error = yield* Effect.gen(function* () {
        const pool = yield* ReviewWorktreePool
        return yield* pool
          .use(
            {
              runId: AgentRunId.make("run-cleanup-failure"),
              threadId: ReviewThreadId.make("thread-cleanup-failure"),
              snapshot: value.snapshot,
              sourcePath: value.source,
            },
            () =>
              Effect.sync(() => {
                providerStarted = true
                rmSync(join(value.pool, "Acme", "Widget", "repository.git"), {
                  recursive: true,
                  force: true,
                })
              }),
          )
          .pipe(Effect.flip)
      }).pipe(Effect.provide(poolLayer(value)))

      const manifest = JSON.parse(readFileSync(join(value.pool, "manifest.json"), "utf8")) as {
        readonly slots: ReadonlyArray<{
          readonly state: string
          readonly lease: unknown
          readonly lastError: string | null
        }>
      }
      expect(providerStarted).toBe(true)
      expect(error).toMatchObject({ code: "cleanup", operation: "release.restore" })
      expect(manifest.slots[0]).toMatchObject({
        state: "quarantined",
        lease: null,
        lastError:
          "DiffDash could not restore its isolated review workspace. The workspace was quarantined and will be rebuilt before reuse.",
      })
    }),
  )

  it.scoped("evicts and reuses the globally oldest idle slot at capacity", () =>
    Effect.gen(function* () {
      const value = yield* fixture
      mkdirSync(value.pool, { recursive: true })
      const slots = Array.from({ length: 10 }, (_, index) => ({
        id: `idle-${index}`,
        owner: "Other",
        repo: `Repo-${index}`,
        state: "available",
        headSha: null,
        pullRequestNumber: null,
        lastThreadId: null,
        lease: null,
        createdAt: new Date(Date.UTC(2000, 0, index + 1)).toISOString(),
        lastUsedAt: new Date(Date.UTC(2000, 0, index + 1)).toISOString(),
        lastError: null,
      }))
      writeFileSync(join(value.pool, "manifest.json"), JSON.stringify({ version: 1, slots }))
      const oldestSentinel = join(value.pool, "Other", "Repo-0", "idle-0", "sentinel")
      mkdirSync(join(value.pool, "Other", "Repo-0", "idle-0"), { recursive: true })
      writeFileSync(oldestSentinel, "remove me")

      let leasedSlot = ""
      yield* Effect.gen(function* () {
        const pool = yield* ReviewWorktreePool
        yield* pool.use(
          {
            runId: AgentRunId.make("run-lru"),
            threadId: ReviewThreadId.make("thread-lru"),
            snapshot: value.snapshot,
            sourcePath: value.source,
          },
          (lease) => Effect.sync(() => (leasedSlot = lease.slotId)),
        )
      }).pipe(Effect.provide(poolLayer(value)))

      const manifest = JSON.parse(readFileSync(join(value.pool, "manifest.json"), "utf8")) as {
        readonly slots: ReadonlyArray<{
          readonly id: string
          readonly owner: string
          readonly repo: string
          readonly state: string
        }>
      }
      expect(leasedSlot).toBe("idle-0")
      expect(manifest.slots).toHaveLength(10)
      expect(manifest.slots.find(({ id }) => id === "idle-0")).toMatchObject({
        owner: "Acme",
        repo: "Widget",
        state: "available",
      })
      expect(existsSync(oldestSentinel)).toBe(false)
      expect(manifest.slots.slice(1).every(({ owner }) => owner === "Other")).toBe(true)
    }),
  )

  it.scoped("rejects malicious manifest slot paths without touching files outside the pool", () =>
    Effect.gen(function* () {
      const value = yield* fixture
      mkdirSync(value.pool, { recursive: true })
      const outsideSentinel = join(value.root, "outside-sentinel")
      writeFileSync(outsideSentinel, "preserve me")
      const now = new Date().toISOString()
      writeFileSync(
        join(value.pool, "manifest.json"),
        JSON.stringify({
          version: 1,
          slots: [
            {
              id: "../../../outside-sentinel",
              owner: "Acme",
              repo: "Widget",
              state: "available",
              headSha: value.headSha,
              pullRequestNumber: 1,
              lastThreadId: null,
              lease: null,
              createdAt: now,
              lastUsedAt: now,
              lastError: null,
            },
          ],
        }),
      )
      let providerStarted = false

      const cause = yield* Effect.gen(function* () {
        const pool = yield* ReviewWorktreePool
        return yield* pool
          .use(
            {
              runId: AgentRunId.make("run-malicious-manifest"),
              threadId: ReviewThreadId.make("thread-malicious-manifest"),
              snapshot: value.snapshot,
              sourcePath: value.source,
            },
            () => Effect.sync(() => (providerStarted = true)),
          )
          .pipe(Effect.sandbox, Effect.flip)
      }).pipe(Effect.provide(poolLayer(value)))
      const error = Cause.squash(cause)

      expect(providerStarted).toBe(false)
      expect(error).toBeInstanceOf(ReviewWorktreePoolError)
      expect(error).toMatchObject({ code: "manifest", operation: "path.segment" })
      expect(readFileSync(outsideSentinel, "utf8")).toBe("preserve me")
    }),
  )

  it.scoped("fails before provider use when the fetched PR head moved", () =>
    Effect.gen(function* () {
      const value = yield* fixture
      const movedSnapshot = PullRequestReviewSnapshot.make({
        ...value.snapshot,
        headRevision: ReviewRevision.make("0000000000000000000000000000000000000000"),
      })
      let providerStarted = false

      const error = yield* Effect.gen(function* () {
        const pool = yield* ReviewWorktreePool
        return yield* pool
          .use(
            {
              runId: AgentRunId.make("run-moved"),
              threadId: ReviewThreadId.make("thread-moved"),
              snapshot: movedSnapshot,
              sourcePath: value.source,
            },
            () =>
              Effect.sync(() => {
                providerStarted = true
              }),
          )
          .pipe(Effect.flip)
      }).pipe(Effect.provide(poolLayer(value)))

      expect(providerStarted).toBe(false)
      expect(error).toMatchObject({ code: "revision-changed" })
      let manifest = JSON.parse(readFileSync(join(value.pool, "manifest.json"), "utf8")) as {
        readonly slots: ReadonlyArray<{ readonly state: string }>
      }
      expect(manifest.slots[0]?.state).toBe("quarantined")

      providerStarted = false
      yield* Effect.gen(function* () {
        const pool = yield* ReviewWorktreePool
        yield* pool.use(
          {
            runId: AgentRunId.make("run-rebuilt"),
            threadId: ReviewThreadId.make("thread-rebuilt"),
            snapshot: value.snapshot,
            sourcePath: value.source,
          },
          () =>
            Effect.sync(() => {
              providerStarted = true
            }),
        )
      }).pipe(Effect.provide(poolLayer(value)))

      expect(providerStarted).toBe(true)
      manifest = JSON.parse(readFileSync(join(value.pool, "manifest.json"), "utf8")) as {
        readonly slots: ReadonlyArray<{ readonly state: string }>
      }
      expect(manifest.slots[0]?.state).toBe("available")
    }),
  )

  it.scoped("clones a remote repository with gh and reuses it across pull requests", () =>
    Effect.gen(function* () {
      const value = yield* fixture
      const binPath = join(value.root, "bin")
      const ghPath = join(binPath, "gh")
      const ghLogPath = join(value.root, "gh.log")
      mkdirSync(binPath)
      writeFileSync(
        ghPath,
        '#!/bin/sh\nprintf "%s\\n" "$3" >> "$DIFFDASH_TEST_GH_LOG"\nexec git clone --bare "$DIFFDASH_TEST_REMOTE" "$4"\n',
      )
      chmodSync(ghPath, 0o755)
      const inheritedPath = process.env.PATH
      const inheritedRemote = process.env.DIFFDASH_TEST_REMOTE
      const inheritedLog = process.env.DIFFDASH_TEST_GH_LOG
      process.env.PATH = `${binPath}:${inheritedPath ?? ""}`
      process.env.DIFFDASH_TEST_REMOTE = value.remote
      process.env.DIFFDASH_TEST_GH_LOG = ghLogPath

      yield* Effect.gen(function* () {
        const pool = yield* ReviewWorktreePool
        yield* pool.use(
          {
            runId: AgentRunId.make("run-unlinked"),
            threadId: ReviewThreadId.make("thread-unlinked"),
            snapshot: value.snapshot,
            sourcePath: null,
          },
          (lease) =>
            Effect.sync(() => {
              expect(lease.localPath.startsWith(value.remotePool)).toBe(true)
              expect(git(lease.localPath, "rev-parse", "HEAD")).toBe(value.headSha)
            }),
        )
        yield* Effect.promise(() => new Promise((resolvePromise) => setTimeout(resolvePromise, 5)))
        yield* pool.use(
          {
            runId: AgentRunId.make("run-unlinked-second"),
            threadId: ReviewThreadId.make("thread-unlinked-second"),
            snapshot: value.secondSnapshot,
            sourcePath: null,
          },
          (lease) =>
            Effect.sync(() => {
              expect(git(lease.localPath, "rev-parse", "HEAD")).toBe(value.secondHeadSha)
              expect(readFileSync(join(lease.localPath, "tracked.txt"), "utf8")).toBe(
                "feature two\n",
              )
            }),
        )

        const leasedPaths: string[] = []
        let releaseConcurrentRuns: (() => void) | undefined
        const concurrentGate = new Promise<void>((resolvePromise) => {
          releaseConcurrentRuns = resolvePromise
        })
        const concurrentRun = (
          snapshot: PullRequestReviewSnapshot,
          runId: string,
          threadId: string,
        ) =>
          pool.use(
            {
              runId: AgentRunId.make(runId),
              threadId: ReviewThreadId.make(threadId),
              snapshot,
              sourcePath: null,
            },
            (lease) =>
              Effect.promise(async () => {
                leasedPaths.push(lease.localPath)
                if (leasedPaths.length === 2) releaseConcurrentRuns?.()
                await concurrentGate
              }),
          )
        yield* Effect.all(
          [
            concurrentRun(value.snapshot, "run-concurrent-one", "thread-concurrent-one"),
            concurrentRun(value.secondSnapshot, "run-concurrent-two", "thread-concurrent-two"),
          ],
          { concurrency: "unbounded" },
        )
        expect(new Set(leasedPaths).size).toBe(2)
      }).pipe(
        Effect.provide(poolLayer(value)),
        Effect.ensuring(
          Effect.sync(() => {
            if (inheritedPath === undefined) delete process.env.PATH
            else process.env.PATH = inheritedPath
            if (inheritedRemote === undefined) delete process.env.DIFFDASH_TEST_REMOTE
            else process.env.DIFFDASH_TEST_REMOTE = inheritedRemote
            if (inheritedLog === undefined) delete process.env.DIFFDASH_TEST_GH_LOG
            else process.env.DIFFDASH_TEST_GH_LOG = inheritedLog
          }),
        ),
      )

      expect(readFileSync(ghLogPath, "utf8").trim().split("\n")).toEqual(["Acme/Widget"])
      const manifest = JSON.parse(
        readFileSync(join(value.remotePool, "manifest.json"), "utf8"),
      ) as {
        readonly repositories: ReadonlyArray<{
          readonly owner: string
          readonly repo: string
          readonly clonedAt: string
          readonly lastUsedAt: string
        }>
        readonly slots: ReadonlyArray<{ readonly pullRequestNumber: number | null }>
      }
      expect(manifest.repositories).toHaveLength(1)
      const repository = manifest.repositories[0]
      expect(repository).toMatchObject({ owner: "Acme", repo: "Widget" })
      if (repository === undefined) throw new Error("Expected remote repository metadata")
      expect(Date.parse(repository.clonedAt)).not.toBeNaN()
      expect(Date.parse(repository.lastUsedAt)).not.toBeNaN()
      expect(repository.lastUsedAt >= repository.clonedAt).toBe(true)
      expect(new Set(manifest.slots.map((slot) => slot.pullRequestNumber))).toEqual(new Set([1, 2]))
      expect(() => readFileSync(join(value.pool, "manifest.json"), "utf8")).toThrow(/ENOENT/u)
    }),
  )

  it.scoped("interrupts remote bootstrap and quarantines the reserved slot", () =>
    Effect.gen(function* () {
      const value = yield* fixture
      const binPath = join(value.root, "interrupt-bin")
      const ghPath = join(binPath, "gh")
      const startedPath = join(value.root, "gh-started")
      mkdirSync(binPath)
      writeFileSync(
        ghPath,
        '#!/bin/sh\nprintf "started\\n" > "$DIFFDASH_TEST_GH_STARTED"\nexec sleep 30\n',
      )
      chmodSync(ghPath, 0o755)
      const inheritedPath = process.env.PATH
      const inheritedStarted = process.env.DIFFDASH_TEST_GH_STARTED
      process.env.PATH = `${binPath}:${inheritedPath ?? ""}`
      process.env.DIFFDASH_TEST_GH_STARTED = startedPath

      yield* Effect.gen(function* () {
        const pool = yield* ReviewWorktreePool
        const fiber = yield* pool
          .use(
            {
              runId: AgentRunId.make("run-interrupted"),
              threadId: ReviewThreadId.make("thread-interrupted"),
              snapshot: value.snapshot,
              sourcePath: null,
            },
            () => Effect.void,
          )
          .pipe(Effect.fork)
        yield* Effect.promise(() => waitForFile(startedPath))
        expect(readFileSync(startedPath, "utf8")).toBe("started\n")
        yield* Fiber.interrupt(fiber)
      }).pipe(
        Effect.provide(poolLayer(value)),
        Effect.ensuring(
          Effect.sync(() => {
            if (inheritedPath === undefined) delete process.env.PATH
            else process.env.PATH = inheritedPath
            if (inheritedStarted === undefined) delete process.env.DIFFDASH_TEST_GH_STARTED
            else process.env.DIFFDASH_TEST_GH_STARTED = inheritedStarted
          }),
        ),
      )

      const manifest = JSON.parse(
        readFileSync(join(value.remotePool, "manifest.json"), "utf8"),
      ) as {
        readonly slots: ReadonlyArray<{
          readonly state: string
          readonly lease: unknown
          readonly lastError: string | null
        }>
      }
      expect(manifest.slots[0]).toMatchObject({
        state: "quarantined",
        lease: null,
        lastError: "Review workspace preparation was interrupted.",
      })
    }),
  )
})

const poolLayer = (value: GitFixture) =>
  ReviewWorktreePool.layer.pipe(
    Layer.provideMerge(CliStreamService.layer),
    Layer.provide(
      AppConfig.layer({
        databasePath: join(value.root, "test.sqlite"),
        settingsPath: join(value.root, "settings.json"),
        tempDir: join(value.root, "temp"),
        remoteWorktreePoolPath: value.remotePool,
        worktreePoolPath: value.pool,
      }),
    ),
  )

function makeGitFixture(): GitFixture {
  const root = mkdtempSync(join(tmpdir(), "diffdash-worktree-pool-"))
  const source = join(root, "source")
  const remote = join(root, "origin.git")
  const pool = join(root, "pool")
  const remotePool = join(root, "remote-pool")

  git(root, "init", source)
  writeFileSync(join(source, ".gitignore"), "*.log\n")
  writeFileSync(join(source, "tracked.txt"), "base\n")
  git(source, "add", ".")
  commit(source, "base")
  const baseSha = git(source, "rev-parse", "HEAD")
  git(root, "clone", "--bare", source, remote)
  git(source, "remote", "add", "origin", remote)

  writeFileSync(join(source, "tracked.txt"), "feature\n")
  git(source, "add", "tracked.txt")
  commit(source, "feature")
  const headSha = git(source, "rev-parse", "HEAD")
  git(source, "push", "origin", `HEAD:refs/pull/1/head`)

  writeFileSync(join(source, "tracked.txt"), "feature two\n")
  git(source, "add", "tracked.txt")
  commit(source, "feature two")
  const secondHeadSha = git(source, "rev-parse", "HEAD")
  git(source, "push", "origin", `HEAD:refs/pull/2/head`)
  git(source, "reset", "--hard", baseSha)
  writeFileSync(join(source, "user-local.txt"), "preserve me\n")

  const diff = `diff --git a/tracked.txt b/tracked.txt
index 1111111..2222222 100644
--- a/tracked.txt
+++ b/tracked.txt
@@ -1 +1 @@
-base
+feature`
  const snapshot = PullRequestReviewSnapshot.make({
    reviewKey: ReviewKey.make("github:acme/widget#1"),
    baseRevision: ReviewRevision.make(baseSha),
    headRevision: ReviewRevision.make(headSha),
    detail: PullRequestDetail.make({
      repoOwner: "Acme",
      repoName: "Widget",
      number: 1,
      title: "Feature",
      body: null,
      author: ReviewActor.make({ login: "octocat" }),
      state: "OPEN",
      url: "https://github.com/acme/widget/pull/1",
      isDraft: false,
      baseRefName: "main",
      baseRefOid: baseSha,
      headRefName: "feature",
      headRefOid: headSha,
      createdAt: null,
      updatedAt: null,
      files: [],
      commits: [],
    }),
    diff: PullRequestDiff.make({
      repoOwner: "Acme",
      repoName: "Widget",
      number: 1,
      headRefOid: headSha,
      diff,
      fetchedAt: new Date().toISOString(),
    }),
    parsedDiff: parseUnifiedDiff(diff),
  })

  const secondSnapshot = PullRequestReviewSnapshot.make({
    ...snapshot,
    reviewKey: ReviewKey.make("github:acme/widget#2"),
    headRevision: ReviewRevision.make(secondHeadSha),
    detail: PullRequestDetail.make({
      ...snapshot.detail,
      number: 2,
      title: "Feature two",
      headRefName: "feature-two",
      headRefOid: secondHeadSha,
    }),
    diff: PullRequestDiff.make({
      ...snapshot.diff,
      number: 2,
      headRefOid: secondHeadSha,
    }),
  })

  return {
    root,
    source,
    remote,
    pool,
    remotePool,
    baseSha,
    headSha,
    secondHeadSha,
    snapshot,
    secondSnapshot,
  }
}

const commit = (cwd: string, message: string) =>
  git(
    cwd,
    "-c",
    "user.name=DiffDash Test",
    "-c",
    "user.email=test@diffdash.dev",
    "commit",
    "-m",
    message,
  )

const git = (cwd: string, ...args: readonly string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: sanitizedGitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()

const sanitizedGitEnvironment = () => {
  const env = { ...process.env }
  for (const key of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
    "GIT_QUARANTINE_PATH",
    "GIT_WORK_TREE",
  ]) {
    delete env[key]
  }
  return env
}

const waitForFile = async (path: string, attemptsRemaining = 100): Promise<void> => {
  if (existsSync(path)) return
  if (attemptsRemaining > 0) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    return waitForFile(path, attemptsRemaining - 1)
  }
  throw new Error(`Timed out waiting for ${path}`)
}
