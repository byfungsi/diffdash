import { createHash } from "node:crypto"
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { Effect, Exit, Match, Option, Schema, Stream } from "effect"

import { LocalReviewTarget } from "@diffdash/domain/local-review"
import { ReviewDiffIdentity, ReviewKey, ReviewRevision } from "@diffdash/domain/review-identity"
import {
  LocalReviewDiffSourceTarget,
  MaterializedGitMethod,
  REVIEW_DIFF_MAX_CHUNK_BYTES,
  ReviewDiffAcquisition,
  ReviewDiffByteCompletion,
  ReviewDiffGeneration,
  ReviewDiffGenerationTracker,
  ReviewDiffMaterializedGit,
  ReviewDiffMethodUnsupported,
  type ReviewDiffSource,
  type ReviewDiffSourceError,
  type ReviewDiffSourceMethod,
  ReviewDiffSourceFacts,
  ReviewDiffSourceFailure,
  ReviewDiffSourceOffer,
  UnifiedBytesMethod,
} from "@diffdash/git-provider"
import { ProcessService, type ProcessExecutionError } from "@diffdash/process"
import { gitProcessRequest } from "./git-environment"

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
const DIFF_POLICY_IDENTITY = "local-git-unified-v1"
const MAX_CAPTURE_ATTEMPTS = 2
const MAX_PATH_BYTES = 16 * 1024

/** Inputs needed to create one coherent local review source. */
export interface LocalReviewDiffSourceInput {
  readonly reviewKey: ReviewKey
  readonly target: LocalReviewTarget
}

interface Capture {
  readonly path: string
  readonly bytes: number
  readonly digest: string
}

interface ExactObjects {
  readonly base: string
  readonly head: string
  readonly repository: string
}

/** Creates a bounded local Git source, spooling mutable generations and retaining exact objects otherwise. */
export const makeLocalReviewDiffSource = Effect.fn("makeLocalReviewDiffSource")(function* (
  input: LocalReviewDiffSourceInput,
): Effect.fn.Return<ReviewDiffSource, ReviewDiffSourceFailure, ProcessService> {
  const processes = yield* ProcessService
  const target = input.target
  const immutable = target.comparison._tag === "lastCommit"
  const exactObjects = immutable
    ? yield* resolveExactObjects(target, processes).pipe(Effect.mapError(sourceCreationFailure))
    : null

  if (exactObjects !== null) {
    const digest = yield* digestDiff(target, processes).pipe(Effect.mapError(sourceCreationFailure))
    const comparison = target.comparison
    if (comparison._tag !== "lastCommit") return yield* Effect.die("Expected last commit")
    return makeSource({
      input,
      processes,
      semanticIdentity: ReviewDiffIdentity.make(digest.digest),
      revision: comparison.headSha,
      totalBytes: digest.bytes,
      exactObjects,
      capture: null,
    })
  }

  const capture = yield* captureVerified(target, processes)
  return makeSource({
    input,
    processes,
    semanticIdentity: ReviewDiffIdentity.make(capture.digest),
    revision: ReviewRevision.make(capture.digest),
    totalBytes: capture.bytes,
    exactObjects: null,
    capture,
  })
})

const captureVerified = Effect.fn("LocalReviewDiffSource.captureVerified")(function* (
  target: LocalReviewTarget,
  processes: ProcessService["Service"],
): Effect.fn.Return<Capture, ReviewDiffSourceFailure> {
  for (let attempt = 0; attempt < MAX_CAPTURE_ATTEMPTS; attempt += 1) {
    const directory = yield* tryPromise("unifiedBytes", () =>
      mkdtemp(join(tmpdir(), "diffdash-review-source-")),
    )
    const path = join(directory, "review.diff")
    const capture = yield* writeCapture(path, target, processes).pipe(
      Effect.ensuring(Effect.void),
      Effect.onError(() => removePath(directory)),
      Effect.onInterrupt(() => removePath(directory)),
    )
    const verified = yield* digestDiff(target, processes).pipe(
      Effect.mapError(sourceCreationFailure),
      Effect.onInterrupt(() => removePath(directory)),
      Effect.result,
    )
    if (
      verified._tag === "Success" &&
      verified.success.digest === capture.digest &&
      verified.success.bytes === capture.bytes
    ) {
      return capture
    }
    yield* removePath(directory)
  }
  return yield* ReviewDiffSourceFailure.make({
    generation: ReviewDiffGeneration.make("local-capture-exhausted"),
    method: "unifiedBytes",
    message: "Local review changed during bounded capture verification",
  })
})

