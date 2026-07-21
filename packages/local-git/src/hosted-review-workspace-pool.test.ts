import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Fiber, Layer, TestLive } from "effect"

import {
  GitProviderId,
  HostedRepositoryLocator,
  HostedRepositoryName,
  HostedReviewLocator,
  HostedReviewNumber,
  RepositoryNamespace,
} from "@diffdash/domain/git-provider"
import { AgentRunId } from "@diffdash/domain/review-agent"
import { ReviewThreadId } from "@diffdash/domain/review-thread"
import { HostedReviewCheckoutSpec } from "@diffdash/git-provider"
import { ProcessService } from "@diffdash/process"
import {
  HostedReviewWorkspacePool as ReviewWorktreePool,
  HostedReviewWorkspacePoolError as ReviewWorktreePoolError,
} from "./hosted-review-workspace-pool"
import { sanitizedGitEnvironment } from "./git-environment"

interface GitFixture {
  readonly root: string
  readonly source: string
  readonly remote: string
  readonly pool: string
  readonly remotePool: string
  readonly baseSha: string
  readonly headSha: string
  readonly secondHeadSha: string
  readonly snapshot: HostedReviewCheckoutSpec
  readonly secondSnapshot: HostedReviewCheckoutSpec
}

const fixture = Effect.acquireRelease(Effect.sync(makeGitFixture), (value) =>
  Effect.sync(() => rmSync(value.root, { recursive: true, force: true })),
)

