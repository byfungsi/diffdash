import { describe, expect, it } from "@effect/vitest"
import { CoreConfiguration } from "@diffdash/core"
import { Effect } from "effect"
import { Schema } from "effect"
import { makeE2EDesktopStartupConfiguration } from "./desktop-host-configuration.e2e"
import {
  makeDesktopHostConfiguration,
  productionDesktopStartupConfiguration,
} from "./desktop-host-configuration"

const source = {
  identity: {
    appName: "DiffDash Development",
    appUserModelId: "dev.diffdash.app.development",
    storageNamespace: "diffdash-development",
    userDataPath: "/var/app-data/DiffDash Development",
  },
  version: "0.7.0",
  architecture: "x64",
  platform: "linux",
  packaged: false,
  resourcesPath: "/opt/diffdash/resources",
  temporaryDirectory: "/var/tmp",
  userDataDirectory: "/var/app-data/DiffDash Development",
  environment: {
    APPIMAGE: "/opt/DiffDash.AppImage",
    DEBUG_ONBOARD: "1",
    DIFFDASH_ALLOW_MULTIPLE_INSTANCES: "1",
    DIFFDASH_E2E_DISABLE_UPDATES: "1",
    DIFFDASH_E2E_FAKE_AGENT_PROVIDER: "1",
    DIFFDASH_E2E_FAKE_AGENT_NEVER_COMPLETES: "1",
    DIFFDASH_E2E_FAKE_GIT_PROVIDER: "1",
    DIFFDASH_E2E_FAKE_GIT_REMOTE: "/fixtures/remote.git",
    DIFFDASH_E2E_FAKE_GIT_BASE_SHA: "a".repeat(40),
    DIFFDASH_E2E_FAKE_GIT_HEAD_SHA: "b".repeat(40),
    DIFFDASH_REMOTE_WORKTREE_POOL_PATH: "/custom/remote-pool",
    DIFFDASH_WORKTREE_POOL_PATH: "/custom/worktree-pool",
    ELECTRON_RENDERER_URL: "http://localhost:5173",
    HOME: "/home/test",
    PATH: "/usr/local/bin:/usr/bin",
    VITE_POSTHOG_HOST: "https://analytics.example.com",
    VITE_POSTHOG_KEY: "project-key",
    XDG_CONFIG_HOME: "/var/config",
  },
  homeDirectory: "/home/test",
  moduleDirectory: "/workspace/packages/desktop/out/main",
} as const

