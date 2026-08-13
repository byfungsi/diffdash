import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AIAgentSelection,
  AIModelId,
  AIProviderId,
  DEFAULT_AI_SETTINGS,
} from "@diffdash/domain/ai-settings"
import { GitFileRevision, makeHostedReviewLocator } from "@diffdash/domain/git-provider"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
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
import { ReviewKey, ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import { StoredWalkthrough, Walkthrough } from "@diffdash/domain/walkthrough"
import {
  CoreFileOpenIntent,
  CoreDefectSummary,
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
  WalkthroughOperationInterrupted,
  WalkthroughOperationResult,
  WalkthroughOperationSuperseded,
  type WalkthroughOperationTerminalFailure,
} from "./core"
import { CoreConfiguration } from "./core-configuration"
import { coreResultFromExit, type EmbeddedCoreRuntime, makeEmbeddedCore } from "./embedded-core"
import { createE2EEmbeddedCore as createEmbeddedCore } from "./e2e"
import { comparisonViewedFileScope, localViewedFileScope } from "./operations/viewed-file-scope"

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
  repoId: ReviewProjectId.make("fixture:platform/backend/service"),
  prNumber: 73,
  reviewKey: ReviewKey.make("fixture:platform/backend/service#73"),
  baseSha: ReviewRevision.make("b".repeat(40)),
  headSha: ReviewRevision.make("a".repeat(40)),
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
      selections: {
        walkthrough: AIAgentSelection.cases.Pinned.make({
          providerId: AIProviderId.make("fixture-agent"),
          modelId: AIModelId.make("fixture-model"),
        }),
        "review-thread": AIAgentSelection.cases.Pinned.make({
          providerId: AIProviderId.make("fixture-agent"),
          modelId: AIModelId.make("fixture-model"),
        }),
      },
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
    >().toEqualTypeOf<CoreWalkthroughFailure | WalkthroughOperationTerminalFailure>()
  })

  it("constructs every walkthrough terminal variant and keeps Core defects dominant", () => {
    const expected = RepositoryLinkError.make({
      operation: "list",
      reason: "Expected test failure.",
      cause: new Error("expected"),
    })
    const defect = new Error("defect")
    const composite = Exit.failCause(Cause.combine(Cause.fail(expected), Cause.die(defect)))
    const completedTerminal = WalkthroughOperationCompleted.make({ walkthrough: storedWalkthrough })
    const failedTerminal = WalkthroughOperationFailed.make({ error: expected })
    const cancelledTerminal = WalkthroughOperationCancelled.make({})
    const supersededTerminal = WalkthroughOperationSuperseded.make({
      supersededByOperationId: WalkthroughOperationId.make("replacement-operation"),
    })
    const interruptedTerminal = WalkthroughOperationInterrupted.make({})
    const defectTerminal = WalkthroughOperationDefect.make({
      defect: CoreDefectSummary.make({ tag: "Error", name: "Error", message: defect.message }),
    })
    const terminals = [
      completedTerminal,
      failedTerminal,
      cancelledTerminal,
      supersededTerminal,
      interruptedTerminal,
      defectTerminal,
    ]
    let thrown: unknown = null

    try {
      coreResultFromExit(composite)
    } catch (cause) {
      thrown = cause
    }

    expect(thrown).toBe(defect)
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
    expect(Schema.encodeSync(WalkthroughOperationResult)(defectTerminal)).toEqual({
      _tag: "defect",
      defect: { tag: "Error", name: "Error", message: "defect" },
    })
  })

  it("preserves local, detached, branch, and repository-comparison viewed-file identities", () => {
    const rootPath = RepositoryCheckoutPath.make("/workspace/diffdash")
    const workingTree = workingTreeReviewTarget(rootPath)
    const branch = LocalReviewTarget.make({
      kind: "local",
      rootPath,
      comparison: BranchComparison.make({
        branchName: RepositoryComparisonRef.make("main"),
        baseRef: RepositoryComparisonRef.make("refs/heads/main"),
        baseSha: ReviewRevision.make("a".repeat(40)),
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

    expect(localViewedFileScope(ReviewProjectId.make("repo-1"), workingTree, null)).toEqual({
      repoId: "repo-1",
      sourceIdentity: "detached",
      comparisonKind: "workingTree",
      comparisonTarget: "",
    })
    expect(
      localViewedFileScope(
        ReviewProjectId.make("repo-1"),
        workingTree,
        RepositoryComparisonRef.make("feature/source"),
      ),
    ).toEqual({
      repoId: "repo-1",
      sourceIdentity: "branch:feature/source",
      comparisonKind: "workingTree",
      comparisonTarget: "",
    })
    expect(localViewedFileScope(ReviewProjectId.make("repo-1"), branch, null)).toEqual({
      repoId: "repo-1",
      sourceIdentity: "detached",
      comparisonKind: "branch",
      comparisonTarget: "main",
    })
    expect(comparisonViewedFileScope(ReviewProjectId.make("repo-1"), repositoryComparison)).toEqual(
      {
        repoId: "repo-1",
        sourceIdentity: `comparison:repository-comparison:v1:fixture:platform/backend/service:${"a".repeat(40)}:${"b".repeat(40)}:${"c".repeat(40)}`,
        comparisonKind: "repositoryComparison",
        comparisonTarget: "b".repeat(40),
      },
    )
  })

  it.effect("constructs every local and external file-open intent path", () =>
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
            filePath: RepositoryRelativePath.make("src/external.ts"),
            headRefName: GitFileRevision.make("feature/core"),
            headRevision: ReviewRevision.make("a".repeat(40)),
          }),
        ),
      )
      const localDirect = successValue(
        yield* Effect.promise(() =>
          core.execute(CoreMethod.appOpenLocalRepositoryFile, {
            rootPath: RepositoryCheckoutPath.make(repositoryPath),
            filePath: RepositoryRelativePath.make("src/local.ts"),
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
            filePath: RepositoryRelativePath.make("src/comparison.ts"),
          }),
        ),
      )
      successValue(
        yield* Effect.promise(() =>
          core.execute(CoreMethod.installRepository, {
            localPath: RepositoryCheckoutPath.make(repositoryPath),
          }),
        ),
      )
      const localHosted = successValue(
        yield* Effect.promise(() =>
          core.execute(CoreMethod.appOpenRepositoryFile, {
            review: fixtureTarget.review,
            filePath: RepositoryRelativePath.make("src/linked.ts"),
            headRefName: GitFileRevision.make("feature/core"),
            headRevision: ReviewRevision.make("a".repeat(40)),
          }),
        ),
      )
      const mismatchedBranch = successValue(
        yield* Effect.promise(() =>
          core.execute(CoreMethod.appOpenRepositoryFile, {
            review: fixtureTarget.review,
            filePath: RepositoryRelativePath.make("src/mismatch.ts"),
            headRefName: GitFileRevision.make("feature/other"),
            headRevision: ReviewRevision.make("a".repeat(40)),
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
      expect(yield* Schema.encodeEffect(CoreFileOpenIntent)(localHosted)).toEqual({
        _tag: "local",
        rootPath: canonicalRepositoryPath,
        filePath: "src/linked.ts",
      })
    }),
  )

  it.effect("starts one business runtime and releases it through the public lifecycle", () =>
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

  it.effect("gates operations until startup and makes startup idempotent", () =>
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

  it("transitions startup defects and still disposes acquired runtime resources", async () => {
    const defect = new Error("simulated startup defect")
    let disposals = 0
    const runtime: EmbeddedCoreRuntime = {
      runPromiseExit: () => Promise.resolve(Exit.die(defect)),
      dispose: async () => {
        disposals += 1
      },
    }
    const core = makeEmbeddedCore(runtime)

    await expect(core.start()).rejects.toBe(defect)
    await expect(core.execute(CoreMethod.appStateGet, {})).rejects.toBe(defect)
    await expect(core.start()).rejects.toBe(defect)
    await expect(core.dispose()).resolves.toBeUndefined()
    expect(disposals).toBe(1)
    expect(await core.start()).toMatchObject({
      ok: false,
      error: { _tag: "CoreLifecycleError", state: "disposed" },
    })
  })

  it.effect("disposes without acquiring an unstarted runtime", () =>
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

  it.effect("returns typed expected operation failures without rejecting", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const core = createEmbeddedCore(testConfiguration(directory))
      yield* Effect.addFinalizer(() => Effect.promise(core.dispose))
      successValue(yield* Effect.promise(core.start))

      const result = yield* Effect.promise(() =>
        core.execute(CoreMethod.installRepository, {
          localPath: RepositoryCheckoutPath.make(join(directory, "missing")),
        }),
      )

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("Expected repository installation to fail")
      expect(result.error).toMatchObject({ _tag: "RepositoryLinkError" })
    }),
  )

  it.effect("keeps durable walkthrough history beyond the former in-memory limit", () =>
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
              expectedBaseRevision: ReviewRevision.make("b".repeat(40)),
              expectedHeadRevision: ReviewRevision.make("a".repeat(40)),
            }),
          ),
        ),
      ).toBeNull()
      const operationIds = []

      for (let index = 0; index < 65; index += 1) {
        const accepted = successValue(
          yield* Effect.promise(() =>
            core.walkthroughs.start({ target: fixtureTarget, regenerate: index > 0 }),
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
              expectedBaseRevision: ReviewRevision.make("b".repeat(40)),
              expectedHeadRevision: ReviewRevision.make("a".repeat(40)),
            }),
          ),
        ),
      ).toMatchObject({ walkthrough: { title: "Fixture review path" } })
      expect(
        successValue(
          yield* Effect.promise(() =>
            core.walkthroughs.getStored({
              target: fixtureTarget,
              expectedBaseRevision: ReviewRevision.make("c".repeat(40)),
              expectedHeadRevision: ReviewRevision.make("a".repeat(40)),
            }),
          ),
        ),
      ).toBeNull()
      expect(
        successValue(
          yield* Effect.promise(() =>
            core.walkthroughs.getStored({
              target: fixtureTarget,
              expectedBaseRevision: ReviewRevision.make("b".repeat(40)),
              expectedHeadRevision: ReviewRevision.make("d".repeat(40)),
            }),
          ),
        ),
      ).toBeNull()

      const oldestOperationId = operationIds[0]
      expect(oldestOperationId).toBeDefined()
      if (oldestOperationId === undefined)
        throw new Error("Oldest walkthrough operation is missing")
      expect(
        successValue(
          yield* Effect.promise(() => core.walkthroughs.getOperation(oldestOperationId)),
        ),
      ).toMatchObject({ _tag: "superseded" })
      const missingCancellation = yield* Effect.promise(() =>
        core.walkthroughs.cancel(WalkthroughOperationId.make("missing-operation")),
      )
      expect(missingCancellation).toMatchObject({
        ok: false,
        error: { _tag: "WalkthroughOperationNotFound" },
      })
    }),
  )

  it.effect("accepts concurrent regenerations without a terminal-history capacity limit", () =>
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
      expect(starts.filter((result) => !result.ok)).toEqual([])
      const accepted = starts.map(successValue)
      expect(accepted).toHaveLength(65)
      const cancellations = yield* Effect.promise(() =>
        Promise.all(accepted.map(({ operationId }) => core.walkthroughs.cancel(operationId))),
      )
      const terminals = cancellations.map(successValue)
      expect(terminals.filter(({ _tag }) => _tag === "superseded")).toHaveLength(64)
      expect(terminals.filter(({ _tag }) => _tag === "cancelled")).toHaveLength(1)
    }),
  )

  it.effect("attaches repeated starts to one active exact operation", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const core = createEmbeddedCore(fixtureConfiguration(directory, true))
      yield* Effect.addFinalizer(() => Effect.promise(core.dispose))
      successValue(yield* Effect.promise(core.start))

      const [first, repeated] = yield* Effect.promise(() =>
        Promise.all([
          core.walkthroughs.start({ target: fixtureTarget, regenerate: false }),
          core.walkthroughs.start({ target: fixtureTarget, regenerate: false }),
        ]),
      )
      const firstAccepted = successValue(first)
      const repeatedAccepted = successValue(repeated)

      expect(repeatedAccepted.operationId).toBe(firstAccepted.operationId)
      expect(
        successValue(
          yield* Effect.promise(() => core.walkthroughs.cancel(firstAccepted.operationId)),
        ),
      ).toEqual(WalkthroughOperationCancelled.make({}))
    }),
  )

  it.effect("recovers active walkthrough work as interrupted without restarting it", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const configuration = fixtureConfiguration(directory, true)
      const firstCore = createEmbeddedCore(configuration)
      successValue(yield* Effect.promise(firstCore.start))
      const accepted = successValue(
        yield* Effect.promise(() =>
          firstCore.walkthroughs.start({ target: fixtureTarget, regenerate: false }),
        ),
      )

      yield* Effect.promise(firstCore.dispose)

      const recoveredCore = createEmbeddedCore(configuration)
      yield* Effect.addFinalizer(() => Effect.promise(recoveredCore.dispose))
      successValue(yield* Effect.promise(recoveredCore.start))

      expect(
        successValue(
          yield* Effect.promise(() =>
            recoveredCore.walkthroughs.getOperation(accepted.operationId),
          ),
        ),
      ).toEqual(WalkthroughOperationInterrupted.make({}))
    }),
  )

  it.effect("reports startup acquisition failures with their concrete type", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const blockedParent = join(directory, "blocked")
      writeFileSync(blockedParent, "not a directory")
      const configuration = testConfiguration(directory)
      const encoded = yield* Schema.encodeEffect(CoreConfiguration)(configuration)
      const failedConfiguration = yield* Schema.decodeUnknownEffect(CoreConfiguration)({
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
    ).toThrow(/Missing key/)
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