describe("HostedReviewWorkspacePool", () => {
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
              checkout: value.snapshot,
              bootstrapBareRepository: () => Effect.void,
              sourcePath: value.source,
            },
            (lease) =>
              Effect.promise(async () => {
                leasedPath = lease.localPath
                expect(lease.localPath.startsWith(realpathSync(value.pool))).toBe(true)
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
          "fetching-review-revision",
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
              checkout: value.snapshot,
              bootstrapBareRepository: () => Effect.void,
              sourcePath: value.source,
            },
            () => Effect.void,
            (stage) => Effect.sync(() => reusedProgress.push(stage)),
          )
        }).pipe(Effect.provide(poolLayer(value)))
        expect(reusedProgress).toEqual([
          "reserving-workspace",
          "fetching-review-revision",
          "checking-out-revision",
          "restoring-workspace",
        ])
      }),
  )

  it.scoped("allows a configured pool root symlink and returns canonical lease paths", () =>
    Effect.gen(function* () {
      const value = yield* fixture
      const canonicalPool = join(value.root, "canonical-pool")
      mkdirSync(canonicalPool)
      symlinkSync(canonicalPool, value.pool, "dir")

      let leasedPath = ""
      yield* Effect.gen(function* () {
        const pool = yield* ReviewWorktreePool
        yield* pool.use(workspaceInput(value, "root-symlink"), (lease) =>
          Effect.sync(() => {
            leasedPath = lease.localPath
          }),
        )
      }).pipe(Effect.provide(poolLayer(value)))

      expect(leasedPath.startsWith(realpathSync(canonicalPool))).toBe(true)
      expect(git(leasedPath, "rev-parse", "HEAD")).toBe(value.headSha)
    }),
  )

  it.scoped("rejects symlinked manifest and lock files without touching their targets", () =>
    Effect.gen(function* () {
      for (const name of ["manifest.json", "manifest.lock"] as const) {
        const value = yield* fixture
        mkdirSync(value.pool)
        const outside = join(value.root, `outside-${name}`)
        writeFileSync(outside, "preserve me")
        symlinkSync(outside, join(value.pool, name))
        let providerStarted = false

        const error = yield* Effect.gen(function* () {
          const pool = yield* ReviewWorktreePool
          return yield* pool
            .use(workspaceInput(value, `symlink-${name}`), () =>
              Effect.sync(() => {
                providerStarted = true
              }),
            )
            .pipe(Effect.flip)
        }).pipe(Effect.provide(poolLayer(value)))

        expect(providerStarted).toBe(false)
        expect(error).toMatchObject({ code: "filesystem" })
        expect(readFileSync(outside, "utf8")).toBe("preserve me")
      }
    }),
  )

  it.scoped("rejects symlinked repository ancestors before locking or Git mutation", () =>
    Effect.gen(function* () {
      const value = yield* fixture
      const outside = join(value.root, "outside-repositories")
      const sentinel = join(outside, "sentinel")
      mkdirSync(value.pool)
      mkdirSync(outside)
      writeFileSync(sentinel, "preserve me")
      symlinkSync(outside, join(value.pool, "repositories"), "dir")
      let providerStarted = false

      const error = yield* Effect.gen(function* () {
        const pool = yield* ReviewWorktreePool
        return yield* pool
          .use(workspaceInput(value, "repository-ancestor-symlink"), () =>
            Effect.sync(() => {
              providerStarted = true
            }),
          )
          .pipe(Effect.flip)
      }).pipe(Effect.provide(poolLayer(value)))

      expect(providerStarted).toBe(false)
      expect(error).toMatchObject({ code: "filesystem" })
      expect(readFileSync(sentinel, "utf8")).toBe("preserve me")
    }),
  )

  it.scoped("rejects symlinked repository.git and repository lock paths", () =>
    Effect.gen(function* () {
      for (const name of ["repository.git", "repository.lock"] as const) {
        const value = yield* fixture
        const repositoryRoot = repositoryPoolPath(value.pool, "github:Acme/Widget")
        const outside = join(value.root, `outside-${name}`)
        const sentinel = join(outside, "sentinel")
        mkdirSync(repositoryRoot, { recursive: true })
        mkdirSync(outside)
        writeFileSync(sentinel, "preserve me")
        symlinkSync(outside, join(repositoryRoot, name), "dir")
        let providerStarted = false

        const error = yield* Effect.gen(function* () {
          const pool = yield* ReviewWorktreePool
          return yield* pool
            .use(workspaceInput(value, `repository-${name}-symlink`), () =>
              Effect.sync(() => {
                providerStarted = true
              }),
            )
            .pipe(Effect.flip)
        }).pipe(Effect.provide(poolLayer(value)))

        expect(providerStarted).toBe(false)
        expect(error).toMatchObject({ code: "filesystem" })
        expect(readFileSync(sentinel, "utf8")).toBe("preserve me")
      }
    }),
  )

  it.scoped("rejects a symlinked manifest slot before reserving it", () =>
    Effect.gen(function* () {
      const value = yield* fixture
      const repositoryRoot = repositoryPoolPath(value.pool, "github:Acme/Widget")
      const outside = join(value.root, "outside-slot")
      const sentinel = join(outside, "sentinel")
      mkdirSync(repositoryRoot, { recursive: true })
      mkdirSync(outside)
      writeFileSync(sentinel, "preserve me")
      symlinkSync(outside, join(repositoryRoot, "linked-slot"), "dir")
      const now = new Date().toISOString()
      writeFileSync(
        join(value.pool, "manifest.json"),
        JSON.stringify({
          version: 2,
          repositories: [],
          slots: [
            {
              id: "linked-slot",
              providerId: "github",
              repositoryKey: "github:Acme/Widget",
              state: "available",
              headSha: value.headSha,
              reviewNumber: 1,
              lastThreadId: null,
              lease: null,
              createdAt: now,
              lastUsedAt: now,
              lastError: null,
            },
          ],
        }),
      )
      const beforeManifest = readFileSync(join(value.pool, "manifest.json"), "utf8")
      let providerStarted = false

      const error = yield* Effect.gen(function* () {
        const pool = yield* ReviewWorktreePool
        return yield* pool
          .use(workspaceInput(value, "slot-symlink"), () =>
            Effect.sync(() => {
              providerStarted = true
            }),
          )
          .pipe(Effect.flip)
      }).pipe(Effect.provide(poolLayer(value)))

      expect(providerStarted).toBe(false)
      expect(error).toMatchObject({ code: "filesystem", operation: "manifest.slot.path" })
      expect(readFileSync(join(value.pool, "manifest.json"), "utf8")).toBe(beforeManifest)
      expect(readFileSync(sentinel, "utf8")).toBe("preserve me")
    }),
  )

  it.scoped("invalidates disposable version-1 cache state before preparing version 2", () =>
    Effect.gen(function* () {
      const value = yield* fixture
      const staleRepositoryPath = join(value.pool, "repositories", "stale")
      const staleSentinel = join(staleRepositoryPath, "sentinel")
      mkdirSync(staleRepositoryPath, { recursive: true })
      writeFileSync(staleSentinel, "stale")
      writeFileSync(
        join(value.pool, "manifest.json"),
        JSON.stringify({ version: 1, slots: [{ id: "legacy-slot" }] }),
      )

      yield* Effect.gen(function* () {
        const pool = yield* ReviewWorktreePool
        yield* pool.use(
          {
            runId: AgentRunId.make("run-v1-invalidation"),
            threadId: ReviewThreadId.make("thread-v1-invalidation"),
            checkout: value.snapshot,
            sourcePath: value.source,
            bootstrapBareRepository: () => Effect.void,
          },
          () => Effect.void,
        )
      }).pipe(Effect.provide(poolLayer(value)))

      const manifest = JSON.parse(readFileSync(join(value.pool, "manifest.json"), "utf8")) as {
        readonly version: number
        readonly slots: readonly unknown[]
      }
      expect(manifest.version).toBe(2)
      expect(manifest.slots).toHaveLength(1)
      expect(existsSync(staleSentinel)).toBe(false)
    }),
  )

  it.scoped("separates nested repository keys across provider instances", () =>
    Effect.gen(function* () {
      const value = yield* fixture
      const nestedCheckout = makeCheckout({
        providerId: "github-enterprise",
        namespace: "Acme/Platform",
        name: "Widget",
        number: 1,
        remoteUrl: value.remote,
        fetchRef: value.snapshot.fetchRef,
        revision: value.headSha,
      })
      const paths: string[] = []

      yield* Effect.gen(function* () {
        const pool = yield* ReviewWorktreePool
        for (const [checkout, suffix] of [
          [value.snapshot, "default"],
          [nestedCheckout, "enterprise"],
        ] as const) {
          yield* pool.use(
            {
              runId: AgentRunId.make(`run-${suffix}`),
              threadId: ReviewThreadId.make(`thread-${suffix}`),
              checkout,
              sourcePath: value.source,
              bootstrapBareRepository: () => Effect.void,
            },
            (lease) => Effect.sync(() => paths.push(lease.localPath)),
          )
        }
      }).pipe(Effect.provide(poolLayer(value)))

      expect(paths).toHaveLength(2)
      expect(paths[0]).not.toBe(paths[1])
      expect(
        paths[0]?.startsWith(repositoryPoolPath(realpathSync(value.pool), "github:Acme/Widget")),
      ).toBe(true)
      expect(
        paths[1]?.startsWith(
          repositoryPoolPath(realpathSync(value.pool), "github-enterprise:Acme/Platform/Widget"),
        ),
      ).toBe(true)
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
            version: 2,
            repositories: [],
            slots: Array.from({ length: 10 }, (_, index) => ({
              id: `slot-${index}`,
              providerId: "other-provider",
              repositoryKey: `other-provider:other/repo-${index}`,
              state: "leased",
              headSha: "head",
              reviewNumber: index + 1,
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
              checkout: value.snapshot,
              bootstrapBareRepository: () => Effect.void,
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
          version: 2,
          repositories: [],
          slots: [
            {
              id: "stale-slot",
              providerId: "github",
              repositoryKey: "github:Acme/Widget",
              state: "leased",
              headSha: value.baseSha,
              reviewNumber: 1,
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
            checkout: value.snapshot,
            bootstrapBareRepository: () => Effect.void,
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
              checkout: value.snapshot,
              bootstrapBareRepository: () => Effect.void,
              sourcePath: value.source,
            },
            () =>
              Effect.sync(() => {
                providerStarted = true
                rmSync(
                  join(repositoryPoolPath(value.pool, "github:Acme/Widget"), "repository.git"),
                  {
                    recursive: true,
                    force: true,
                  },
                )
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
        providerId: "other-provider",
        repositoryKey: `other-provider:Other/Repo-${index}`,
        state: "available",
        headSha: null,
        reviewNumber: null,
        lastThreadId: null,
        lease: null,
        createdAt: new Date(Date.UTC(2000, 0, index + 1)).toISOString(),
        lastUsedAt: new Date(Date.UTC(2000, 0, index + 1)).toISOString(),
        lastError: null,
      }))
      writeFileSync(
        join(value.pool, "manifest.json"),
        JSON.stringify({ version: 2, repositories: [], slots }),
      )
      const oldestSlotPath = join(
        repositoryPoolPath(value.pool, "other-provider:Other/Repo-0"),
        "idle-0",
      )
      const oldestSentinel = join(oldestSlotPath, "sentinel")
      mkdirSync(oldestSlotPath, { recursive: true })
      writeFileSync(oldestSentinel, "remove me")

      let leasedSlot = ""
      yield* Effect.gen(function* () {
        const pool = yield* ReviewWorktreePool
        yield* pool.use(
          {
            runId: AgentRunId.make("run-lru"),
            threadId: ReviewThreadId.make("thread-lru"),
            checkout: value.snapshot,
            bootstrapBareRepository: () => Effect.void,
            sourcePath: value.source,
          },
          (lease) => Effect.sync(() => (leasedSlot = lease.slotId)),
        )
      }).pipe(Effect.provide(poolLayer(value)))

      const manifest = JSON.parse(readFileSync(join(value.pool, "manifest.json"), "utf8")) as {
        readonly slots: ReadonlyArray<{
          readonly id: string
          readonly providerId: string
          readonly repositoryKey: string
          readonly state: string
        }>
      }
      expect(leasedSlot).toBe("idle-0")
      expect(manifest.slots).toHaveLength(10)
      expect(manifest.slots.find(({ id }) => id === "idle-0")).toMatchObject({
        providerId: "github",
        repositoryKey: "github:Acme/Widget",
        state: "available",
      })
      expect(existsSync(oldestSentinel)).toBe(false)
      expect(
        manifest.slots.slice(1).every(({ providerId }) => providerId === "other-provider"),
      ).toBe(true)
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
          version: 2,
          repositories: [],
          slots: [
            {
              id: "../../../outside-sentinel",
              providerId: "github",
              repositoryKey: "github:Acme/Widget",
              state: "available",
              headSha: value.headSha,
              reviewNumber: 1,
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
              checkout: value.snapshot,
              bootstrapBareRepository: () => Effect.void,
              sourcePath: value.source,
            },
            () => Effect.sync(() => (providerStarted = true)),
          )
          .pipe(Effect.sandbox, Effect.flip)
      }).pipe(Effect.provide(poolLayer(value)))
      const error = Cause.squash(cause)

      expect(providerStarted).toBe(false)
      expect(error).toBeInstanceOf(ReviewWorktreePoolError)
      expect(error).toMatchObject({ code: "filesystem", operation: "path.segment" })
      expect(readFileSync(outsideSentinel, "utf8")).toBe("preserve me")
    }),
  )

  it.scoped("fails before provider use when the fetched PR head moved", () =>
    Effect.gen(function* () {
      const value = yield* fixture
      const movedSnapshot = HostedReviewCheckoutSpec.make({
        ...value.snapshot,
        revision: "0000000000000000000000000000000000000000",
      })
      let providerStarted = false

      const error = yield* Effect.gen(function* () {
        const pool = yield* ReviewWorktreePool
        return yield* pool
          .use(
            {
              runId: AgentRunId.make("run-moved"),
              threadId: ReviewThreadId.make("thread-moved"),
              checkout: movedSnapshot,
              bootstrapBareRepository: () => Effect.void,
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
            checkout: value.snapshot,
            bootstrapBareRepository: () => Effect.void,
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

  it.scoped("uses authenticated remote bootstrap and reuses it across hosted reviews", () =>
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
      const bootstrapBareRepository = bootstrapWithGh

      yield* Effect.gen(function* () {
        const pool = yield* ReviewWorktreePool
        const live = yield* TestLive.TestLive
        yield* pool.use(
          {
            runId: AgentRunId.make("run-unlinked"),
            threadId: ReviewThreadId.make("thread-unlinked"),
            checkout: value.snapshot,
            bootstrapBareRepository,
            sourcePath: null,
          },
          (lease) =>
            Effect.sync(() => {
              expect(lease.localPath.startsWith(realpathSync(value.remotePool))).toBe(true)
              expect(git(lease.localPath, "rev-parse", "HEAD")).toBe(value.headSha)
            }),
        )
        yield* Effect.promise(() => new Promise((resolvePromise) => setTimeout(resolvePromise, 5)))
        yield* pool.use(
          {
            runId: AgentRunId.make("run-unlinked-second"),
            threadId: ReviewThreadId.make("thread-unlinked-second"),
            checkout: value.secondSnapshot,
            bootstrapBareRepository,
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
          snapshot: HostedReviewCheckoutSpec,
          runId: string,
          threadId: string,
        ) =>
          pool.use(
            {
              runId: AgentRunId.make(runId),
              threadId: ReviewThreadId.make(threadId),
              checkout: snapshot,
              bootstrapBareRepository,
              sourcePath: null,
            },
            (lease) =>
              Effect.promise(async () => {
                leasedPaths.push(lease.localPath)
                if (leasedPaths.length === 2) releaseConcurrentRuns?.()
                await concurrentGate
              }),
          )
        yield* live.provide(
          Effect.all(
            [
              concurrentRun(value.snapshot, "run-concurrent-one", "thread-concurrent-one"),
              concurrentRun(value.secondSnapshot, "run-concurrent-two", "thread-concurrent-two"),
            ],
            { concurrency: "unbounded" },
          ),
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
        readonly version: number
        readonly repositories: ReadonlyArray<{
          readonly providerId: string
          readonly repositoryKey: string
          readonly clonedAt: string
          readonly lastUsedAt: string
        }>
        readonly slots: ReadonlyArray<{
          readonly reviewNumber: number | null
          readonly providerId: string
          readonly repositoryKey: string
        }>
      }
      expect(manifest.version).toBe(2)
      expect(manifest.repositories).toHaveLength(1)
      const repository = manifest.repositories[0]
      expect(repository).toMatchObject({
        providerId: "github",
        repositoryKey: "github:Acme/Widget",
      })
      if (repository === undefined) throw new Error("Expected remote repository metadata")
      expect(Date.parse(repository.clonedAt)).not.toBeNaN()
      expect(Date.parse(repository.lastUsedAt)).not.toBeNaN()
      expect(repository.lastUsedAt >= repository.clonedAt).toBe(true)
      expect(new Set(manifest.slots.map((slot) => slot.reviewNumber))).toEqual(new Set([1, 2]))
      expect(manifest.slots.every((slot) => slot.providerId === "github")).toBe(true)
      expect(manifest.slots.every((slot) => slot.repositoryKey === "github:Acme/Widget")).toBe(true)
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
              checkout: value.snapshot,
              bootstrapBareRepository: () =>
                Effect.sync(() => writeFileSync(startedPath, "started\n")).pipe(
                  Effect.zipRight(Effect.never),
                ),
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
  ReviewWorktreePool.layer({
    remoteWorktreePoolPath: value.remotePool,
    worktreePoolPath: value.pool,
  }).pipe(Layer.provideMerge(ProcessService.layer))

const workspaceInput = (value: GitFixture, suffix: string) => ({
  runId: AgentRunId.make(`run-${suffix}`),
  threadId: ReviewThreadId.make(`thread-${suffix}`),
  checkout: value.snapshot,
  sourcePath: value.source,
  bootstrapBareRepository: () => Effect.void,
})

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

  const repository = HostedRepositoryLocator.make({
    providerId: GitProviderId.make("github"),
    namespace: RepositoryNamespace.make("Acme"),
    name: HostedRepositoryName.make("Widget"),
  })
  const snapshot = HostedReviewCheckoutSpec.make({
    repository,
    review: HostedReviewLocator.make({
      repository,
      number: HostedReviewNumber.make(1),
    }),
    remoteUrl: remote,
    fetchRef: "refs/pull/1/head",
    revision: headSha,
  })

  const secondSnapshot = HostedReviewCheckoutSpec.make({
    repository,
    review: HostedReviewLocator.make({
      repository,
      number: HostedReviewNumber.make(2),
    }),
    remoteUrl: remote,
    fetchRef: "refs/pull/2/head",
    revision: secondHeadSha,
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
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-m",
    message,
  )

const repositoryPoolPath = (poolRoot: string, repositoryKey: string) =>
  join(poolRoot, "repositories", createHash("sha256").update(repositoryKey).digest("hex"))

const makeCheckout = (input: {
  readonly providerId: string
  readonly namespace: string
  readonly name: string
  readonly number: number
  readonly remoteUrl: string
  readonly fetchRef: string
  readonly revision: string
}) => {
  const repository = HostedRepositoryLocator.make({
    providerId: GitProviderId.make(input.providerId),
    namespace: RepositoryNamespace.make(input.namespace),
    name: HostedRepositoryName.make(input.name),
  })
  return HostedReviewCheckoutSpec.make({
    repository,
    review: HostedReviewLocator.make({
      repository,
      number: HostedReviewNumber.make(input.number),
    }),
    remoteUrl: input.remoteUrl,
    fetchRef: input.fetchRef,
    revision: input.revision,
  })
}

const bootstrapWithGh = (destination: string) =>
  Effect.sync(() => {
    execFileSync("gh", ["repo", "clone", "Acme/Widget", destination, "--", "--bare"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
  })

const git = (cwd: string, ...args: readonly string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: sanitizedGitEnvironment(process.env),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()

const waitForFile = async (path: string, attemptsRemaining = 100): Promise<void> => {
  if (existsSync(path)) return
  if (attemptsRemaining > 0) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    return waitForFile(path, attemptsRemaining - 1)
  }
  throw new Error(`Timed out waiting for ${path}`)
}
