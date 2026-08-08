import { Option, Schema } from "effect"
import { isAbsolute } from "node:path"

import { CoreAnalyticsState, CoreWebUrl as CoreWebUrlSchema } from "./analytics-state"

/** HTTP or HTTPS URL decoded at the native host boundary. */
export const CoreWebUrl = CoreWebUrlSchema

/** Absolute filesystem path decoded at the native host boundary. */
export const CoreAbsolutePath = Schema.String.pipe(
  Schema.minLength(1),
  Schema.filter(isAbsolute, { message: () => "Expected an absolute filesystem path" }),
  Schema.brand("CoreAbsolutePath"),
)

/** Absolute filesystem path decoded at the native host boundary. */
export type CoreAbsolutePath = typeof CoreAbsolutePath.Type

/** HTTP or HTTPS URL decoded at the native host boundary. */
export type CoreWebUrl = typeof CoreWebUrl.Type

const GitFixtureRemote = Schema.String.pipe(
  Schema.minLength(1),
  Schema.filter((value) => isAbsolute(value) || /^(?:https?|ssh):\/\//u.test(value), {
    message: () => "Expected an absolute path or Git remote URL",
  }),
  Schema.brand("GitFixtureRemote"),
)

const OperatingSystemPlatform = Schema.Literal(
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
)

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
    appImageOption: Schema.OptionFromSelf(CoreAbsolutePath),
  },
) {}

const CorePaths = Schema.transform(EncodedCorePaths, CorePathsConfiguration, {
  strict: true,
  decode: ({ appImage, ...paths }) =>
    CorePathsConfiguration.make({
      ...paths,
      appImageOption: Option.fromNullable(appImage),
    }),
  encode: (_encodedPaths, { appImageOption, ...paths }) => ({
    ...paths,
    appImage: Option.getOrNull(appImageOption),
  }),
})

const EncodedCoreEnvironment = Schema.Struct({
  executableSearchPath: Schema.String,
  executablePathExtensions: Schema.NullOr(Schema.String),
  homeDirectory: Schema.NullOr(CoreAbsolutePath),
})

class CoreEnvironmentConfiguration extends Schema.Class<CoreEnvironmentConfiguration>(
  "CoreEnvironmentConfiguration",
)({
  executableSearchPath: Schema.String,
  executablePathExtensionsOption: Schema.OptionFromSelf(Schema.String),
  homeDirectoryOption: Schema.OptionFromSelf(CoreAbsolutePath),
}) {}

const CoreEnvironment = Schema.transform(EncodedCoreEnvironment, CoreEnvironmentConfiguration, {
  strict: true,
  decode: ({ executableSearchPath, executablePathExtensions, homeDirectory }) =>
    CoreEnvironmentConfiguration.make({
      executableSearchPath,
      executablePathExtensionsOption: Option.fromNullable(executablePathExtensions),
      homeDirectoryOption: Option.fromNullable(homeDirectory),
    }),
  encode: (
    _encodedEnvironment,
    { executableSearchPath, executablePathExtensionsOption, homeDirectoryOption },
  ) => ({
    executableSearchPath,
    executablePathExtensions: Option.getOrNull(executablePathExtensionsOption),
    homeDirectory: Option.getOrNull(homeDirectoryOption),
  }),
})

const AgentProviderFixture = Schema.Struct({
  walkthroughNeverCompletes: Schema.Boolean,
})

const GitProviderFixture = Schema.Struct({
  remoteUrl: GitFixtureRemote,
  baseRevision: Schema.OptionFromNullOr(Schema.String),
  headRevision: Schema.OptionFromNullOr(Schema.String),
})

class CoreFixturesConfiguration extends Schema.Class<CoreFixturesConfiguration>(
  "CoreFixturesConfiguration",
)({
  agentProvider: Schema.OptionFromSelf(AgentProviderFixture),
  gitProviderOption: Schema.OptionFromSelf(Schema.typeSchema(GitProviderFixture)),
}) {}

const CoreFixtures = Schema.transform(
  Schema.Struct({
    agentProviderEnabled: Schema.Boolean,
    agentProviderNeverCompletes: Schema.Boolean,
    gitProvider: Schema.NullOr(
      Schema.Struct({
        remoteUrl: GitFixtureRemote,
        baseRevision: Schema.NullOr(Schema.String),
        headRevision: Schema.NullOr(Schema.String),
      }),
    ),
  }),
  CoreFixturesConfiguration,
  {
    strict: true,
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
                baseRevision: Option.fromNullable(gitProvider.baseRevision),
                headRevision: Option.fromNullable(gitProvider.headRevision),
              }),
      }),
    encode: (_encodedFixtures, { agentProvider, gitProviderOption }) => ({
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
  },
)

/** Plain runtime configuration supplied by the native host to DiffDash Core. */
export class CoreConfiguration extends Schema.Class<CoreConfiguration>("CoreConfiguration")({
  application: Schema.Struct({
    version: Schema.String.pipe(Schema.minLength(1)),
    architecture: Schema.String.pipe(Schema.minLength(1)),
    platform: OperatingSystemPlatform,
    packaged: Schema.Boolean,
  }),
  paths: CorePaths,
  analytics: CoreAnalyticsState,
  environment: CoreEnvironment,
  fixtures: CoreFixtures,
}) {}
