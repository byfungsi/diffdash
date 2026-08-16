import { createHash } from "node:crypto"

import { Effect, Stream } from "effect"

import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryComparisonTarget } from "@diffdash/domain/repository-comparison"
import { ReviewDiffIdentity, ReviewKey, ReviewRevision } from "@diffdash/domain/review-identity"
import {
  MaterializedGitMethod,
  REVIEW_DIFF_MAX_CHUNK_BYTES,
  RepositoryComparisonDiffSourceTarget,
  ReviewDiffAcquisition,
  ReviewDiffByteCompletion,
  ReviewDiffGeneration,
  ReviewDiffGenerationTracker,
  ReviewDiffMaterializedGit,
  ReviewDiffMethodUnsupported,
  type ReviewDiffSource,
  type ReviewDiffSourceError,
  ReviewDiffSourceFacts,
  ReviewDiffSourceFailure,
  ReviewDiffSourceOffer,
  UnifiedBytesMethod,
} from "@diffdash/git-provider"
import { ProcessService, type ProcessExecutionError } from "@diffdash/process"
import { gitProcessRequest } from "./git-environment"

const DIFF_POLICY_IDENTITY = "repository-comparison-git-unified-v1"

/** Runtime coordinates needed to open one exact repository-comparison source. */
export interface RepositoryComparisonReviewDiffSourceInput {
  readonly reviewKey: ReviewKey
  readonly target: RepositoryComparisonTarget
  readonly repositoryPath: RepositoryCheckoutPath
}

