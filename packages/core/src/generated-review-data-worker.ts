import { BunReviewDataWorkerRuntime, type BunWorkerHandle } from "@diffdash/review-data-worker/bun"
import { NodeReviewDataWorkerRuntime } from "@diffdash/review-data-worker/node"
import { createHash } from "node:crypto"
import { readFile, realpath, stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Effect, Layer, Schema } from "effect"

import { coreReviewDataWorkerLayer } from "./review-data-worker-coordinator"

declare const DIFFDASH_REVIEW_WORKER_BUILD_ID: string
declare const DIFFDASH_REVIEW_WORKER_NODE_SHA256: string
declare const DIFFDASH_REVIEW_WORKER_BUN_SHA256: string

/** Sanitized rejection of a staged review-worker artifact before Core composition. */
export class CoreReviewDataWorkerArtifactError extends Schema.TaggedError<CoreReviewDataWorkerArtifactError>()(
  "CoreReviewDataWorkerArtifactError",
  {
    reason: Schema.Literals(["build-identity-invalid", "entrypoint-invalid", "checksum-mismatch"]),
    safeMessage: Schema.Literal("DiffDash Core could not verify its review worker."),
  },
) {}

const artifactFailure = (reason: CoreReviewDataWorkerArtifactError["reason"]) =>
  CoreReviewDataWorkerArtifactError.make({
    reason,
    safeMessage: "DiffDash Core could not verify its review worker.",
  })

const isBunHost = (): boolean => "Bun" in globalThis

const startBunWorker = (moduleUrl: URL): BunWorkerHandle => {
  const worker = new Worker(moduleUrl, { type: "module" })
  return {
    postMessage: (command, transfer = []) => worker.postMessage(command, [...transfer]),
    onMessage: (listener) => {
      const receive = (event: MessageEvent): void => listener(event.data)
      worker.addEventListener("message", receive)
      return () => worker.removeEventListener("message", receive)
    },
    onError: (listener) => {
      const fail = (event: ErrorEvent): void => listener(event.error)
      worker.addEventListener("error", fail)
      return () => worker.removeEventListener("error", fail)
    },
    terminate: () => worker.terminate(),
  }
}

/** Verifies and composes the staged worker matching the current standalone Core host. */
export const generatedCoreReviewDataWorkerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const bunHost = isBunHost()
    const expectedChecksum = bunHost
      ? DIFFDASH_REVIEW_WORKER_BUN_SHA256
      : DIFFDASH_REVIEW_WORKER_NODE_SHA256
    const expectedBuildId = `review-worker-v1-${DIFFDASH_REVIEW_WORKER_NODE_SHA256.slice(0, 20)}-${DIFFDASH_REVIEW_WORKER_BUN_SHA256.slice(0, 20)}`
    if (DIFFDASH_REVIEW_WORKER_BUILD_ID !== expectedBuildId)
      return yield* artifactFailure("build-identity-invalid")

    const moduleUrl = new URL(
      bunHost ? "./review-worker-bun.mjs" : "./review-worker-node.mjs",
      import.meta.url,
    )
    const requestedPath = resolve(fileURLToPath(moduleUrl))
    const verifiedPath = yield* Effect.tryPromise({
      try: async () => {
        const canonicalPath = await realpath(requestedPath)
        if (dirname(canonicalPath) !== dirname(requestedPath))
          throw new Error("Worker escaped artifact")
        const before = await stat(canonicalPath)
        if (!before.isFile() || before.size > 16 * 1_024 * 1_024)
          throw new Error("Worker entrypoint invalid")
        const bytes = await readFile(canonicalPath)
        if (createHash("sha256").update(bytes).digest("hex") !== expectedChecksum)
          throw artifactFailure("checksum-mismatch")
        const after = await stat(canonicalPath)
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs
        )
          throw new Error("Worker changed during verification")
        return canonicalPath
      },
      catch: (cause) =>
        Schema.is(CoreReviewDataWorkerArtifactError)(cause)
          ? cause
          : artifactFailure("entrypoint-invalid"),
    })
    const verifiedUrl = pathToFileURL(verifiedPath)
    const runtime = bunHost
      ? new BunReviewDataWorkerRuntime(startBunWorker)
      : new NodeReviewDataWorkerRuntime()
    return coreReviewDataWorkerLayer({ runtime, moduleUrl: verifiedUrl })
  }),
)
