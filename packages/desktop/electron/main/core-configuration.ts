import { CoreConfiguration, CoreConfigurationError } from "@diffdash/core"
import { Effect, Schema } from "effect"

interface CoreConfigurationInput {
  readonly application: {
    readonly version: string
    readonly architecture: NodeJS.Architecture
    readonly platform: NodeJS.Platform
    readonly packaged: boolean
  }
  readonly paths: {
    readonly database: string
    readonly settings: string
    readonly state: string
    readonly temporaryDirectory: string
    readonly worktreePool: string
    readonly remoteWorktreePool: string
    readonly diffDashCli: string
    readonly appImage: string | null
  }
  readonly analytics: {
    readonly host: string | null
    readonly projectKey: string | null
  }
  readonly environment: {
    readonly executableSearchPath: string
    readonly executablePathExtensions: string | null
    readonly homeDirectory: string | null
  }
  readonly fixtures: {
    readonly agentProviderEnabled: boolean
    readonly agentProviderNeverCompletes: boolean
    readonly gitProvider: {
      readonly remoteUrl: string | undefined
      readonly baseRevision: string | null
      readonly headRevision: string | null
    } | null
  }
}

/** Validates Electron-owned runtime facts as the plain DiffDash Core configuration contract. */
export const decodeCoreConfiguration = (
  configuration: CoreConfigurationInput,
): Effect.Effect<CoreConfiguration, CoreConfigurationError> =>
  Schema.decodeUnknownEffect(CoreConfiguration)(configuration).pipe(
    Effect.mapError((cause) =>
      CoreConfigurationError.make({
        message: "DiffDash Core configuration is invalid.",
        cause,
      }),
    ),
  )
