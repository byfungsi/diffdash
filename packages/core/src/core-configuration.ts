import { Option, Schema, SchemaTransformation } from "effect"
import { isAbsolute } from "node:path"

import { ReviewRevision } from "@diffdash/domain/review-identity"
import { CoreAnalyticsState, CoreWebUrl as CoreWebUrlSchema } from "./analytics-state"

/** HTTP or HTTPS URL decoded at the native host boundary. */
export const CoreWebUrl = CoreWebUrlSchema

/** Absolute filesystem path decoded at the native host boundary. */
export const CoreAbsolutePath = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.makeFilter(isAbsolute, { message: "Expected an absolute filesystem path" })),
  Schema.brand("CoreAbsolutePath"),
)

/** Absolute filesystem path decoded at the native host boundary. */
export type CoreAbsolutePath = typeof CoreAbsolutePath.Type

/** HTTP or HTTPS URL decoded at the native host boundary. */
export type CoreWebUrl = typeof CoreWebUrl.Type

/** Absolute path or remote URL accepted by the deterministic Git fixture provider. */
export const GitFixtureRemote = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(
    Schema.makeFilter(
      (value) =>
        isAbsolute(value) ||
        /^[A-Za-z]:[\\/]/u.test(value) ||
        value.startsWith("\\\\") ||
        /^(?:file|git|https?|ssh):\/\//u.test(value) ||
        /^[^@\s]+@[^:\s]+:.+$/u.test(value),
      { message: "Expected an absolute path or Git remote URL" },
    ),
  ),
  Schema.brand("GitFixtureRemote"),
)

/** Absolute path or remote URL accepted by the deterministic Git fixture provider. */
export type GitFixtureRemote = typeof GitFixtureRemote.Type

/** Application version reported by the native host. */
export const ApplicationVersion = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("ApplicationVersion"),
)

/** Application version reported by the native host. */
export type ApplicationVersion = typeof ApplicationVersion.Type

/** Process architectures supported by the Node/Electron host. */
const ProcessArchitectures = [
  "arm",
  "arm64",
  "ia32",
  "loong64",
  "mips",
  "mipsel",
  "ppc64",
  "riscv64",
  "s390x",
  "x64",
] as const satisfies readonly NodeJS.Architecture[]

/** Process architectures supported by the Node/Electron host. */
export const ProcessArchitecture = Schema.Literals(ProcessArchitectures)

/** Process architectures supported by the Node/Electron host. */
export type ProcessArchitecture = typeof ProcessArchitecture.Type

/** Platform-delimited executable search path supplied by the native host. */
export const ExecutableSearchPath = Schema.String.pipe(Schema.brand("ExecutableSearchPath"))

/** Platform-delimited executable search path supplied by the native host. */
export type ExecutableSearchPath = typeof ExecutableSearchPath.Type

/** Windows executable extension list supplied by the native host. */
export const ExecutablePathExtensions = Schema.String.pipe(Schema.brand("ExecutablePathExtensions"))

/** Windows executable extension list supplied by the native host. */
export type ExecutablePathExtensions = typeof ExecutablePathExtensions.Type

/** Operating-system platforms supported by the Node/Electron host. */
export const OperatingSystemPlatform = Schema.Literals([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "openbsd",
  "sunos",
  "win32",
  "cygwin",
  "netbsd",
])

/** Operating-system platforms supported by the Node/Electron host. */
export type OperatingSystemPlatform = typeof OperatingSystemPlatform.Type

const EncodedCorePaths = Schema.Struct({
  database: CoreAbsolutePath,
  settings: CoreAbsolutePath,
  state: CoreAbsolutePath,
  temporaryDirectory: CoreAbsolutePath,
  worktreePool: CoreAbsolutePath,
  remoteWorktreePool: CoreAbsolutePath,
  diffDashCli: CoreAbsolutePath,
  appImage: Schema.NullOr(CoreAbsolutePath),
})

class CorePathsConfiguration extends Schema.Class<CorePathsConfiguration>("CorePathsConfiguration")(
  {
    database: CoreAbsolutePath,
    settings: CoreAbsolutePath,
    state: CoreAbsolutePath,
    temporaryDirectory: CoreAbsolutePath,
    worktreePool: CoreAbsolutePath,
    remoteWorktreePool: CoreAbsolutePath,
    diffDashCli: CoreAbsolutePath,
    appImageOption: Schema.Option(CoreAbsolutePath),
  },
) {}

const CorePaths = EncodedCorePaths.pipe(
  Schema.decodeTo(
    Schema.toType(CorePathsConfiguration),
    SchemaTransformation.transform({
      decode: ({ appImage, ...paths }) =>
        CorePathsConfiguration.make({
          ...paths,
          appImageOption: Option.fromNullishOr(appImage),
        }),
      encode: ({ appImageOption, ...paths }) => ({
        ...paths,
        appImage: Option.getOrNull(appImageOption),
      }),
    }),
  ),
)

