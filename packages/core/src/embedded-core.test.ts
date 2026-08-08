import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Cause, Effect, Exit, FiberId, Schema } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_AI_SETTINGS } from "@diffdash/domain/ai-settings"
import { makeHostedReviewLocator } from "@diffdash/domain/git-provider"
import {
  BranchComparison,
  LocalReviewTarget,
  workingTreeReviewTarget,
} from "@diffdash/domain/local-review"
import {
  GitCommitSha,
  RepositoryComparisonRef,
  RepositoryComparisonTarget,
} from "@diffdash/domain/repository-comparison"
import { HostedReviewTarget } from "@diffdash/domain/review-thread"
import { StoredWalkthrough, Walkthrough } from "@diffdash/domain/walkthrough"
import {
  CoreFileOpenIntent,
  CoreLifecycleError,
  CoreMethod,
  type CoreOperationFailure,
  type CoreResult,
  type CoreWalkthroughFailure,
  CoreStartupError,
  RepositoryLinkError,
  WalkthroughOperationCancelled,
  WalkthroughOperationCompleted,
  WalkthroughOperationDefect,
  WalkthroughOperationFailed,
  WalkthroughOperationId,
  WalkthroughOperationResult,
} from "./core"
import { CoreConfiguration } from "./core-configuration"
import { coreResultFromExit, createEmbeddedCore } from "./embedded-core"
import { comparisonViewedFileScope, localViewedFileScope } from "./operations/viewed-file-scope"
import { walkthroughTerminalFromExit } from "./operations/walkthrough-operations"

const makeTempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-core-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const successValue = <Value, Failure>(result: CoreResult<Value, Failure>): Value => {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error("Expected Core operation to succeed")
  return result.value
}

const testConfiguration = (directory: string): CoreConfiguration =>
  Schema.decodeUnknownSync(CoreConfiguration)({
    application: {
      version: "0.0.0-test",
      architecture: "arm64",
      platform: "darwin",
      packaged: false,
    },
    paths: {
      database: join(directory, "diffdash.sqlite"),
      settings: join(directory, "settings.json"),
      state: join(directory, "state.json"),
      temporaryDirectory: join(directory, "temporary"),
      worktreePool: join(directory, "worktrees"),
      remoteWorktreePool: join(directory, "remote-worktrees"),
      diffDashCli: join(directory, "diffdash"),
      appImage: null,
    },
    analytics: { host: null, projectKey: null },
    environment: {
      executableSearchPath: "",
      executablePathExtensions: null,
      homeDirectory: directory,
    },
    fixtures: {
      agentProviderEnabled: false,
      agentProviderNeverCompletes: false,
      gitProvider: null,
    },
  })

const fixtureTarget = HostedReviewTarget.make({
  kind: "hosted",
  review: makeHostedReviewLocator("fixture", "platform/backend", "service", 73),
})

const storedWalkthrough = StoredWalkthrough.make({
  repoId: "fixture:platform/backend/service",
  prNumber: 73,
  reviewKey: "fixture:platform/backend/service#73",
  baseSha: "b".repeat(40),
  headSha: "a".repeat(40),
  promptVersion: "walkthrough-v1",
  walkthrough: Walkthrough.make({
    title: "Fixture review path",
    summary: "Review the fixture path.",
    chapters: [],
    support: [],
  }),
  createdAt: "2026-08-07T00:00:00.000Z",
})

const fixtureConfiguration = (
  directory: string,
  agentProviderNeverCompletes = false,
): CoreConfiguration => {
  const encoded = Schema.encodeSync(CoreConfiguration)(testConfiguration(directory))
  const configuration = Schema.decodeUnknownSync(CoreConfiguration)({
    ...encoded,
    fixtures: {
      agentProviderEnabled: true,
      agentProviderNeverCompletes,
      gitProvider: {
        remoteUrl: "https://git.fixture.test/platform/backend/service.git",
        baseRevision: null,
        headRevision: null,
      },
    },
  })
  writeFileSync(
    configuration.paths.settings,
    JSON.stringify({
      ...DEFAULT_AI_SETTINGS,
      routes: { walkthrough: "fixture-agent", reviewThread: "fixture-agent" },
      models: { "fixture-agent": "fixture-model" },
      telemetryEnabled: false,
    }),
  )
  return configuration
}

