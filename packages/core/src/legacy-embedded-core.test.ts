import { describe, expect, it } from "@effect/vitest"
import { AppState } from "@diffdash/settings/app-state"
import { Effect, Schema } from "effect"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CoreConfiguration } from "./core-configuration"
import { createEmbeddedCore } from "./legacy-embedded-core"

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
    environment: { executableSearchPath: "", homeDirectory: directory },
    fixtures: { agentProviderEnabled: false, gitProvider: null },
  })

describe("LegacyEmbeddedCore", () => {
  it.scoped("starts one business runtime and releases it through the public lifecycle", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const configuration = testConfiguration(directory)
      const core = createEmbeddedCore(configuration)
      yield* Effect.addFinalizer(() => Effect.promise(core.dispose))

      expect(existsSync(configuration.paths.temporaryDirectory)).toBe(false)
      yield* Effect.promise(core.start)
      expect(existsSync(configuration.paths.temporaryDirectory)).toBe(true)
      const state = yield* Effect.promise(() =>
        core.runLegacy(Effect.flatMap(AppState, (service) => service.get)),
      )

      expect(state).toMatchObject({ onboardingCompleted: false })
    }),
  )

  it.scoped("preserves expected Effect failures at the Promise boundary", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const core = createEmbeddedCore(testConfiguration(directory))
      yield* Effect.addFinalizer(() => Effect.promise(core.dispose))
      const expected = { _tag: "ExpectedFailure" } as const

      const failure = yield* Effect.promise(() =>
        core.runLegacy(Effect.fail(expected)).then(
          () => null,
          (cause: unknown) => cause,
        ),
      )

      expect(failure).toBe(expected)
    }),
  )

  it("rejects malformed host configuration before Core starts", () => {
    expect(() =>
      Schema.decodeUnknownSync(CoreConfiguration)({ application: { packaged: "yes" } }),
    ).toThrow(/is missing/)
  })
})
