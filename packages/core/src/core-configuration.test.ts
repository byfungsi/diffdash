import { describe, expect, it } from "@effect/vitest"
import { Option, Schema } from "effect"

import { CoreAnalyticsEnabled } from "./analytics-state"
import { CoreConfiguration } from "./core-configuration"

const encodedConfiguration = {
  application: {
    version: "1.2.3",
    architecture: "arm64",
    platform: "darwin",
    packaged: true,
  },
  paths: {
    database: "/tmp/diffdash/database.sqlite",
    settings: "/tmp/diffdash/settings.json",
    state: "/tmp/diffdash/state.json",
    temporaryDirectory: "/tmp/diffdash/temporary",
    worktreePool: "/tmp/diffdash/worktrees",
    remoteWorktreePool: "/tmp/diffdash/remote-worktrees",
    diffDashCli: "/tmp/diffdash/bin/diffdash",
    appImage: null,
  },
  analytics: {
    host: "https://us.i.posthog.com",
    projectKey: "phc_test",
  },
  environment: {
    executableSearchPath: "/usr/bin:/bin",
    executablePathExtensions: null,
    homeDirectory: null,
  },
  fixtures: {
    agentProviderEnabled: true,
    agentProviderNeverCompletes: true,
    gitProvider: {
      remoteUrl: "/tmp/diffdash/fixture.git",
      baseRevision: null,
      headRevision: "b".repeat(40),
    },
  },
} as const

describe("CoreConfiguration", () => {
  it("decodes nullable host values to Options and closed states", () => {
    const configuration = Schema.decodeUnknownSync(CoreConfiguration)(encodedConfiguration)

    expect(Option.isNone(configuration.paths.appImageOption)).toBe(true)
    expect(configuration.analytics).toBeInstanceOf(CoreAnalyticsEnabled)
    expect(Option.isNone(configuration.environment.executablePathExtensionsOption)).toBe(true)
    expect(Option.isNone(configuration.environment.homeDirectoryOption)).toBe(true)
    expect(Option.getOrThrow(configuration.fixtures.agentProvider)).toEqual({
      walkthroughNeverCompletes: true,
    })
    expect(
      Option.isNone(Option.getOrThrow(configuration.fixtures.gitProviderOption).baseRevision),
    ).toBe(true)
    expect(
      Option.getOrThrow(Option.getOrThrow(configuration.fixtures.gitProviderOption).headRevision),
    ).toBe("b".repeat(40))
  })

  it("encodes normalized values back to the nullable host contract", () => {
    const configuration = Schema.decodeUnknownSync(CoreConfiguration)(encodedConfiguration)

    expect(Schema.encodeSync(CoreConfiguration)(configuration)).toEqual(encodedConfiguration)
  })

  it("normalizes disabled fixture flags without retaining an impossible combination", () => {
    const configuration = Schema.decodeUnknownSync(CoreConfiguration)({
      ...encodedConfiguration,
      fixtures: {
        agentProviderEnabled: false,
        agentProviderNeverCompletes: true,
        gitProvider: null,
      },
    })

    expect(Option.isNone(configuration.fixtures.agentProvider)).toBe(true)
    expect(Schema.encodeSync(CoreConfiguration)(configuration).fixtures).toEqual({
      agentProviderEnabled: false,
      agentProviderNeverCompletes: false,
      gitProvider: null,
    })
  })
})
