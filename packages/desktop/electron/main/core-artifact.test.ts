import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { createHash } from "node:crypto"
import { mkdtempSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { revalidateCoreArtifact, verifyCoreArtifact } from "./core-artifact"

const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const buildId = "desktop-build-1"
const entrypoint = "export const core = true\n"
const checksum = createHash("sha256").update(entrypoint).digest("hex")
const workerEntrypoint = "export const worker = true\n"
const workerChecksum = createHash("sha256").update(workerEntrypoint).digest("hex")
const workerBuildId = `review-worker-v1-${workerChecksum.slice(0, 20)}-${workerChecksum.slice(0, 20)}`

const writeArtifact = (manifest: object, contents = entrypoint) => {
  const directory = mkdtempSync(join(tmpdir(), "dd-core-artifact-"))
  writeFileSync(join(directory, "core.mjs"), contents)
  writeFileSync(join(directory, "review-worker-node.mjs"), workerEntrypoint)
  writeFileSync(join(directory, "review-worker-bun.mjs"), workerEntrypoint)
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest))
  return directory
}

const validManifest = {
  schemaVersion: 1,
  buildId,
  desktop: {
    version: "0.8.1",
    mode: "production",
    platform: process.platform,
    architecture: process.arch,
  },
  entrypoint: "core.mjs",
  entrypointSha256: checksum,
  reviewWorker: {
    buildId: workerBuildId,
    node: { entrypoint: "review-worker-node.mjs", entrypointSha256: workerChecksum },
    bun: { entrypoint: "review-worker-bun.mjs", entrypointSha256: workerChecksum },
  },
  runtime: { utility: true, bun: { minimumVersion: "1.2.0", architecture: process.arch } },
} as const

describe("Core artifact verification", () => {
  it.effect("returns the canonical identity of an exact verified artifact", () =>
    Effect.gen(function* () {
      const directory = writeArtifact(validManifest)
      const artifact = yield* verifyCoreArtifact({
        artifactDirectory: directory,
        expectedBuildId: buildId,
      })

      expect(artifact).toMatchObject({
        buildId,
        entrypointPath: realpathSync(join(directory, "core.mjs")),
        entrypointSha256: checksum,
        runtime: {
          utility: true,
          bun: { minimumVersion: "1.2.0", architecture: process.arch },
        },
      })
      yield* revalidateCoreArtifact(artifact)
    }).pipe(Effect.provide(platformLayer)),
  )

  it.effect("rejects malformed manifests, build mismatches, and tampered entrypoints", () =>
    Effect.gen(function* () {
      const malformed = writeArtifact({ ...validManifest, entrypoint: "../core.mjs" })
      const wrongBuild = writeArtifact(validManifest)
      const tampered = writeArtifact(validManifest, "tampered")

      expect(
        yield* verifyCoreArtifact({ artifactDirectory: malformed, expectedBuildId: buildId }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ reason: "manifest-invalid" })
      expect(
        yield* verifyCoreArtifact({
          artifactDirectory: wrongBuild,
          expectedBuildId: "desktop-build-2",
        }).pipe(Effect.flip),
      ).toMatchObject({ reason: "build-identity-mismatch" })
      expect(
        yield* verifyCoreArtifact({ artifactDirectory: tampered, expectedBuildId: buildId }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ reason: "entrypoint-checksum-mismatch" })
    }).pipe(Effect.provide(platformLayer)),
  )

  it.effect("rejects a missing artifact without exposing its path", () =>
    Effect.gen(function* () {
      const directory = join(mkdtempSync(join(tmpdir(), "dd-core-artifact-missing-")), "missing")
      const failure = yield* verifyCoreArtifact({
        artifactDirectory: directory,
        expectedBuildId: buildId,
      }).pipe(Effect.flip)

      expect(failure.reason).toBe("artifact-directory-invalid")
      expect(JSON.stringify(failure)).not.toContain(directory)
    }).pipe(Effect.provide(platformLayer)),
  )

  it.effect("rejects symlinked entrypoints and oversized manifests without exposing paths", () =>
    Effect.gen(function* () {
      const directory = writeArtifact(validManifest)
      const target = join(directory, "target.mjs")
      renameSync(join(directory, "core.mjs"), target)
      symlinkSync(target, join(directory, "core.mjs"))
      const symlinkFailure = yield* verifyCoreArtifact({
        artifactDirectory: directory,
        expectedBuildId: buildId,
      }).pipe(Effect.flip)

      const oversized = writeArtifact(validManifest)
      writeFileSync(join(oversized, "manifest.json"), " ".repeat(16 * 1_024 + 1))
      const oversizedFailure = yield* verifyCoreArtifact({
        artifactDirectory: oversized,
        expectedBuildId: buildId,
      }).pipe(Effect.flip)

      expect(symlinkFailure.reason).toBe("entrypoint-invalid")
      expect(oversizedFailure.reason).toBe("manifest-invalid")
      expect(JSON.stringify(symlinkFailure)).not.toContain(directory)
      expect(JSON.stringify(oversizedFailure)).not.toContain(oversized)
    }).pipe(Effect.provide(platformLayer)),
  )

  it.effect("detects replacement after verification", () =>
    Effect.gen(function* () {
      const directory = writeArtifact(validManifest)
      const artifact = yield* verifyCoreArtifact({
        artifactDirectory: directory,
        expectedBuildId: buildId,
      })
      const replacement = join(directory, "replacement.mjs")
      writeFileSync(replacement, entrypoint)
      renameSync(replacement, artifact.entrypointPath)

      expect(yield* revalidateCoreArtifact(artifact).pipe(Effect.flip)).toMatchObject({
        reason: "entrypoint-invalid",
      })
    }).pipe(Effect.provide(platformLayer)),
  )
})