const EncodedCoreEnvironment = Schema.Struct({
  executableSearchPath: ExecutableSearchPath,
  executablePathExtensions: Schema.NullOr(ExecutablePathExtensions),
  homeDirectory: Schema.NullOr(CoreAbsolutePath),
})

class CoreEnvironmentConfiguration extends Schema.Class<CoreEnvironmentConfiguration>(
  "CoreEnvironmentConfiguration",
)({
  executableSearchPath: ExecutableSearchPath,
  executablePathExtensionsOption: Schema.Option(ExecutablePathExtensions),
  homeDirectoryOption: Schema.Option(CoreAbsolutePath),
}) {}

const CoreEnvironment = EncodedCoreEnvironment.pipe(
  Schema.decodeTo(
    Schema.toType(CoreEnvironmentConfiguration),
    SchemaTransformation.transform({
      decode: ({ executableSearchPath, executablePathExtensions, homeDirectory }) =>
        CoreEnvironmentConfiguration.make({
          executableSearchPath,
          executablePathExtensionsOption: Option.fromNullishOr(executablePathExtensions),
          homeDirectoryOption: Option.fromNullishOr(homeDirectory),
        }),
      encode: ({ executableSearchPath, executablePathExtensionsOption, homeDirectoryOption }) => ({
        executableSearchPath,
        executablePathExtensions: Option.getOrNull(executablePathExtensionsOption),
        homeDirectory: Option.getOrNull(homeDirectoryOption),
      }),
    }),
  ),
)

const AgentProviderFixture = Schema.Struct({
  walkthroughNeverCompletes: Schema.Boolean,
})

const GitProviderFixture = Schema.Struct({
  remoteUrl: GitFixtureRemote,
  baseRevision: Schema.OptionFromNullOr(ReviewRevision),
  headRevision: Schema.OptionFromNullOr(ReviewRevision),
})

class CoreFixturesConfiguration extends Schema.Class<CoreFixturesConfiguration>(
  "CoreFixturesConfiguration",
)({
  agentProvider: Schema.Option(AgentProviderFixture),
  gitProviderOption: Schema.Option(Schema.toType(GitProviderFixture)),
}) {}

const CoreFixtures = Schema.Struct({
  agentProviderEnabled: Schema.Boolean,
  agentProviderNeverCompletes: Schema.Boolean,
  gitProvider: Schema.NullOr(
    Schema.Struct({
      remoteUrl: GitFixtureRemote,
      baseRevision: Schema.NullOr(ReviewRevision),
      headRevision: Schema.NullOr(ReviewRevision),
    }),
  ),
}).pipe(
  Schema.decodeTo(
    Schema.toType(CoreFixturesConfiguration),
    SchemaTransformation.transform({
      decode: ({ agentProviderEnabled, agentProviderNeverCompletes, gitProvider }) =>
        CoreFixturesConfiguration.make({
          agentProvider: agentProviderEnabled
            ? Option.some({ walkthroughNeverCompletes: agentProviderNeverCompletes })
            : Option.none(),
          gitProviderOption:
            gitProvider === null
              ? Option.none()
              : Option.some({
                  remoteUrl: gitProvider.remoteUrl,
                  baseRevision: Option.fromNullishOr(gitProvider.baseRevision),
                  headRevision: Option.fromNullishOr(gitProvider.headRevision),
                }),
        }),
      encode: ({ agentProvider, gitProviderOption }) => ({
        agentProviderEnabled: Option.isSome(agentProvider),
        agentProviderNeverCompletes: Option.match(agentProvider, {
          onNone: () => false,
          onSome: ({ walkthroughNeverCompletes }) => walkthroughNeverCompletes,
        }),
        gitProvider: Option.match(gitProviderOption, {
          onNone: () => null,
          onSome: ({ remoteUrl, baseRevision, headRevision }) => ({
            remoteUrl,
            baseRevision: Option.getOrNull(baseRevision),
            headRevision: Option.getOrNull(headRevision),
          }),
        }),
      }),
    }),
  ),
)

/** Plain runtime configuration supplied by the native host to DiffDash Core. */
export class CoreConfiguration extends Schema.Class<CoreConfiguration>("CoreConfiguration")({
  application: Schema.Struct({
    version: ApplicationVersion,
    architecture: ProcessArchitecture,
    platform: OperatingSystemPlatform,
    packaged: Schema.Boolean,
  }),
  paths: CorePaths,
  analytics: CoreAnalyticsState,
  environment: CoreEnvironment,
  fixtures: CoreFixtures,
}) {}
