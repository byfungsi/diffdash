import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

import { CoreConfiguration } from "../core-configuration"
import { corePrerequisitesOptions } from "./core-prerequisites"

describe("corePrerequisitesOptions", () => {
  it("converts normalized absence to null only for the prerequisite service", () => {
    const configuration = Schema.decodeUnknownSync(CoreConfiguration)({
      application: {
        version: "1.2.3",
        architecture: "arm64",
        platform: "darwin",
        packaged: false,
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
      analytics: { host: null, projectKey: null },
      environment: {
        executableSearchPath: "/usr/bin:/bin",
        executablePathExtensions: null,
        homeDirectory: null,
      },
      fixtures: {
        agentProviderEnabled: false,
        agentProviderNeverCompletes: false,
        gitProvider: null,
      },
    })

    expect(corePrerequisitesOptions(configuration)).toMatchObject({
      appImagePath: null,
      executablePathExtensions: null,
      homeDirectory: null,
    })
  })
})
