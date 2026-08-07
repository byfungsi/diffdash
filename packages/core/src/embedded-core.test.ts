import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_AI_SETTINGS } from "@diffdash/domain/ai-settings"
import { makeHostedReviewLocator } from "@diffdash/domain/git-provider"
import { HostedReviewTarget } from "@diffdash/domain/review-thread"
import {
  CoreMethod,
  type CoreOperationFailure,
  type CoreResult,
  type CoreWalkthroughFailure,
  CoreStartupError,
  RepositoryLinkError,
  WalkthroughOperationId,
  type WalkthroughOperationResult,
} from "./core"
import { CoreConfiguration } from "./core-configuration"
import { walkthroughTerminalFromExit } from "./core-operation-service"
import { coreResultFromExit, createEmbeddedCore } from "./embedded-core"

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

const fixtureConfiguration = (
  directory: string,
  agentProviderNeverCompletes = false,
): CoreConfiguration => {
  const configuration = Schema.decodeUnknownSync(CoreConfiguration)({
    ...testConfiguration(directory),
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

  it("never classifies a composite defect as an expected failure", () => {
    const expected = RepositoryLinkError.make({
      operation: "test",
      reason: "Expected test failure.",
      cause: new Error("expected"),
    })
    const defect = new Error("defect")
    const composite = Exit.failCause(Cause.parallel(Cause.fail(expected), Cause.die(defect)))
    let thrown: unknown = null

    try {
      coreResultFromExit(composite)
    } catch (cause) {
      thrown = cause
    }

    expect(thrown).toBe(defect)
    expect(walkthroughTerminalFromExit(Exit.fail(expected))).toEqual({
      _tag: "failed",
      error: expected,
    })
    expect(walkthroughTerminalFromExit(composite)).toEqual({
      _tag: "defect",
      defect,
    })
  })

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
      const afterDispose = yield* Effect.promise(() =>
        core.execute(CoreMethod.appStateGet, {}).then(
          () => null,
          (cause: unknown) => cause,
        ),
      )
      expect(afterDispose).not.toBeNull()
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
      const operationIds = []

      for (let index = 0; index < 65; index += 1) {
        const accepted = successValue(
          yield* Effect.promise(() =>
            core.walkthroughs.start({ target: fixtureTarget, regenerate: index === 0 }),
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
      const failedConfiguration = yield* Schema.decodeUnknown(CoreConfiguration)({
        ...configuration,
        paths: { ...configuration.paths, temporaryDirectory: join(blockedParent, "temporary") },
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
    expect(() =>
      Schema.decodeUnknownSync(CoreConfiguration)({
        ...configuration,
        fixtures: {
          ...configuration.fixtures,
          gitProvider: { remoteUrl: null, baseRevision: null, headRevision: null },
        },
      }),
    ).toThrow(/remoteUrl/)
  })
})
