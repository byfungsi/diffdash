import { createHash } from "node:crypto"
import { Effect, FileSystem, Option, Path, Schema } from "effect"

const EMBEDDED_CORE_BUILD_ID = process.env.DIFFDASH_CORE_BUILD_ID ?? ""

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
  runtime: Schema.Struct({
    utility: Schema.Literal(true),
    bun: Schema.Struct({
      minimumVersion: Schema.String.pipe(
        Schema.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u)),
      ),
      architecture: Schema.String,
    }),
  }),
}).annotate({ identifier: "CoreArtifactManifest" })

/** Build-authored description of the exact Core artifact shipped with Desktop. */
export type CoreArtifactManifest = typeof CoreArtifactManifest.Type

/** Sanitized artifact verification failure with no filesystem or manifest details. */
export class CoreArtifactVerificationError extends Schema.TaggedError<CoreArtifactVerificationError>()(
  "CoreArtifactVerificationError",
  {
    reason: Schema.Literals([
      "artifact-directory-invalid",
      "manifest-invalid",
      "build-identity-mismatch",
      "runtime-requirements-mismatch",
      "entrypoint-invalid",
      "entrypoint-checksum-mismatch",
    ]),
    safeMessage: Schema.Literal("DiffDash could not verify its packaged Core artifact."),
  },
) {}

/** Canonical identity of a verified entrypoint for immediate launcher revalidation. */
export class VerifiedCoreArtifact extends Schema.Class<VerifiedCoreArtifact>(
  "@diffdash/desktop/VerifiedCoreArtifact",
)({
  buildId: CoreBuildId,
  entrypointPath: Schema.String,
  entrypointSha256: Sha256,
  device: Schema.Number,
  inode: Schema.Option(Schema.Number),
  size: Schema.BigInt,
  runtime: CoreArtifactManifest.fields.runtime,
}) {}

/** Inputs selecting the exact packaged artifact expected by this Desktop build. */
export interface VerifyCoreArtifactOptions {
  readonly artifactDirectory: string
  readonly expectedBuildId: string
  readonly expectedArchitecture?: NodeJS.Architecture
  readonly expectedPlatform?: NodeJS.Platform
}

const verificationFailure = (reason: CoreArtifactVerificationError["reason"]) =>
  CoreArtifactVerificationError.make({
    reason,
    safeMessage: "DiffDash could not verify its packaged Core artifact.",
  })

const MANIFEST_MAX_BYTES = 16 * 1_024
const ENTRYPOINT_MAX_BYTES = 64 * 1_024 * 1_024
const JsonManifest = Schema.fromJsonString(CoreArtifactManifest)
const sameInode = (left: Option.Option<number>, right: Option.Option<number>): boolean =>
  Option.match(left, {
    onNone: () => Option.isNone(right),
    onSome: (inode) => Option.contains(right, inode),
  })