const writeCapture = Effect.fn("LocalReviewDiffSource.writeCapture")(function* (
  path: string,
  target: LocalReviewTarget,
  processes: ProcessService["Service"],
): Effect.fn.Return<Capture, ReviewDiffSourceFailure> {
  const handle = yield* tryPromise("unifiedBytes", () => open(path, "wx", 0o600))
  const hash = comparisonHash(target)
  let bytes = 0
  yield* diffBytes(target, processes).pipe(
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        yield* tryPromise("unifiedBytes", () => handle.write(chunk))
        hash.update(chunk)
        bytes += chunk.byteLength
      }),
    ),
    Effect.mapError(sourceCreationFailure),
    Effect.ensuring(closeHandle(handle)),
  )
  return { path, bytes, digest: hash.digest("hex") }
})

const digestDiff = Effect.fn("LocalReviewDiffSource.digestDiff")(function* (
  target: LocalReviewTarget,
  processes: ProcessService["Service"],
): Effect.fn.Return<
  { readonly bytes: number; readonly digest: string },
  ProcessExecutionError | ReviewDiffSourceFailure
> {
  const hash = comparisonHash(target)
  let bytes = 0
  yield* diffBytes(target, processes).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        hash.update(chunk)
        bytes += chunk.byteLength
      }),
    ),
  )
  return { bytes, digest: hash.digest("hex") }
})

const comparisonHash = (target: LocalReviewTarget) => {
  const hash = createHash("sha256")
  return Match.value(target.comparison).pipe(
    Match.tag("branch", (comparison) =>
      hash
        .update("branch\0")
        .update(comparison.baseRef)
        .update("\0")
        .update(comparison.baseSha)
        .update("\0"),
    ),
    Match.tag("workingTree", () => hash),
    Match.tag("lastCommit", (comparison) =>
      hash
        .update("lastCommit\0")
        .update(comparison.baseSha)
        .update("\0")
        .update(comparison.headSha)
        .update("\0"),
    ),
    Match.exhaustive,
  )
}

const diffBytes = (
  target: LocalReviewTarget,
  processes: ProcessService["Service"],
): Stream.Stream<Uint8Array, ProcessExecutionError | ReviewDiffSourceFailure> =>
  target.comparison._tag === "lastCommit"
    ? processStdout(
        processes,
        [
          "-C",
          target.rootPath,
          "diff",
          "--no-ext-diff",
          "--no-color",
          target.comparison.baseSha,
          target.comparison.headSha,
          "--",
        ],
        target.rootPath,
      )
    : Stream.concat(
        processStdout(
          processes,
          [
            "-C",
            target.rootPath,
            "diff",
            "--no-ext-diff",
            "--no-color",
            ...(target.comparison._tag === "branch" ? [target.comparison.baseSha] : ["HEAD"]),
            "--",
          ],
          target.rootPath,
        ),
        untrackedPaths(target.rootPath, processes).pipe(
          Stream.flatMap(
            (path) =>
              processStdout(
                processes,
                ["diff", "--no-ext-diff", "--no-color", "--no-index", "--", "/dev/null", path],
                target.rootPath,
                true,
              ),
            { concurrency: 1 },
          ),
        ),
      )

const processStdout = (
  processes: ProcessService["Service"],
  args: readonly string[],
  cwd: string,
  acceptDifferenceExit = false,
): Stream.Stream<Uint8Array, ProcessExecutionError> =>
  processes
    .streamBytes(
      gitProcessRequest(args, {
        cwd,
        timeoutMs: 60_000,
        stdout: { maxBytes: 1, overflow: "truncate" },
        stderr: { maxBytes: 64 * 1024, overflow: "truncate" },
        maxByteChunkBytes: REVIEW_DIFF_MAX_CHUNK_BYTES,
        maxBufferedBytes: REVIEW_DIFF_MAX_CHUNK_BYTES * 2,
        maxReservedBytes: REVIEW_DIFF_MAX_CHUNK_BYTES * 2,
      }),
    )
    .pipe(
      Stream.flatMap((event) =>
        event._tag === "ProcessByteChunk" ? Stream.make(event.bytes) : Stream.empty,
      ),
      Stream.catchTag("ProcessExitError", (error) =>
        acceptDifferenceExit && error.exitCode === 1 ? Stream.empty : Stream.fail(error),
      ),
    )

