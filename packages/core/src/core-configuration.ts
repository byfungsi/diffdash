import { Schema } from "effect"
import { isAbsolute } from "node:path"

/** Absolute filesystem path decoded at the native host boundary. */
export const CoreAbsolutePath = Schema.String.pipe(
  Schema.minLength(1),
  Schema.filter(isAbsolute, { message: () => "Expected an absolute filesystem path" }),
  Schema.brand("CoreAbsolutePath"),
)

/** HTTP or HTTPS URL decoded at the native host boundary. */
export const CoreWebUrl = Schema.String.pipe(
  Schema.filter(
    (value) => {
      try {
        const url = new URL(value)
        return url.protocol === "http:" || url.protocol === "https:"
      } catch {
        return false
      }
    },
    { message: () => "Expected an HTTP or HTTPS URL" },
  ),
  Schema.brand("CoreWebUrl"),
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

/** Plain runtime configuration supplied by the native host to DiffDash Core. */
export class CoreConfiguration extends Schema.Class<CoreConfiguration>("CoreConfiguration")({
  application: Schema.Struct({
    version: Schema.String.pipe(Schema.minLength(1)),
    architecture: Schema.String.pipe(Schema.minLength(1)),
    platform: OperatingSystemPlatform,
    packaged: Schema.Boolean,
  }),
  paths: Schema.Struct({
    database: CoreAbsolutePath,
    settings: CoreAbsolutePath,
    state: CoreAbsolutePath,
    temporaryDirectory: CoreAbsolutePath,
    worktreePool: CoreAbsolutePath,
    remoteWorktreePool: CoreAbsolutePath,
    diffDashCli: CoreAbsolutePath,
    appImage: Schema.NullOr(CoreAbsolutePath),
  }),
  analytics: Schema.Struct({
    host: Schema.NullOr(CoreWebUrl),
    projectKey: Schema.NullOr(Schema.String.pipe(Schema.minLength(1))),
  }),
  environment: Schema.Struct({
    executableSearchPath: Schema.String,
    executablePathExtensions: Schema.NullOr(Schema.String),
    homeDirectory: Schema.NullOr(CoreAbsolutePath),
  }),
  fixtures: Schema.Struct({
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
}) {}