/** Verifies a canonical outside-ASAR Core manifest and entrypoint before any launch. */
export const verifyCoreArtifact = (
  options: VerifyCoreArtifactOptions,
): Effect.Effect<
  VerifiedCoreArtifact,
  CoreArtifactVerificationError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const requestedDirectory = yield* Effect.succeed(path.resolve(options.artifactDirectory)).pipe(
      Effect.filterOrFail(
        (directory) => !directory.split(path.sep).includes("app.asar"),
        () => verificationFailure("artifact-directory-invalid"),
      ),
    )

    const artifactDirectory = yield* fileSystem.realPath(requestedDirectory).pipe(
      Effect.mapError(() => verificationFailure("artifact-directory-invalid")),
      Effect.filterOrFail(
        (directory) => !directory.split(path.sep).includes("app.asar"),
        () => verificationFailure("artifact-directory-invalid"),
      ),
    )
    yield* fileSystem.stat(artifactDirectory).pipe(
      Effect.mapError(() => verificationFailure("artifact-directory-invalid")),
      Effect.filterOrFail(
        (info) => info.type === "Directory",
        () => verificationFailure("artifact-directory-invalid"),
      ),
    )

    const manifestPath = path.join(artifactDirectory, "manifest.json")
    const canonicalManifest = yield* fileSystem
      .realPath(manifestPath)
      .pipe(Effect.mapError(() => verificationFailure("manifest-invalid")))
    yield* fileSystem.stat(manifestPath).pipe(
      Effect.mapError(() => verificationFailure("manifest-invalid")),
      Effect.filterOrFail(
        (info) =>
          canonicalManifest === manifestPath &&
          info.type === "File" &&
          info.size <= BigInt(MANIFEST_MAX_BYTES),
        () => verificationFailure("manifest-invalid"),
      ),
    )
    const manifestText = yield* fileSystem
      .readFileString(manifestPath)
      .pipe(Effect.mapError(() => verificationFailure("manifest-invalid")))
    const manifest = yield* Schema.decodeUnknownEffect(JsonManifest)(manifestText).pipe(
      Effect.mapError(() => verificationFailure("manifest-invalid")),
    )
    yield* Effect.succeed(manifest.buildId).pipe(
      Effect.filterOrFail(
        (buildId) => buildId === options.expectedBuildId,
        () => verificationFailure("build-identity-mismatch"),
      ),
    )
    if (
      (options.expectedArchitecture !== undefined &&
        (manifest.desktop.architecture !== options.expectedArchitecture ||
          manifest.runtime.bun.architecture !== options.expectedArchitecture)) ||
      (options.expectedPlatform !== undefined &&
        manifest.desktop.platform !== options.expectedPlatform)
    ) {
      return yield* verificationFailure("runtime-requirements-mismatch")
    }

    const entrypointPath = path.join(artifactDirectory, manifest.entrypoint)
    const canonicalEntrypoint = yield* fileSystem
      .realPath(entrypointPath)
      .pipe(Effect.mapError(() => verificationFailure("entrypoint-invalid")))
    const before = yield* fileSystem.stat(entrypointPath).pipe(
      Effect.mapError(() => verificationFailure("entrypoint-invalid")),
      Effect.filterOrFail(
        (info) =>
          canonicalEntrypoint === entrypointPath &&
          info.type === "File" &&
          info.size <= BigInt(ENTRYPOINT_MAX_BYTES),
        () => verificationFailure("entrypoint-invalid"),
      ),
    )
    const entrypoint = yield* fileSystem
      .readFile(entrypointPath)
      .pipe(Effect.mapError(() => verificationFailure("entrypoint-invalid")))
    yield* Effect.succeed(createHash("sha256").update(entrypoint).digest("hex")).pipe(
      Effect.filterOrFail(
        (checksum) => checksum === manifest.entrypointSha256,
        () => verificationFailure("entrypoint-checksum-mismatch"),
      ),
    )
    const after = yield* fileSystem.stat(entrypointPath).pipe(
      Effect.mapError(() => verificationFailure("entrypoint-invalid")),
      Effect.filterOrFail(
        (info) =>
          info.type === "File" &&
          info.dev === before.dev &&
          sameInode(info.ino, before.ino) &&
          info.size === before.size,
        () => verificationFailure("entrypoint-invalid"),
      ),
    )
    const verifyWorker = (workerEntrypoint: string, checksum: string) =>
      Effect.gen(function* () {
        const workerPath = path.join(artifactDirectory, workerEntrypoint)
        const canonicalPath = yield* fileSystem
          .realPath(workerPath)
          .pipe(Effect.mapError(() => verificationFailure("entrypoint-invalid")))
        const info = yield* fileSystem.stat(workerPath).pipe(
          Effect.mapError(() => verificationFailure("entrypoint-invalid")),
          Effect.filterOrFail(
            (workerInfo) =>
              canonicalPath === workerPath &&
              workerInfo.type === "File" &&
              workerInfo.size <= BigInt(ENTRYPOINT_MAX_BYTES),
            () => verificationFailure("entrypoint-invalid"),
          ),
        )
        const bytes = yield* fileSystem
          .readFile(workerPath)
          .pipe(Effect.mapError(() => verificationFailure("entrypoint-invalid")))
        yield* Effect.succeed(createHash("sha256").update(bytes).digest("hex")).pipe(
          Effect.filterOrFail(
            (actual) => actual === checksum,
            () => verificationFailure("entrypoint-checksum-mismatch"),
          ),
        )
        return info
      })
    yield* verifyWorker(
      manifest.reviewWorker.node.entrypoint,
      manifest.reviewWorker.node.entrypointSha256,
    )
    yield* verifyWorker(
      manifest.reviewWorker.bun.entrypoint,
      manifest.reviewWorker.bun.entrypointSha256,
    )
    const expectedWorkerBuildId = `review-worker-v1-${manifest.reviewWorker.node.entrypointSha256.slice(0, 20)}-${manifest.reviewWorker.bun.entrypointSha256.slice(0, 20)}`
    if (manifest.reviewWorker.buildId !== expectedWorkerBuildId)
      return yield* verificationFailure("build-identity-mismatch")

    return new VerifiedCoreArtifact({
      buildId: manifest.buildId,
      entrypointPath,
      entrypointSha256: manifest.entrypointSha256,
      device: after.dev,
      inode: after.ino,
      size: after.size,
      runtime: manifest.runtime,
    })
  })

/** Verifies the packaged artifact against the build identity embedded in Desktop. */
export const verifyPackagedCoreArtifact = (artifactDirectory: string) =>
  verifyCoreArtifact({
    artifactDirectory,
    expectedBuildId: EMBEDDED_CORE_BUILD_ID,
    expectedArchitecture: process.arch,
    expectedPlatform: process.platform,
  })

/** Revalidates that the verified entrypoint has not been replaced before launch. */
export const revalidateCoreArtifact = (
  artifact: VerifiedCoreArtifact,
): Effect.Effect<void, CoreArtifactVerificationError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const info = yield* fileSystem.stat(artifact.entrypointPath).pipe(
      Effect.filterOrFail(
        (value) =>
          value.type === "File" &&
          value.dev === artifact.device &&
          sameInode(value.ino, artifact.inode) &&
          value.size === artifact.size,
        () => verificationFailure("entrypoint-invalid"),
      ),
    )
    const bytes = yield* fileSystem.readFile(artifact.entrypointPath)
    yield* Effect.succeed(createHash("sha256").update(bytes).digest("hex")).pipe(
      Effect.filterOrFail(
        (checksum) => checksum === artifact.entrypointSha256,
        () => verificationFailure("entrypoint-checksum-mismatch"),
      ),
    )
    const after = yield* fileSystem.stat(artifact.entrypointPath)
    yield* Effect.succeed(after).pipe(
      Effect.filterOrFail(
        (value) =>
          value.type === "File" &&
          value.dev === info.dev &&
          sameInode(value.ino, info.ino) &&
          value.size === info.size,
        () => verificationFailure("entrypoint-invalid"),
      ),
    )
  }).pipe(
    Effect.catchTag("PlatformError", () => Effect.fail(verificationFailure("entrypoint-invalid"))),
  )
