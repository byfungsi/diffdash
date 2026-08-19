import { CORE_PROCESS_STARTUP_ENV } from "@diffdash/core-rpc/process-startup"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { ApplicationInstanceId, CoreProcessEpoch, HostRequestId } from "@diffdash/core-rpc/identity"
import { TempResources } from "@diffdash/process/temp-resource"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Ref, Schema } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { CoreArtifactManifest, verifyCoreArtifact } from "./core-artifact"
import { bootstrapCoreHost } from "./core-host-bootstrap"
import {
  BunRuntimeProbeError,
  discoverBunRuntimeCandidates,
  makeBunCoreCommand,
  qualifyBunRuntime,
  startCoreBunProcess,
  type BunRuntimeQualificationHooks,
} from "./core-bun-runtime"
import { makeCoreProcessFixtureConfiguration } from "./core-process-configuration.fixture"

const candidate = { executablePath: "/home/test/.bun/bin/bun", source: "home" } as const
const successfulProbe = () => Effect.void
const probeFailure = BunRuntimeProbeError.make({ safeMessage: "A Bun runtime probe failed." })
const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const launchDependencies = Layer.merge(
  TempResources.layer.pipe(Layer.provide(platformLayer)),
  platformLayer,
)

describe("Bun Core runtime", () => {
  it("discovers PATH and Finder-safe Bun locations in deterministic order", () => {
    expect(
      discoverBunRuntimeCandidates({
        environment: { PATH: "/custom/bin:/usr/local/bin" },
        homeDirectory: "/home/test",
        platform: "darwin",
      }),
    ).toEqual([
      { executablePath: "/custom/bin/bun", source: "path" },
      { executablePath: "/usr/local/bin/bun", source: "path" },
      { executablePath: "/home/test/.bun/bin/bun", source: "home" },
      { executablePath: "/opt/homebrew/bin/bun", source: "system" },
    ])
  })

  it.effect("runs every qualification capability in order", () =>
    Effect.gen(function* () {
      const observed = yield* Ref.make<ReadonlyArray<string>>([])
      const probe = (name: string) => () => Ref.update(observed, (names) => [...names, name])
      const hooks: BunRuntimeQualificationHooks = {
        runtimeFacts: () =>
          Ref.update(observed, (names) => [...names, "version"]).pipe(
            Effect.as({ version: "1.2.23", architecture: "arm64" }),
          ),
        worker: probe("worker"),
        processCancellation: probe("processCancellation"),
        filesystem: probe("filesystem"),
        socket: probe("socket"),
        effect: probe("effect"),
        sqlite: probe("sqlite"),
        artifact: probe("artifact"),
        coreHealth: probe("coreHealth"),
      }

      expect(
        yield* qualifyBunRuntime(
          candidate,
          { minimumVersion: "1.2.0", architecture: "arm64" },
          hooks,
        ),
      ).toBe(candidate)
      expect(yield* Ref.get(observed)).toEqual([
        "version",
        "worker",
        "processCancellation",
        "filesystem",
        "socket",
        "effect",
        "sqlite",
        "artifact",
        "coreHealth",
      ])
    }),
  )

  it.effect("rejects an invalid candidate at the exact failed capability", () =>
    Effect.gen(function* () {
      const hooks: BunRuntimeQualificationHooks = {
        runtimeFacts: () => Effect.succeed({ version: "1.2.23", architecture: "arm64" }),
        worker: successfulProbe,
        processCancellation: successfulProbe,
        filesystem: successfulProbe,
        socket: successfulProbe,
        effect: successfulProbe,
        sqlite: () => Effect.fail(probeFailure),
        artifact: successfulProbe,
        coreHealth: successfulProbe,
      }

      expect(
        yield* qualifyBunRuntime(
          candidate,
          { minimumVersion: "1.2.0", architecture: "arm64" },
          hooks,
        ).pipe(Effect.flip),
      ).toMatchObject({ capability: "sqlite" })
    }),
  )

  it("builds an isolated Bun command with no runtime injection or implicit install", () => {
    const command = makeBunCoreCommand({
      applicationCwd: "/Applications/DiffDash.app",
      configPath: "/private/core/bunfig.toml",
      encodedStartupConfiguration: "encoded-secret",
      entrypointPath: "/Applications/DiffDash.app/Resources/core/core.mjs",
      additionalAllowedEnvironmentNames: ["DIFFDASH_E2E_TERMINAL_HINT_DELIVERY"],
      environment: {
        BUN_OPTIONS: "--preload=attack.ts",
        DIFFDASH_E2E_TERMINAL_HINT_DELIVERY: "drop",
        HOME: "/Users/test",
        NODE_OPTIONS: "--require attack.js",
        PATH: "/usr/bin",
        SECRET: "must-not-leak",
      },
    })

    expect(command).toEqual({
      args: [
        "--cwd=/Applications/DiffDash.app",
        "--config=/private/core/bunfig.toml",
        "--no-env-file",
        "--no-install",
        "/Applications/DiffDash.app/Resources/core/core.mjs",
      ],
      cwd: "/Applications/DiffDash.app",
      environment: {
        [CORE_PROCESS_STARTUP_ENV]: "encoded-secret",
        DIFFDASH_E2E_TERMINAL_HINT_DELIVERY: "drop",
        HOME: "/Users/test",
        PATH: "/usr/bin",
      },
    })
  })

  it.live(
    "launches the generated Core artifact with the qualified Bun runtime",
    () =>
      Effect.gen(function* () {
        const tempResources = yield* TempResources
        const temporaryDirectory = yield* tempResources.makeTempDirectoryScoped({
          prefix: "dd-core-bun-parent-",
        })
        const artifactDirectory = join(temporaryDirectory, "artifact")
        execFileSync(
          process.execPath,
          ["scripts/build-core-artifact.mjs", `--output-directory=${artifactDirectory}`],
          {
            cwd: resolve("."),
            stdio: "ignore",
          },
        )
        const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(CoreArtifactManifest))(
          readFileSync(join(artifactDirectory, "manifest.json"), "utf8"),
        )
        const artifact = yield* verifyCoreArtifact({
          artifactDirectory,
          expectedBuildId: manifest.buildId,
        })
        const bun = discoverBunRuntimeCandidates({
          environment: process.env,
          homeDirectory: process.env.HOME ?? null,
          platform: process.platform,
        }).find(({ executablePath }) => existsSync(executablePath))
        expect(bun).toBeDefined()
        if (bun === undefined) return

        const session = yield* bootstrapCoreHost({
          artifact,
          applicationInstanceId: ApplicationInstanceId.make("app-real-bun"),
          temporaryDirectory,
          generateProcessEpoch: () => CoreProcessEpoch.make("epoch-real-bun"),
          generateRequestId: () => HostRequestId.make("h:real-bun-health"),
          generateToken: () => Redacted.make("real-bun-token-with-at-least-32-bytes"),
          startTransport: (configuration) => {
            const databasePath = join(temporaryDirectory, "diffdash.sqlite")
            const statePath = join(temporaryDirectory, "state.json")
            return startCoreBunProcess({
              applicationCwd: resolve("."),
              bunExecutablePath: bun.executablePath,
              configuration,
              databasePath,
              environment: process.env,
              statePath,
              coreConfiguration: makeCoreProcessFixtureConfiguration(databasePath, statePath),
            }).pipe(Effect.asVoid)
          },
        }).pipe(Effect.retry({ times: 2 }))

        expect(session.health).toEqual({
          applicationInstanceId: "app-real-bun",
          processEpoch: "epoch-real-bun",
          lifecycle: "awaitingOwnership",
        })
      }).pipe(Effect.provide(launchDependencies)),
    15_000,
  )
})