describe("EmbeddedCore", () => {
  it("correlates every public operation with its expected failure contract", () => {
    expectTypeOf<
      CoreOperationFailure<typeof CoreMethod.installRepository>
    >().toEqualTypeOf<RepositoryLinkError>()
    expectTypeOf<
      CoreOperationFailure<typeof CoreMethod.listRepositories>
    >().toEqualTypeOf<RepositoryLinkError>()
    expectTypeOf<CoreOperationFailure<typeof CoreMethod.analyticsCapture>>().toEqualTypeOf<never>()
    expectTypeOf<
      Extract<WalkthroughOperationResult, { readonly _tag: "failed" }>["error"]
    >().toEqualTypeOf<CoreWalkthroughFailure>()
  })

  it("constructs every walkthrough terminal variant and keeps defects dominant", () => {
    const expected = RepositoryLinkError.make({
      operation: "test",
      reason: "Expected test failure.",
      cause: new Error("expected"),
    })
    const defect = new Error("defect")
    const composite = Exit.failCause(Cause.parallel(Cause.fail(expected), Cause.die(defect)))
    const completedTerminal = WalkthroughOperationCompleted.make({ walkthrough: storedWalkthrough })
    const failedTerminal = WalkthroughOperationFailed.make({ error: expected })
    const cancelledTerminal = WalkthroughOperationCancelled.make({})
    const defectTerminal = WalkthroughOperationDefect.make({ defect })
    const terminals = [completedTerminal, failedTerminal, cancelledTerminal, defectTerminal]
    let thrown: unknown = null

    try {
      coreResultFromExit(composite)
    } catch (cause) {
      thrown = cause
    }

    expect(thrown).toBe(defect)
    expect(walkthroughTerminalFromExit(Exit.succeed(storedWalkthrough))).toEqual(completedTerminal)
    expect(walkthroughTerminalFromExit(Exit.fail(expected))).toEqual(failedTerminal)
    expect(walkthroughTerminalFromExit(Exit.interrupt(FiberId.none))).toEqual(cancelledTerminal)
    expect(walkthroughTerminalFromExit(composite)).toEqual(defectTerminal)
    for (const terminal of terminals) {
      expect(
        Schema.decodeUnknownSync(WalkthroughOperationResult)(
          Schema.encodeSync(WalkthroughOperationResult)(terminal),
        ),
      ).toEqual(terminal)
    }
    expect(Schema.encodeSync(WalkthroughOperationResult)(completedTerminal)).toMatchObject({
      _tag: "completed",
      walkthrough: { repoId: storedWalkthrough.repoId },
    })
  })

  it("preserves local, detached, branch, and repository-comparison viewed-file identities", () => {
    const workingTree = workingTreeReviewTarget("/workspace/diffdash")
    const branch = LocalReviewTarget.make({
      kind: "local",
      rootPath: "/workspace/diffdash",
      comparison: BranchComparison.make({
        branchName: "main",
        baseRef: "refs/heads/main",
        baseSha: "a".repeat(40),
      }),
    })
    const repositoryComparison = RepositoryComparisonTarget.make({
      kind: "repositoryComparison",
      repository: fixtureTarget.review.repository,
      baseRef: RepositoryComparisonRef.make("main"),
      headRef: RepositoryComparisonRef.make("feature/core"),
      baseSha: GitCommitSha.make("a".repeat(40)),
      headSha: GitCommitSha.make("b".repeat(40)),
      mergeBaseSha: GitCommitSha.make("c".repeat(40)),
    })

    expect(localViewedFileScope("repo-1", workingTree, null)).toEqual({
      repoId: "repo-1",
      sourceIdentity: "detached",
      comparisonKind: "workingTree",
      comparisonTarget: "",
    })
    expect(localViewedFileScope("repo-1", workingTree, "feature/source")).toEqual({
      repoId: "repo-1",
      sourceIdentity: "branch:feature/source",
      comparisonKind: "workingTree",
      comparisonTarget: "",
    })
    expect(localViewedFileScope("repo-1", branch, null)).toEqual({
      repoId: "repo-1",
      sourceIdentity: "detached",
      comparisonKind: "branch",
      comparisonTarget: "main",
    })
    expect(comparisonViewedFileScope("repo-1", repositoryComparison)).toEqual({
      repoId: "repo-1",
      sourceIdentity: `comparison:repository-comparison:v1:fixture:platform/backend/service:${"a".repeat(40)}:${"b".repeat(40)}:${"c".repeat(40)}`,
      comparisonKind: "repositoryComparison",
      comparisonTarget: "b".repeat(40),
    })
  })

  it.scoped("constructs every local and external file-open intent path", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const repositoryPath = join(directory, "repository")
      mkdirSync(repositoryPath)
      const canonicalRepositoryPath = realpathSync(repositoryPath)
      execFileSync("git", ["init", "-b", "feature/core", repositoryPath])
      execFileSync("git", [
        "-C",
        repositoryPath,
        "remote",
        "add",
        "origin",
        "https://git.fixture.test/platform/backend/service.git",
      ])
      const core = createEmbeddedCore(fixtureConfiguration(directory))
      yield* Effect.addFinalizer(() => Effect.promise(core.dispose))
      successValue(yield* Effect.promise(core.start))

      const externalHosted = successValue(
        yield* Effect.promise(() =>
          core.execute(CoreMethod.appOpenRepositoryFile, {
            review: fixtureTarget.review,
            filePath: "src/external.ts",
            headRefName: "feature/core",
            headRevision: "a".repeat(40),
          }),
        ),
      )
      const localDirect = successValue(
        yield* Effect.promise(() =>
          core.execute(CoreMethod.appOpenLocalRepositoryFile, {
            rootPath: repositoryPath,
            filePath: "src/local.ts",
          }),
        ),
      )
      const comparisonTarget = RepositoryComparisonTarget.make({
        kind: "repositoryComparison",
        repository: fixtureTarget.review.repository,
        baseRef: RepositoryComparisonRef.make("main"),
        headRef: RepositoryComparisonRef.make("feature/core"),
        baseSha: GitCommitSha.make("a".repeat(40)),
        headSha: GitCommitSha.make("b".repeat(40)),
        mergeBaseSha: GitCommitSha.make("c".repeat(40)),
      })
      const externalComparison = successValue(
        yield* Effect.promise(() =>
          core.execute(CoreMethod.appOpenRepositoryComparisonFile, {
            target: comparisonTarget,
            filePath: "src/comparison.ts",
          }),
        ),
      )
      successValue(
        yield* Effect.promise(() =>
          core.execute(CoreMethod.installRepository, { localPath: repositoryPath }),
        ),
      )
      const localHosted = successValue(
        yield* Effect.promise(() =>
          core.execute(CoreMethod.appOpenRepositoryFile, {
            review: fixtureTarget.review,
            filePath: "src/linked.ts",
            headRefName: "feature/core",
            headRevision: "a".repeat(40),
          }),
        ),
      )
      const mismatchedBranch = successValue(
        yield* Effect.promise(() =>
          core.execute(CoreMethod.appOpenRepositoryFile, {
            review: fixtureTarget.review,
            filePath: "src/mismatch.ts",
            headRefName: "feature/other",
            headRevision: "a".repeat(40),
          }),
        ),
      )

      expect(externalHosted._tag).toBe("external")
      expect(localDirect).toMatchObject({
        _tag: "local",
        rootPath: canonicalRepositoryPath,
        filePath: "src/local.ts",
      })
      expect(externalComparison._tag).toBe("external")
      expect(localHosted).toMatchObject({
        _tag: "local",
        rootPath: canonicalRepositoryPath,
        filePath: "src/linked.ts",
      })
      expect(mismatchedBranch._tag).toBe("external")
      expect(yield* Schema.encode(CoreFileOpenIntent)(localHosted)).toEqual({
        _tag: "local",
        rootPath: canonicalRepositoryPath,
        filePath: "src/linked.ts",
      })
    }),
  )

  it.scoped("starts one business runtime and releases it through the public lifecycle", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const configuration = testConfiguration(directory)
      const core = createEmbeddedCore(configuration)
      yield* Effect.addFinalizer(() => Effect.promise(core.dispose))

      expect(existsSync(configuration.paths.temporaryDirectory)).toBe(false)
      successValue(yield* Effect.promise(core.start))
      expect(existsSync(configuration.paths.temporaryDirectory)).toBe(true)
      const state = successValue(
        yield* Effect.promise(() => core.execute(CoreMethod.appStateGet, {})),
      )

      expect(state).toMatchObject({ onboardingCompleted: false })

      yield* Effect.promise(core.dispose)
      const afterDispose = yield* Effect.promise(() => core.execute(CoreMethod.appStateGet, {}))
      expect(afterDispose).toMatchObject({
        ok: false,
        error: { _tag: "CoreLifecycleError", state: "disposed" },
      })
    }),
  )

  it.scoped("gates operations until startup and makes startup idempotent", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const configuration = testConfiguration(directory)
      const core = createEmbeddedCore(configuration)
      yield* Effect.addFinalizer(() => Effect.promise(core.dispose))

      const beforeStart = yield* Effect.promise(() => core.execute(CoreMethod.appStateGet, {}))
      expect(beforeStart).toMatchObject({
        ok: false,
        error: { _tag: "CoreLifecycleError", state: "notStarted" },
      })
      if (beforeStart.ok) throw new Error("Expected an operation before startup to fail")
      expect(beforeStart.error).toBeInstanceOf(CoreLifecycleError)
      expect(existsSync(configuration.paths.temporaryDirectory)).toBe(false)

      const [first, second] = yield* Effect.promise(() => Promise.all([core.start(), core.start()]))
      expect(first).toEqual({ ok: true, value: undefined })
      expect(second).toEqual(first)
      expect(yield* Effect.promise(core.start)).toEqual(first)
    }),
  )

  it.scoped("disposes without acquiring an unstarted runtime", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const configuration = testConfiguration(directory)
      const core = createEmbeddedCore(configuration)

      yield* Effect.promise(() => Promise.all([core.dispose(), core.dispose()]))

      expect(existsSync(configuration.paths.temporaryDirectory)).toBe(false)
      expect(yield* Effect.promise(core.start)).toMatchObject({
        ok: false,
        error: { _tag: "CoreLifecycleError", state: "disposed" },
      })
    }),
  )

  it.scoped("returns typed expected operation failures without rejecting", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const core = createEmbeddedCore(testConfiguration(directory))
      yield* Effect.addFinalizer(() => Effect.promise(core.dispose))
      successValue(yield* Effect.promise(core.start))

      const result = yield* Effect.promise(() =>
        core.execute(CoreMethod.installRepository, { localPath: join(directory, "missing") }),
      )

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("Expected repository installation to fail")
      expect(result.error).toMatchObject({ _tag: "RepositoryLinkError" })
    }),
  )

  it.scoped("runs and retains bounded walkthrough operations through the public facade", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const configuration = fixtureConfiguration(directory)
      const core = createEmbeddedCore(configuration)
      yield* Effect.addFinalizer(() => Effect.promise(core.dispose))
      successValue(yield* Effect.promise(core.start))
      expect(
        successValue(
          yield* Effect.promise(() =>
            core.walkthroughs.getStored({
              target: fixtureTarget,
              expectedBaseRevision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              expectedHeadRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            }),
          ),
        ),
      ).toBeNull()
      const operationIds = []

      for (let remaining = 65; remaining > 0; remaining -= 1) {
        const accepted = successValue(
          yield* Effect.promise(() =>
            core.walkthroughs.start({ target: fixtureTarget, regenerate: false }),
          ),
        )
        operationIds.push(accepted.operationId)
        const result = successValue(
          yield* Effect.promise(() => core.walkthroughs.getOperation(accepted.operationId)),
        )
        if (result._tag === "failed") {
          const failure = result.error
          throw new Error(
            `Walkthrough failed: ${failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure)}`,
          )
        }
        expect(result._tag).toBe("completed")
      }

      const latestOperationId = operationIds.at(-1)
      expect(latestOperationId).toBeDefined()
      if (latestOperationId === undefined)
        throw new Error("Latest walkthrough operation is missing")
      expect(
        successValue(
          yield* Effect.promise(() => core.walkthroughs.getOperation(latestOperationId)),
        ),
      ).toMatchObject({ _tag: "completed" })
      expect(
        successValue(
          yield* Effect.promise(() =>
            core.walkthroughs.getStored({
              target: fixtureTarget,
              expectedBaseRevision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              expectedHeadRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            }),
          ),
        ),
      ).toMatchObject({ walkthrough: { title: "Fixture review path" } })
      expect(
        successValue(
          yield* Effect.promise(() =>
            core.walkthroughs.getStored({
              target: fixtureTarget,
              expectedBaseRevision: "c".repeat(40),
              expectedHeadRevision: "a".repeat(40),
            }),
          ),
        ),
      ).toBeNull()
      expect(
        successValue(
          yield* Effect.promise(() =>
            core.walkthroughs.getStored({
              target: fixtureTarget,
              expectedBaseRevision: "b".repeat(40),
              expectedHeadRevision: "d".repeat(40),
            }),
          ),
        ),
      ).toBeNull()

      const oldestOperationId = operationIds[0]
      expect(oldestOperationId).toBeDefined()
      if (oldestOperationId === undefined)
        throw new Error("Oldest walkthrough operation is missing")
      const oldestFailure = yield* Effect.promise(() =>
        core.walkthroughs.getOperation(oldestOperationId),
      )
      expect(oldestFailure).toMatchObject({
        ok: false,
        error: { _tag: "WalkthroughOperationNotFound" },
      })
      const missingCancellation = yield* Effect.promise(() =>
        core.walkthroughs.cancel(WalkthroughOperationId.make("missing-operation")),
      )
      expect(missingCancellation).toMatchObject({
        ok: false,
        error: { _tag: "WalkthroughOperationNotFound" },
      })
    }),
  )

  it.scoped("bounds concurrent walkthrough starts and completes in-flight cancellation", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const core = createEmbeddedCore(fixtureConfiguration(directory, true))
      yield* Effect.addFinalizer(() => Effect.promise(core.dispose))
      successValue(yield* Effect.promise(core.start))

      const starts = yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 65 }, () =>
            core.walkthroughs.start({ target: fixtureTarget, regenerate: true }),
          ),
        ),
      )
      const accepted = starts.flatMap((result) => (result.ok ? [result.value] : []))
      const rejected = starts.flatMap((result) => (result.ok ? [] : [result.error]))

      expect(accepted).toHaveLength(64)
      expect(rejected).toHaveLength(1)
      expect(rejected[0]).toMatchObject({ _tag: "WalkthroughOperationCapacityExceeded" })
      const cancellations = yield* Effect.promise(() =>
        Promise.all(accepted.map(({ operationId }) => core.walkthroughs.cancel(operationId))),
      )
      expect(cancellations.every((result) => result.ok && result.value._tag === "cancelled")).toBe(
        true,
      )
    }),
  )

  it.scoped("reports startup acquisition failures with their concrete type", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const blockedParent = join(directory, "blocked")
      writeFileSync(blockedParent, "not a directory")
      const configuration = testConfiguration(directory)
      const encoded = yield* Schema.encode(CoreConfiguration)(configuration)
      const failedConfiguration = yield* Schema.decodeUnknown(CoreConfiguration)({
        ...encoded,
        paths: { ...encoded.paths, temporaryDirectory: join(blockedParent, "temporary") },
      })
      const core = createEmbeddedCore(failedConfiguration)
      yield* Effect.addFinalizer(() => Effect.promise(core.dispose))

      const failure = yield* Effect.promise(core.start)

      expect(failure.ok).toBe(false)
      if (failure.ok) throw new Error("Expected Core startup to fail")
      expect(failure.error).toBeInstanceOf(CoreStartupError)
      expect(failure.error).toMatchObject({ operation: "createTemporaryDirectory" })
    }),
  )

  it("rejects malformed host configuration before Core starts", () => {
    expect(() =>
      Schema.decodeUnknownSync(CoreConfiguration)({ application: { packaged: "yes" } }),
    ).toThrow(/is missing/)
  })

  it("rejects an enabled Git fixture without a remote locator", () => {
    const configuration = testConfiguration("/tmp/diffdash-core-configuration-test")
    const encoded = Schema.encodeSync(CoreConfiguration)(configuration)
    expect(() =>
      Schema.decodeUnknownSync(CoreConfiguration)({
        ...encoded,
        fixtures: {
          ...encoded.fixtures,
          gitProvider: { remoteUrl: null, baseRevision: null, headRevision: null },
        },
      }),
    ).toThrow(/remoteUrl/)
  })
})
