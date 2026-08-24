import { Schema } from "effect"

const CoreBuildId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(100)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)),
)

const Sha256 = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u)))

/** Build-authored description of the exact Core artifact shipped with Desktop. */
export const CoreArtifactManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  buildId: CoreBuildId,
  desktop: Schema.Struct({
    version: Schema.String,
    mode: Schema.Literals(["production", "e2e"]),
    platform: Schema.String,
    architecture: Schema.String,
  }),
  entrypoint: Schema.Literal("core.mjs"),
  entrypointSha256: Sha256,
  reviewWorker: Schema.Struct({
    buildId: CoreBuildId,
    node: Schema.Struct({
      entrypoint: Schema.Literal("review-worker-node.mjs"),
      entrypointSha256: Sha256,
    }),
    bun: Schema.Struct({
      entrypoint: Schema.Literal("review-worker-bun.mjs"),
      entrypointSha256: Sha256,
    }),
  }),
  language: Schema.Struct({
    typescript: Schema.Struct({
      root: Schema.Literal("language/typescript"),
      treeSha256: Sha256,
    }),
  }),
  runtime: Schema.Struct({
    utility: Schema.Literal(true),
    bun: Schema.Struct({
      minimumVersion: Schema.String.pipe(
        Schema.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u)),
      ),
      architecture: Schema.String,
      entrypoint: Schema.Literal("core-bun.mjs"),
      entrypointSha256: Sha256,
    }),
  }),
}).annotate({ identifier: "CoreArtifactManifest" })