const untrackedPaths = (
  rootPath: string,
  processes: ProcessService["Service"],
): Stream.Stream<string, ProcessExecutionError | ReviewDiffSourceFailure> =>
  Stream.suspend(() => {
    const decoder = new TextDecoder()
    return processStdout(
      processes,
      ["-C", rootPath, "ls-files", "--others", "--exclude-standard", "-z"],
      rootPath,
    ).pipe(
      Stream.mapAccum(
        () => "",
        (remainder, chunk) => {
          const decoded = remainder + decoder.decode(chunk, { stream: true })
          const parts = decoded.split("\0")
          const next = parts.pop() ?? ""
          return [next, parts.filter((path) => path.length > 0)] as const
        },
      ),
      Stream.mapEffect((path) =>
        new TextEncoder().encode(path).byteLength <= MAX_PATH_BYTES
          ? Effect.succeed(path)
          : Effect.fail(
              sourceFailure(
                "unifiedBytes",
                "Git returned an untracked path outside the bounded path limit",
              ),
            ),
      ),
      Stream.mapError((error) =>
        Schema.is(ReviewDiffSourceFailure)(error) ? error : sourceCreationFailure(error),
      ),
    )
  })

const resolveExactObjects = Effect.fn("LocalReviewDiffSource.resolveExactObjects")(function* (
  target: LocalReviewTarget,
  processes: ProcessService["Service"],
): Effect.fn.Return<ExactObjects, ProcessExecutionError> {
  if (target.comparison._tag !== "lastCommit") return yield* Effect.die("Expected last commit")
  const [base, head, commonDirectory] = yield* Effect.all(
    [
      resolveObject(target.rootPath, target.comparison.baseSha, processes),
      resolveObject(target.rootPath, target.comparison.headSha, processes),
      processes.run(
        gitProcessRequest([
          "-C",
          target.rootPath,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]),
      ),
    ],
    { concurrency: 1 },
  )
  return {
    base,
    head,
    repository: createHash("sha256").update(commonDirectory.stdout.trim()).digest("hex"),
  }
})

const resolveObject = Effect.fn("LocalReviewDiffSource.resolveObject")(function* (
  rootPath: string,
  revision: string,
  processes: ProcessService["Service"],
): Effect.fn.Return<string, ProcessExecutionError> {
  const expression = revision === EMPTY_TREE_SHA ? revision : `${revision}^{commit}`
  const result = yield* processes.run(
    gitProcessRequest(["-C", rootPath, "rev-parse", "--verify", "--end-of-options", expression]),
  )
  return result.stdout.trim()
})

const makeSource = (state: {
  readonly input: LocalReviewDiffSourceInput
  readonly processes: ProcessService["Service"]
  readonly semanticIdentity: ReviewDiffIdentity
  readonly revision: ReviewRevision
  readonly totalBytes: number
  readonly exactObjects: ExactObjects | null
  readonly capture: Capture | null
}): ReviewDiffSource => {
  const tracker = new ReviewDiffGenerationTracker()
  let closed = false
  const close = Effect.fn("LocalReviewDiffSource.close")(function* () {
    if (closed) return
    closed = true
    if (state.capture !== null) yield* removePath(dirname(state.capture.path))
  })().pipe(
    Effect.mapError(() => sourceFailure("unifiedBytes", "Could not release review staging")),
  )
  const methods: ReviewDiffSourceMethod[] = [
    UnifiedBytesMethod.make({ maxChunkBytes: REVIEW_DIFF_MAX_CHUNK_BYTES }),
  ]
  if (state.exactObjects !== null) methods.push(MaterializedGitMethod.make({}))
  const offer = ReviewDiffSourceOffer.make({
    target: LocalReviewDiffSourceTarget.make({
      reviewKey: state.input.reviewKey,
      target: state.input.target,
    }),
    expectedRevision: state.revision,
    semanticIdentity: state.semanticIdentity,
    methods,
    facts: ReviewDiffSourceFacts.make({
      origin: "local",
      revisionKind: state.exactObjects === null ? "mutable" : "immutableGit",
      reproducible: state.exactObjects !== null,
      complete: true,
      declaredBytes: state.totalBytes,
    }),
  })

  return {
    offer,
    unifiedBytes: (acquisition) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* beginAcquisition(acquisition, state.revision, tracker, "unifiedBytes")
          yield* Effect.addFinalizer((exit) =>
            Exit.hasInterrupts(exit) ? close.pipe(Effect.ignore) : Effect.void,
          )
          const byteStream: Stream.Stream<Uint8Array, ReviewDiffSourceError> =
            state.capture === null
              ? diffBytes(state.input.target, state.processes).pipe(
                  Stream.mapError((error) =>
                    Schema.is(ReviewDiffSourceFailure)(error)
                      ? error
                      : sourceCreationFailure(error),
                  ),
                )
              : spoolBytes(state.capture.path)
          return byteStream.pipe(
            Stream.map((bytes) => ({ bytes })),
            Stream.concat(
              Stream.make(
                ReviewDiffByteCompletion.make({
                  generation: acquisition.generation,
                  revision: state.revision,
                  semanticIdentity: state.semanticIdentity,
                  totalBytes: state.totalBytes,
                }),
              ),
            ),
          )
        }),
      ),
    filePage: (acquisition) => unsupported(acquisition, "filePages"),
    materializedGit: (acquisition) =>
      Effect.gen(function* () {
        yield* beginAcquisition(acquisition, state.revision, tracker, "materializedGit")
        if (state.exactObjects === null)
          return yield* unsupported<ReviewDiffMaterializedGit>(acquisition, "materializedGit")
        return ReviewDiffMaterializedGit.make({
          generation: acquisition.generation,
          revision: state.revision,
          semanticIdentity: state.semanticIdentity,
          repositoryIdentity: state.exactObjects.repository,
          baseObject: state.exactObjects.base,
          headObject: state.exactObjects.head,
          diffPolicyIdentity: DIFF_POLICY_IDENTITY,
        })
      }),
    bufferedBytes: (acquisition) => unsupported(acquisition, "bufferedBytes"),
    close,
  }
}