describe("desktop host configuration", () => {
  it.effect("keeps every default development data path out of production", () =>
    Effect.gen(function* () {
      const configuration = yield* makeDesktopHostConfiguration(
        {
          ...source,
          environment: {
            ELECTRON_RENDERER_URL: "http://localhost:5173",
            HOME: "/home/test",
            PATH: "/usr/local/bin:/usr/bin",
          },
        },
        productionDesktopStartupConfiguration,
      )

      expect(configuration.identity).toEqual(source.identity)
      expect(configuration.paths).toMatchObject({
        agentWorkingDirectory: "/var/tmp/diffdash-development",
        configDirectory: "/home/test/.config/diffdash-development",
        databasePath: "/var/app-data/DiffDash Development/diffdash.sqlite",
        remoteWorktreePoolPath: "/home/test/.diffdash-development/remote-worktree-pool",
        settingsPath: "/home/test/.config/diffdash-development/settings.json",
        statePath: "/home/test/.config/diffdash-development/state.json",
        worktreePoolPath: "/home/test/.diffdash-development/worktree-pool",
      })
      expect(Schema.encodeSync(CoreConfiguration)(configuration.core).paths).toMatchObject({
        database: "/var/app-data/DiffDash Development/diffdash.sqlite",
        remoteWorktreePool: "/home/test/.diffdash-development/remote-worktree-pool",
        settings: "/home/test/.config/diffdash-development/settings.json",
        state: "/home/test/.config/diffdash-development/state.json",
        temporaryDirectory: "/var/tmp/diffdash-development",
        worktreePool: "/home/test/.diffdash-development/worktree-pool",
      })
    }),
  )

  it.effect("keeps production behavior independent of E2E environment flags", () =>
    Effect.gen(function* () {
      const configuration = yield* makeDesktopHostConfiguration(
        source,
        productionDesktopStartupConfiguration,
      )
      const encodedCore = Schema.encodeSync(CoreConfiguration)(configuration.core)

      expect(configuration).toMatchObject({
        identity: source.identity,
        application: {
          version: "0.7.0",
          architecture: "x64",
          platform: "linux",
          packaged: false,
        },
        policies: {
          allowMultipleInstances: true,
          coreHostMode: "auto",
          debugOnboarding: true,
          hiddenWindow: false,
          updatesDisabled: false,
        },
        paths: {
          configDirectory: "/var/config/diffdash-development",
          databasePath: "/var/app-data/DiffDash Development/diffdash.sqlite",
          developmentIconPath: "/workspace/packages/desktop/resources/icons/icon.png",
          diffDashCliPath: "/workspace/packages/desktop/bin/diffdash.mjs",
          preloadPath: "/workspace/packages/desktop/out/preload/index.mjs",
          remoteWorktreePoolPath: "/custom/remote-pool",
          rendererHtmlPath: "/workspace/packages/desktop/out/renderer/index.html",
          worktreePoolPath: "/custom/worktree-pool",
        },
        renderer: {
          _tag: "DevelopmentRendererEntry",
          url: "http://localhost:5173",
        },
        updater: { appImagePath: "/opt/DiffDash.AppImage" },
      })
      expect(encodedCore).toMatchObject({
        analytics: {
          host: "https://analytics.example.com",
          projectKey: "project-key",
        },
        fixtures: {
          agentProviderEnabled: false,
          agentProviderNeverCompletes: false,
          gitProvider: null,
        },
        environment: {
          executableSearchPath: "/usr/local/bin:/usr/bin",
        },
      })
    }),
  )

  it.effect("keeps E2E windows hidden and honors fixture environment flags", () =>
    Effect.gen(function* () {
      const configuration = yield* makeDesktopHostConfiguration(
        source,
        makeE2EDesktopStartupConfiguration(source.environment),
      )
      const encodedCore = Schema.encodeSync(CoreConfiguration)(configuration.core)

      expect(configuration.policies).toMatchObject({
        coreHostMode: "auto",
        hiddenWindow: true,
        updatesDisabled: true,
      })
      expect(encodedCore.fixtures).toEqual({
        agentProviderEnabled: true,
        agentProviderNeverCompletes: true,
        gitProvider: {
          remoteUrl: "/fixtures/remote.git",
          baseRevision: "a".repeat(40),
          headRevision: "b".repeat(40),
        },
      })
    }),
  )

  it("accepts only explicit E2E Core host overrides", () => {
    expect(makeE2EDesktopStartupConfiguration({ DIFFDASH_E2E_CORE_HOST: "bun" }).coreHostMode).toBe(
      "bun",
    )
    expect(
      makeE2EDesktopStartupConfiguration({ DIFFDASH_E2E_CORE_HOST: "utility" }).coreHostMode,
    ).toBe("utility")
    expect(() =>
      makeE2EDesktopStartupConfiguration({ DIFFDASH_E2E_CORE_HOST: "embedded" }),
    ).toThrow("DIFFDASH_E2E_CORE_HOST must be bun or utility")
  })

  it.effect("resolves packaged ESM resources without CommonJS directory globals", () =>
    Effect.gen(function* () {
      const configuration = yield* makeDesktopHostConfiguration(
        {
          ...source,
          packaged: true,
          environment: {},
        },
        productionDesktopStartupConfiguration,
      )

      expect(configuration.paths).toMatchObject({
        developmentIconPath: null,
        diffDashCliPath: "/opt/diffdash/resources/bin/diffdash",
        preloadPath: "/workspace/packages/desktop/out/preload/index.mjs",
        rendererHtmlPath: "/workspace/packages/desktop/out/renderer/index.html",
      })
      expect(configuration.renderer).toEqual({
        _tag: "PackagedRendererEntry",
        url: "file:///workspace/packages/desktop/out/renderer/index.html",
      })
      expect(configuration.policies.debugOnboarding).toBe(false)
    }),
  )

  it.effect("falls back to the packaged renderer entry when development has no URL", () =>
    Effect.gen(function* () {
      const configuration = yield* makeDesktopHostConfiguration(
        {
          ...source,
          environment: {},
        },
        productionDesktopStartupConfiguration,
      )

      expect(configuration.renderer).toEqual({
        _tag: "PackagedRendererEntry",
        url: "file:///workspace/packages/desktop/out/renderer/index.html",
      })
    }),
  )

  it.effect("ignores the development renderer environment value when packaged", () =>
    Effect.gen(function* () {
      const configuration = yield* makeDesktopHostConfiguration(
        {
          ...source,
          packaged: true,
          environment: { ELECTRON_RENDERER_URL: "not a URL" },
        },
        productionDesktopStartupConfiguration,
      )

      expect(configuration.renderer).toMatchObject({ _tag: "PackagedRendererEntry" })
    }),
  )

  it.effect("rejects an invalid selected development renderer URL", () =>
    Effect.gen(function* () {
      const error = yield* makeDesktopHostConfiguration(
        {
          ...source,
          environment: { ELECTRON_RENDERER_URL: "file:///tmp/index.html" },
        },
        productionDesktopStartupConfiguration,
      ).pipe(Effect.flip)

      expect(error).toMatchObject({
        _tag: "RendererConfigurationError",
        message: "DiffDash renderer configuration is invalid.",
      })
    }),
  )
})
