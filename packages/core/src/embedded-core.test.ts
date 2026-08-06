import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_AI_SETTINGS } from "@diffdash/domain/ai-settings"
import { makeHostedReviewLocator } from "@diffdash/domain/git-provider"
import { HostedReviewTarget } from "@diffdash/domain/review-thread"
import { CoreMethod, CoreStartupError, WalkthroughOperationId } from "./core"
import { CoreConfiguration } from "./core-configuration"
import { createEmbeddedCore } from "./embedded-core"

const makeTempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-core-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

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
  it.scoped("starts one business runtime and releases it through the public lifecycle", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const configuration = testConfiguration(directory)
      const core = createEmbeddedCore(configuration)
      yield* Effect.addFinalizer(() => Effect.promise(core.dispose))

      expect(existsSync(configuration.paths.temporaryDirectory)).toBe(false)
      yield* Effect.promise(core.start)
      expect(existsSync(configuration.paths.temporaryDirectory)).toBe(true)
      const state = yield* Effect.promise(() => core.execute(CoreMethod.appStateGet, {}))

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

  it.scoped("preserves expected operation failures at the Promise boundary", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const core = createEmbeddedCore(testConfiguration(directory))
      yield* Effect.addFinalizer(() => Effect.promise(core.dispose))
      yield* Effect.promise(core.start)

      const failure = yield* Effect.promise(() =>
        core.execute(CoreMethod.installRepository, { localPath: join(directory, "missing") }).then(
          () => null,
          (cause: unknown) => cause,
        ),
      )

      expect(failure).toMatchObject({ _tag: "RepositoryLinkError" })
    }),
  )

  it.scoped("runs and retains bounded walkthrough operations through the public facade", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const configuration = fixtureConfiguration(directory)
      const core = createEmbeddedCore(configuration)
      yield* Effect.addFinalizer(() => Effect.promise(core.dispose))
      yield* Effect.promise(core.start)
      const operationIds = []

      for (let index = 0; index < 65; index += 1) {
        const accepted = yield* Effect.promise(() =>
          core.walkthroughs.start({ target: fixtureTarget, regenerate: index === 0 }),
        )
        operationIds.push(accepted.operationId)
        const result = yield* Effect.promise(() =>
          core.walkthroughs.getOperation(accepted.operationId),
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
        yield* Effect.promise(() => core.walkthroughs.getOperation(latestOperationId)),
      ).toMatchObject({ _tag: "completed" })
      expect(
        yield* Effect.promise(() =>
          core.walkthroughs.getStored({
            target: fixtureTarget,
            expectedBaseRevision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            expectedHeadRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          }),
        ),
      ).toMatchObject({ walkthrough: { title: "Fixture review path" } })

      const oldestOperationId = operationIds[0]
      expect(oldestOperationId).toBeDefined()
      if (oldestOperationId === undefined)
        throw new Error("Oldest walkthrough operation is missing")
      const oldestFailure = yield* Effect.promise(() =>
        core.walkthroughs.getOperation(oldestOperationId).then(
          () => null,
          (cause: unknown) => cause,
        ),
      )
      expect(oldestFailure).toMatchObject({ _tag: "WalkthroughOperationNotFound" })
      const missingCancellation = yield* Effect.promise(() =>
        core.walkthroughs.cancel(WalkthroughOperationId.make("missing-operation")).then(
          () => null,
          (cause: unknown) => cause,
        ),
      )
      expect(missingCancellation).toMatchObject({ _tag: "WalkthroughOperationNotFound" })
    }),
  )

  it.scoped("bounds concurrent walkthrough starts and completes in-flight cancellation", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const core = createEmbeddedCore(fixtureConfiguration(directory, true))
      yield* Effect.addFinalizer(() => Effect.promise(core.dispose))
      yield* Effect.promise(core.start)

      const starts = yield* Effect.promise(() =>
        Promise.allSettled(
          Array.from({ length: 65 }, () =>
            core.walkthroughs.start({ target: fixtureTarget, regenerate: true }),
          ),
        ),
      )
      const accepted = starts.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      )
      const rejected = starts.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      )

      expect(accepted).toHaveLength(64)
      expect(rejected).toHaveLength(1)
      expect(rejected[0]).toMatchObject({ _tag: "WalkthroughOperationCapacityExceeded" })
      const cancellations = yield* Effect.promise(() =>
        Promise.all(accepted.map(({ operationId }) => core.walkthroughs.cancel(operationId))),
      )
      expect(cancellations.every(({ _tag }) => _tag === "cancelled")).toBe(true)
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

      const failure = yield* Effect.promise(() =>
        core.start().then(
          () => null,
          (cause: unknown) => cause,
        ),
      )

      expect(failure).toBeInstanceOf(CoreStartupError)
      expect(failure).toMatchObject({ operation: "createTemporaryDirectory" })
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