const beginAcquisition = (
  acquisition: ReviewDiffAcquisition,
  revision: ReviewRevision,
  tracker: ReviewDiffGenerationTracker,
  method: "unifiedBytes" | "filePages" | "materializedGit" | "bufferedBytes",
): Effect.Effect<void, ReviewDiffSourceError> =>
  acquisition.expectedRevision !== revision
    ? Effect.fail(sourceFailure(method, "Review diff acquisition expected another local revision"))
    : tracker.begin(acquisition.generation).pipe(Effect.asVoid)

const unsupported = <A>(
  acquisition: ReviewDiffAcquisition,
  method: "filePages" | "materializedGit" | "bufferedBytes",
): Effect.Effect<A, ReviewDiffMethodUnsupported> =>
  ReviewDiffMethodUnsupported.make({
    generation: acquisition.generation,
    method,
    message: `Local Git does not offer ${method} for this generation`,
  })

const spoolBytes = (path: string): Stream.Stream<Uint8Array, ReviewDiffSourceFailure> =>
  Stream.unwrap(
    Effect.acquireRelease(
      tryPromise("unifiedBytes", () => open(path, "r")),
      closeHandle,
    ).pipe(
      Effect.map((handle) =>
        Stream.paginate(0, (position) =>
          tryPromise("unifiedBytes", async () => {
            const buffer = new Uint8Array(REVIEW_DIFF_MAX_CHUNK_BYTES)
            const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position)
            return bytesRead === 0
              ? ([[], Option.none<number>()] as const)
              : ([[buffer.slice(0, bytesRead)], Option.some(position + bytesRead)] as const)
          }),
        ),
      ),
    ),
  )

const closeHandle = (handle: FileHandle): Effect.Effect<void> =>
  Effect.promise(() => handle.close()).pipe(Effect.ignore)

const removePath = (path: string): Effect.Effect<void> =>
  Effect.promise(() => rm(path, { force: true, recursive: true })).pipe(Effect.ignore)

const tryPromise = <A>(
  method: "unifiedBytes" | "materializedGit",
  evaluate: () => Promise<A>,
): Effect.Effect<A, ReviewDiffSourceFailure> =>
  Effect.tryPromise({
    try: evaluate,
    catch: () => sourceFailure(method, "Local review staging operation failed"),
  })

const sourceCreationFailure = (_cause: unknown): ReviewDiffSourceFailure =>
  sourceFailure("unifiedBytes", "Local Git could not produce a coherent review source")

const sourceFailure = (
  method: "unifiedBytes" | "filePages" | "materializedGit" | "bufferedBytes",
  message: string,
): ReviewDiffSourceFailure =>
  ReviewDiffSourceFailure.make({
    generation: ReviewDiffGeneration.make("local-source"),
    method,
    message,
  })
