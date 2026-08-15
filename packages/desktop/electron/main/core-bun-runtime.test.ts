import { CORE_PROCESS_STARTUP_ENV } from "@diffdash/core-rpc/process-startup"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Ref } from "effect"

import {
  BunRuntimeProbeError,
  discoverBunRuntimeCandidates,
  makeBunCoreCommand,
  qualifyBunRuntime,
  type BunRuntimeQualificationHooks,
} from "./core-bun-runtime"

const candidate = { executablePath: "/home/test/.bun/bin/bun", source: "home" } as const
const successfulProbe = () => Effect.void
const probeFailure = BunRuntimeProbeError.make({ safeMessage: "A Bun runtime probe failed." })

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
      environment: {
        BUN_OPTIONS: "--preload=attack.ts",
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
        HOME: "/Users/test",
        PATH: "/usr/bin",
      },
    })
  })
})
