import type { CoreConfiguration } from "@diffdash/core"
import { Effect } from "effect"
import { dirname, join } from "node:path"

import { decodeCoreConfiguration } from "./core-configuration"

/** Builds a complete isolated Core configuration for process-boundary tests and probes. */
export const makeCoreProcessFixtureConfiguration = (
  databasePath: string,
  statePath: string,
): CoreConfiguration => {
  const directory = dirname(databasePath)
  return Effect.runSync(
    decodeCoreConfiguration({
      application: {
        version: "0.0.0-test",
        architecture: process.arch,
        platform: process.platform,
        packaged: false,
      },
      paths: {
        database: databasePath,
        settings: join(directory, "settings.json"),
        state: statePath,
        temporaryDirectory: join(directory, "temp"),
        worktreePool: join(directory, "worktrees"),
        remoteWorktreePool: join(directory, "remote-worktrees"),
        diffDashCli: process.execPath,
        appImage: null,
      },
      analytics: { host: null, projectKey: null },
      environment: {
        executableSearchPath: process.env.PATH ?? "",
        executablePathExtensions: process.env.PATHEXT ?? null,
        homeDirectory: process.env.HOME ?? null,
      },
      fixtures: {
        agentProviderEnabled: false,
        agentProviderNeverCompletes: false,
        gitProvider: null,
      },
    }),
  )
}
