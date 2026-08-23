import { createHash } from "node:crypto"
import { Array as EffectArray, Effect, FileSystem, Option, Order, Path, Schema } from "effect"
import type { PlatformError } from "effect"
import { CoreArtifactManifest } from "./core-artifact-manifest"

export { CoreArtifactManifest } from "./core-artifact-manifest"

const EMBEDDED_CORE_BUILD_ID = process.env.DIFFDASH_CORE_BUILD_ID ?? ""

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
  buildId: CoreArtifactManifest.fields.buildId,
  entrypointPath: Schema.String,
  entrypointSha256: CoreArtifactManifest.fields.entrypointSha256,
  device: Schema.Number,
  inode: Schema.Option(Schema.Number),
  size: Schema.BigInt,
  bunEntrypointPath: Schema.String,
  bunEntrypointSha256: CoreArtifactManifest.fields.entrypointSha256,
  bunDevice: Schema.Number,
  bunInode: Schema.Option(Schema.Number),
  bunSize: Schema.BigInt,
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
const LANGUAGE_TREE_MAX_BYTES = 64 * 1_024 * 1_024
const LANGUAGE_TREE_MAX_FILES = 512
const JsonManifest = Schema.fromJsonString(CoreArtifactManifest)
const ArtifactTreeEntryInfo = Schema.Union([
  Schema.Struct({ type: Schema.Literal("Directory") }),
  Schema.Struct({ type: Schema.Literal("File"), size: Schema.BigInt }),
  Schema.Struct({ type: Schema.Literal("SymbolicLink") }),
  Schema.Struct({ type: Schema.Literal("BlockDevice") }),
  Schema.Struct({ type: Schema.Literal("CharacterDevice") }),
  Schema.Struct({ type: Schema.Literal("FIFO") }),
  Schema.Struct({ type: Schema.Literal("Socket") }),
  Schema.Struct({ type: Schema.Literal("Unknown") }),
]).pipe(Schema.toTaggedUnion("type"))
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
    const authoredBuildId = `core-${manifest.desktop.version}-${manifest.desktop.mode}-${manifest.desktop.platform}-${manifest.desktop.architecture}-${manifest.entrypointSha256.slice(0, 20)}-${manifest.language.typescript.treeSha256.slice(0, 20)}`
    yield* Effect.succeed(manifest.buildId).pipe(
      Effect.filterOrFail(
        (buildId) => buildId === authoredBuildId,
        () => verificationFailure("build-identity-mismatch"),
      ),
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
          Option.match(info.ino, {
            onNone: () => Option.isNone(before.ino),
            onSome: (inode) => Option.contains(before.ino, inode),
          }) &&
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
    const languageTreeSha256 = yield* Effect.gen(function* () {
      const root = path.join(artifactDirectory, manifest.language.typescript.root)
      const canonicalRoot = yield* fileSystem.realPath(root)
      yield* Effect.succeed(canonicalRoot).pipe(
        Effect.filterOrFail(
          (canonical) => canonical === root,
          () => verificationFailure("entrypoint-invalid"),
        ),
      )

      const collectFiles = (
        directory: string,
        relativeDirectory: string,
      ): Effect.Effect<
        readonly { readonly absolute: string; readonly relative: string; readonly size: bigint }[],
        CoreArtifactVerificationError | PlatformError.PlatformError
      > =>
        Effect.gen(function* () {
          const entries = yield* fileSystem.readDirectory(directory)
          const nested = yield* Effect.forEach(entries, (name) => {
            const absolute = path.join(directory, name)
            const relative = relativeDirectory.length === 0 ? name : `${relativeDirectory}/${name}`
            return Effect.gen(function* () {
              const canonical = yield* fileSystem.realPath(absolute)
              const info = yield* fileSystem.stat(absolute).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(ArtifactTreeEntryInfo)),
                Effect.mapError(() => verificationFailure("entrypoint-invalid")),
              )
              yield* Effect.succeed(canonical).pipe(
                Effect.filterOrFail(
                  (resolved) => resolved === absolute,
                  () => verificationFailure("entrypoint-invalid"),
                ),
              )
              return yield* ArtifactTreeEntryInfo.match(info, {
                Directory: () => collectFiles(absolute, relative),
                File: ({ size }) => Effect.succeed([{ absolute, relative, size }]),
                SymbolicLink: () => verificationFailure("entrypoint-invalid"),
                BlockDevice: () => verificationFailure("entrypoint-invalid"),
                CharacterDevice: () => verificationFailure("entrypoint-invalid"),
                FIFO: () => verificationFailure("entrypoint-invalid"),
                Socket: () => verificationFailure("entrypoint-invalid"),
                Unknown: () => verificationFailure("entrypoint-invalid"),
              })
            })
          })
          return EffectArray.flatten(nested)
        })
      const files = yield* collectFiles(root, "")
      const totalBytes = EffectArray.reduce(files, 0n, (total, file) => total + file.size)
      yield* Effect.succeed(files).pipe(
        Effect.filterOrFail(
          (entries) =>
            entries.length <= LANGUAGE_TREE_MAX_FILES &&
            totalBytes <= BigInt(LANGUAGE_TREE_MAX_BYTES),
          () => verificationFailure("entrypoint-invalid"),
        ),
      )

      const hash = createHash("sha256")
      for (const file of EffectArray.sortWith(files, (entry) => entry.relative, Order.String)) {
        const bytes = yield* fileSystem.readFile(file.absolute)
        yield* Effect.succeed(BigInt(bytes.byteLength)).pipe(
          Effect.filterOrFail(
            (size) => size === file.size,
            () => verificationFailure("entrypoint-invalid"),
          ),
        )
        hash.update(file.relative)
        hash.update("\0")
        hash.update(bytes)
      }
      return hash.digest("hex")
    }).pipe(
      Effect.catchTag("PlatformError", () =>
        Effect.fail(verificationFailure("entrypoint-invalid")),
      ),
    )
    yield* Effect.succeed(languageTreeSha256).pipe(
      Effect.filterOrFail(
        (checksum) => checksum === manifest.language.typescript.treeSha256,
        () => verificationFailure("entrypoint-checksum-mismatch"),
      ),
    )
    const bunEntrypointPath = path.join(artifactDirectory, manifest.runtime.bun.entrypoint)
    const bunInfo = yield* verifyWorker(
      manifest.runtime.bun.entrypoint,
      manifest.runtime.bun.entrypointSha256,
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
      bunEntrypointPath,
      bunEntrypointSha256: manifest.runtime.bun.entrypointSha256,
      bunDevice: bunInfo.dev,
      bunInode: bunInfo.ino,
      bunSize: bunInfo.size,
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
  runtime: "utility" | "bun" = "utility",
): Effect.Effect<void, CoreArtifactVerificationError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const entrypoint =
      runtime === "bun"
        ? {
            path: artifact.bunEntrypointPath,
            checksum: artifact.bunEntrypointSha256,
            device: artifact.bunDevice,
            inode: artifact.bunInode,
            size: artifact.bunSize,
          }
        : {
            path: artifact.entrypointPath,
            checksum: artifact.entrypointSha256,
            device: artifact.device,
            inode: artifact.inode,
            size: artifact.size,
          }
    const info = yield* fileSystem.stat(entrypoint.path).pipe(
      Effect.filterOrFail(
        (value) =>
          value.type === "File" &&
          value.dev === entrypoint.device &&
          Option.match(value.ino, {
            onNone: () => Option.isNone(entrypoint.inode),
            onSome: (inode) => Option.contains(entrypoint.inode, inode),
          }) &&
          value.size === entrypoint.size,
        () => verificationFailure("entrypoint-invalid"),
      ),
    )
    const bytes = yield* fileSystem.readFile(entrypoint.path)
    yield* Effect.succeed(createHash("sha256").update(bytes).digest("hex")).pipe(
      Effect.filterOrFail(
        (checksum) => checksum === entrypoint.checksum,
        () => verificationFailure("entrypoint-checksum-mismatch"),
      ),
    )
    const after = yield* fileSystem.stat(entrypoint.path)
    yield* Effect.succeed(after).pipe(
      Effect.filterOrFail(
        (value) =>
          value.type === "File" &&
          value.dev === info.dev &&
          Option.match(value.ino, {
            onNone: () => Option.isNone(info.ino),
            onSome: (inode) => Option.contains(info.ino, inode),
          }) &&
          value.size === info.size,
        () => verificationFailure("entrypoint-invalid"),
      ),
    )
  }).pipe(
    Effect.catchTag("PlatformError", () => Effect.fail(verificationFailure("entrypoint-invalid"))),
  )