/** Opens a bounded exact-Git source for one already pinned repository comparison. */
export const makeRepositoryComparisonReviewDiffSource = Effect.fn(
  "makeRepositoryComparisonReviewDiffSource",
)(function* (
  input: RepositoryComparisonReviewDiffSourceInput,
): Effect.fn.Return<ReviewDiffSource, ReviewDiffSourceFailure, ProcessService> {
  const processes = yield* ProcessService
  const [baseObject, headObject, repositoryIdentity] = yield* Effect.all(
    [
      resolveObject(input.repositoryPath, input.target.mergeBaseSha, processes),
      resolveObject(input.repositoryPath, input.target.headSha, processes),
      processes.run(
        gitProcessRequest([
          "-C",
          input.repositoryPath,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]),
      ),
    ],
    { concurrency: 1 },
  ).pipe(Effect.mapError(sourceCreationFailure))
  const measured = yield* digestDiff(input, processes).pipe(Effect.mapError(sourceCreationFailure))
  const revision = ReviewRevision.make(input.target.headSha)
  const semanticIdentity = ReviewDiffIdentity.make(measured.digest)
  const generations = new ReviewDiffGenerationTracker()
  const offer = ReviewDiffSourceOffer.make({
    target: RepositoryComparisonDiffSourceTarget.make({
      reviewKey: input.reviewKey,
      target: input.target,
    }),
    expectedRevision: revision,
    semanticIdentity,
    methods: [
      UnifiedBytesMethod.make({ maxChunkBytes: REVIEW_DIFF_MAX_CHUNK_BYTES }),
      MaterializedGitMethod.make({}),
    ],
    facts: ReviewDiffSourceFacts.make({
      origin: "local",
      revisionKind: "immutableGit",
      reproducible: true,
      complete: true,
      declaredBytes: measured.bytes,
    }),
  })

  return {
    offer,
    unifiedBytes: (acquisition) =>
      Stream.unwrap(
        beginAcquisition(acquisition, revision, generations, "unifiedBytes").pipe(
          Effect.as(
            diffBytes(input, processes).pipe(
              Stream.mapError(sourceCreationFailure),
              Stream.map((bytes) => ({ bytes })),
              Stream.concat(
                Stream.make(
                  ReviewDiffByteCompletion.make({
                    generation: acquisition.generation,
                    revision,
                    semanticIdentity,
                    totalBytes: measured.bytes,
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    filePage: (acquisition) => unsupported(acquisition, "filePages"),
    materializedGit: (acquisition) =>
      beginAcquisition(acquisition, revision, generations, "materializedGit").pipe(
        Effect.as(
          ReviewDiffMaterializedGit.make({
            generation: acquisition.generation,
            revision,
            semanticIdentity,
            repositoryIdentity: createHash("sha256")
              .update(repositoryIdentity.stdout.trim())
              .digest("hex"),
            baseObject,
            headObject,
            diffPolicyIdentity: DIFF_POLICY_IDENTITY,
          }),
        ),
      ),
    bufferedBytes: (acquisition) => unsupported(acquisition, "bufferedBytes"),
    close: Effect.void,
  }
})

const digestDiff = Effect.fn("RepositoryComparisonReviewDiffSource.digestDiff")(function* (
  input: RepositoryComparisonReviewDiffSourceInput,
  processes: ProcessService["Service"],
): Effect.fn.Return<{ readonly bytes: number; readonly digest: string }, ProcessExecutionError> {
  const hash = createHash("sha256")
    .update("repositoryComparison\0")
    .update(input.target.mergeBaseSha)
    .update("\0")
    .update(input.target.headSha)
    .update("\0")
  let bytes = 0
  yield* diffBytes(input, processes).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        hash.update(chunk)
        bytes += chunk.byteLength
      }),
    ),
  )
  return { bytes, digest: hash.digest("hex") }
})

const diffBytes = (
  input: RepositoryComparisonReviewDiffSourceInput,
  processes: ProcessService["Service"],
): Stream.Stream<Uint8Array, ProcessExecutionError> =>
  processes
    .streamBytes(
      gitProcessRequest(
        [
          "-C",
          input.repositoryPath,
          "diff",
          "--no-ext-diff",
          "--no-color",
          input.target.mergeBaseSha,
          input.target.headSha,
          "--",
        ],
        {
          cwd: input.repositoryPath,
          timeoutMs: 60_000,
          stdout: { maxBytes: 1, overflow: "truncate" },
          stderr: { maxBytes: 64 * 1024, overflow: "truncate" },
          maxByteChunkBytes: REVIEW_DIFF_MAX_CHUNK_BYTES,
          maxBufferedBytes: REVIEW_DIFF_MAX_CHUNK_BYTES * 2,
          maxReservedBytes: REVIEW_DIFF_MAX_CHUNK_BYTES * 2,
        },
      ),
    )
    .pipe(
      Stream.flatMap((event) =>
        event["_tag"] === "ProcessByteChunk" ? Stream.make(event.bytes) : Stream.empty,
      ),
    )

const resolveObject = Effect.fn("RepositoryComparisonReviewDiffSource.resolveObject")(function* (
  repositoryPath: RepositoryCheckoutPath,
  revision: string,
  processes: ProcessService["Service"],
): Effect.fn.Return<string, ProcessExecutionError> {
  const result = yield* processes.run(
    gitProcessRequest([
      "-C",
      repositoryPath,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${revision}^{commit}`,
    ]),
  )
  return result.stdout.trim()
})

const beginAcquisition = (
  acquisition: ReviewDiffAcquisition,
  revision: ReviewRevision,
  generations: ReviewDiffGenerationTracker,
  method: "unifiedBytes" | "materializedGit",
): Effect.Effect<void, ReviewDiffSourceError> =>
  acquisition.expectedRevision === revision
    ? generations.begin(acquisition.generation).pipe(Effect.asVoid)
    : Effect.fail(sourceFailure(method, "Review diff acquisition expected another revision"))

const unsupported = <A>(
  acquisition: ReviewDiffAcquisition,
  method: "filePages" | "bufferedBytes",
): Effect.Effect<A, ReviewDiffMethodUnsupported> =>
  ReviewDiffMethodUnsupported.make({
    generation: acquisition.generation,
    method,
    message: `Repository comparison does not offer ${method} for this generation`,
  })

const sourceCreationFailure = (_cause: unknown): ReviewDiffSourceFailure =>
  sourceFailure("unifiedBytes", "Git could not produce the exact repository comparison")

const sourceFailure = (
  method: "unifiedBytes" | "materializedGit",
  message: string,
): ReviewDiffSourceFailure =>
  ReviewDiffSourceFailure.make({
    generation: ReviewDiffGeneration.make("repository-comparison-source"),
    method,
    message,
  })
