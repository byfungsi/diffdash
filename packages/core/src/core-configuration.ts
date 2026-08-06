import { Schema } from "effect"

/** Plain runtime configuration supplied by the native host to DiffDash Core. */
export class CoreConfiguration extends Schema.Class<CoreConfiguration>("CoreConfiguration")({
  application: Schema.Struct({
    version: Schema.String,
    architecture: Schema.String,
    platform: Schema.String,
    packaged: Schema.Boolean,
  }),
  paths: Schema.Struct({
    database: Schema.String,
    settings: Schema.String,
    state: Schema.String,
    temporaryDirectory: Schema.String,
    worktreePool: Schema.String,
    remoteWorktreePool: Schema.String,
    diffDashCli: Schema.String,
    appImage: Schema.NullOr(Schema.String),
  }),
  analytics: Schema.Struct({
    host: Schema.NullOr(Schema.String),
    projectKey: Schema.NullOr(Schema.String),
  }),
  environment: Schema.Struct({
    executableSearchPath: Schema.String,
    homeDirectory: Schema.String,
  }),
  fixtures: Schema.Struct({
    agentProviderEnabled: Schema.Boolean,
    gitProvider: Schema.NullOr(
      Schema.Struct({
        remoteUrl: Schema.NullOr(Schema.String),
        baseRevision: Schema.NullOr(Schema.String),
        headRevision: Schema.NullOr(Schema.String),
      }),
    ),
  }),
}) {}
