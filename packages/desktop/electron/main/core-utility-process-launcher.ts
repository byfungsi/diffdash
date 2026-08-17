import { CORE_PROCESS_STARTUP_ENV } from "@diffdash/core-rpc/process-startup"
import { Effect } from "effect"
import { utilityProcess } from "electron"

import {
  startCoreProcess,
  startCoreProcessManaged,
  type CoreProcessHandle,
  type CoreProcessSpawner,
} from "./core-process-launcher"
import type { CoreHostTransportConfiguration } from "./core-host-bootstrap"
import type { CoreConfiguration } from "@diffdash/core"

const utilityProcessSpawner: CoreProcessSpawner = {
  spawn: ({ entrypointPath, encodedStartupConfiguration }) => {
    const diagnosticsEnabled = process.env.DIFFDASH_CORE_UTILITY_PROCESS_DIAGNOSTICS === "1"
    const child = utilityProcess.fork(entrypointPath, [], {
      env: {
        ...process.env,
        [CORE_PROCESS_STARTUP_ENV]: encodedStartupConfiguration,
      },
      serviceName: "DiffDash Core",
      stdio: diagnosticsEnabled ? "pipe" : "ignore",
    })
    if (diagnosticsEnabled) {
      child.stdout?.pipe(process.stdout)
      child.stderr?.pipe(process.stderr)
    }
    const exited = new Promise<number>((resolve) => child.once("exit", resolve))
    return {
      awaitExit: Effect.promise(() => exited),
      kill: () => child.kill(),
    } satisfies CoreProcessHandle
  },
}

/** Inputs required by Electron's concrete Core utility-process launcher. */
export interface StartCoreUtilityProcessOptions {
  readonly configuration: CoreHostTransportConfiguration
  readonly databasePath: string
  readonly statePath: string
  readonly coreConfiguration: CoreConfiguration
  readonly listenTimeout?: number
}

/** Launches the verified Core artifact through Electron's utility process runtime. */
export const startCoreUtilityProcess = (options: StartCoreUtilityProcessOptions) =>
  startCoreProcess({ ...options, spawner: utilityProcessSpawner })

/** Launches the utility-process Core while exposing its scoped handle for host supervision. */
export const startCoreUtilityProcessManaged = (options: StartCoreUtilityProcessOptions) =>
  startCoreProcessManaged({ ...options, spawner: utilityProcessSpawner })
