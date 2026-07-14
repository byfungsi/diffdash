import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import { parseUnifiedDiff } from "../../shared/diff-parser"
import { PullRequestDetail, PullRequestDiff, ReviewActor } from "../../shared/domain"
import { AgentRunId } from "../../shared/review-agent"
import { PullRequestReviewSnapshot } from "../../shared/review-context"
import { ReviewKey, ReviewRevision } from "../../shared/review-identity"
import { ReviewThreadId } from "../../shared/review-thread"
import { AppConfig } from "./app-config"
import { CliStreamService } from "./cli-stream"
import { ReviewWorktreePool, ReviewWorktreePoolError } from "./review-worktree-pool"

interface GitFixture {
  readonly root: string
  readonly source: string
  readonly remote: string
  readonly pool: string
  readonly baseSha: string
  readonly headSha: string
  readonly snapshot: PullRequestReviewSnapshot
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
      const manifest = JSON.parse(readFileSync(join(value.pool, "manifest.json"), "utf8")) as {
        readonly slots: ReadonlyArray<{ readonly state: string }>
      }
      expect(manifest.slots[0]?.state).toBe("quarantined")
    }),
  )

  it.scoped("requires a linked checkout without creating pool metadata", () =>
    Effect.gen(function* () {
      const value = yield* fixture
      const error = yield* Effect.gen(function* () {
        const pool = yield* ReviewWorktreePool
        return yield* pool
          .use(
            {
              runId: AgentRunId.make("run-unlinked"),
              threadId: ReviewThreadId.make("thread-unlinked"),
              snapshot: value.snapshot,
              sourcePath: null,
            },
            () => Effect.void,
          )
          .pipe(Effect.flip)
      }).pipe(Effect.provide(poolLayer(value)))

      expect(error).toMatchObject({ code: "link-required" })
      expect(() => readFileSync(join(value.pool, "manifest.json"), "utf8")).toThrow(/ENOENT/u)
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
        worktreePoolPath: value.pool,
      }),
    ),
  )

function makeGitFixture(): GitFixture {
  const root = mkdtempSync(join(tmpdir(), "diffdash-worktree-pool-"))
  const source = join(root, "source")
  const remote = join(root, "origin.git")
  const pool = join(root, "pool")

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

  return { root, source, remote, pool, baseSha, headSha, snapshot }
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
