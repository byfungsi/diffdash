import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Deferred, Effect, Fiber, Layer, Result, Stream } from "effect"

import { makeHostedReviewLocator } from "@diffdash/domain/git-provider"
import {
  BranchComparison,
  LastCommitComparison,
  LocalReviewTarget,
} from "@diffdash/domain/local-review"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { ReviewRevision } from "@diffdash/domain/review-identity"
import {
  ReviewDiffAcquisition,
  ReviewDiffByteCompletion,
  ReviewDiffGeneration,
  type ReviewDiffSource,
  ReviewDiffSourceFailure,
} from "@diffdash/git-provider"
import { reviewDiffSourceConformance } from "@diffdash/git-provider/testing"
import { ProcessExit, ProcessResult, ProcessService, type ProcessRequest } from "@diffdash/process"
import { makeLocalReviewDiffSource } from "./local-review-diff-source"
import { sanitizedGitTestEnvironment } from "./test-support/git-environment"

const review = makeHostedReviewLocator("github", "fungsi", "stream-fixture", 231)
const encoder = new TextEncoder()
const fixtureRoot = mkdtempSync(join(tmpdir(), "diffdash-local-source-"))
git(fixtureRoot, "init", "-b", "main")
writeFileSync(join(fixtureRoot, "file.txt"), "old\n")
commitAll(fixtureRoot, "base")
const fixtureBase = git(fixtureRoot, "rev-parse", "HEAD")
writeFileSync(join(fixtureRoot, "file.txt"), "new\n")
commitAll(fixtureRoot, "head")
const fixtureHead = git(fixtureRoot, "rev-parse", "HEAD")
const expectedImmutableBytes = new Uint8Array(
  gitBytes(fixtureRoot, "diff", "--no-ext-diff", "--no-color", fixtureBase, fixtureHead, "--"),
)
let exactSources: ReviewDiffSource[] = []

beforeAll(async () => {
  const target = lastCommitTarget(fixtureRoot, fixtureBase, fixtureHead)
  for (let index = 0; index < 6; index += 1) {
    exactSources.push(
      await Effect.runPromise(
        makeLocalReviewDiffSource({ review, target }).pipe(Effect.provide(ProcessService.layer)),
      ),
    )
  }
})

afterAll(() => {
  rmSync(fixtureRoot, { force: true, recursive: true })
})

const takeExactSource = (): ReviewDiffSource => {
  const source = exactSources.shift()
  if (source === undefined) throw new Error("Local source conformance exhausted its fixtures")
  return source
}

reviewDiffSourceConformance("local exact Git", {
  create: takeExactSource,
  createCancellable: () => {
    let closed = false
    const source = takeExactSource()
    return {
      source: {
        ...source,
        unifiedBytes: (acquisition) =>
          source
            .unifiedBytes(acquisition)
            .pipe(
              Stream.concat(Stream.never),
              Stream.ensuring(Effect.sync(() => void (closed = true))),
            ),
      },
      closed: () => closed,
    }
  },
  expectedBytes: expectedImmutableBytes,
  expectedFiles: [],
})

describe("local review diff source", () => {
  it.effect("spools aggregate tracked and untracked bytes for deterministic backward reads", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-local-mutable-source-"))),
        (path) => Effect.sync(() => rmSync(path, { force: true, recursive: true })),
      )
      git(root, "init", "-b", "main")
      writeFileSync(join(root, "tracked.txt"), "old\n")
      commitAll(root, "base")
      const base = git(root, "rev-parse", "HEAD")
      writeFileSync(join(root, "tracked.txt"), "new\n")
      writeFileSync(join(root, "untracked-a.txt"), "alpha\n")
      writeFileSync(join(root, "untracked-b.txt"), "beta\n")
      const target = branchTarget(root, base)
      const expected = concat([
        gitBytes(root, "diff", "--no-ext-diff", "--no-color", base, "--"),
        acceptedDiffBytes(root, "untracked-a.txt"),
        acceptedDiffBytes(root, "untracked-b.txt"),
      ])
      const source = yield* makeLocalReviewDiffSource({ review, target })

      expect(source.offer.facts).toMatchObject({
        origin: "local",
        revisionKind: "mutable",
        reproducible: false,
        complete: true,
        declaredBytes: expected.byteLength,
      })
      expect(source.offer.methods.map((method) => method._tag)).toEqual(["unifiedBytes"])

      for (const suffix of ["forward", "backward"]) {
        const actual = yield* collectBytes(source, ReviewDiffGeneration.make(`mutable-${suffix}`))
        expect(actual).toEqual(expected)
      }
      yield* source.close
    }).pipe(Effect.provide(ProcessService.layer)),
  )

  it.effect("bounds mutable verification to two fresh capture attempts", () =>
    Effect.gen(function* () {
      let diffRuns = 0
      const processLayer = Layer.succeed(
        ProcessService,
        ProcessService.of({
          run: () => Effect.die("Captured process execution is unused"),
          streamLines: () => Stream.empty,
          streamBytes: (request) => {
            if (request.args.includes("ls-files")) return Stream.make(successfulExit(request))
            diffRuns += 1
            return Stream.make(
              { _tag: "ProcessByteChunk" as const, bytes: encoder.encode(`diff-${diffRuns}`) },
              successfulExit(request),
            )
          },
        }),
      )
      const result = yield* makeLocalReviewDiffSource({
        review,
        target: branchTarget("/workspace/repo", "a".repeat(40)),
      }).pipe(Effect.provide(processLayer), Effect.result)

      expect(diffRuns).toBe(4)
      expect(Result.isFailure(result) && result.failure).toBeInstanceOf(ReviewDiffSourceFailure)
    }),
  )

  it.effect("interrupts an active Git stream before publishing a source", () =>
    Effect.gen(function* () {
      let finalized = false
      const started = yield* Deferred.make<void>()
      const processLayer = Layer.succeed(
        ProcessService,
        ProcessService.of({
          run: () => Effect.die("Captured process execution is unused"),
          streamLines: () => Stream.empty,
          streamBytes: () =>
            Stream.fromEffectDrain(Deferred.succeed(started, undefined)).pipe(
              Stream.concat(Stream.never),
              Stream.ensuring(Effect.sync(() => void (finalized = true))),
            ),
        }),
      )
      const fiber = yield* makeLocalReviewDiffSource({
        review,
        target: branchTarget("/workspace/repo", "a".repeat(40)),
      }).pipe(Effect.provide(processLayer), Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)

      expect(finalized).toBe(true)
    }),
  )
})

const collectBytes = Effect.fn("collectBytes")(function* (
  source: ReviewDiffSource,
  generation: ReviewDiffGeneration,
) {
  const chunks: Uint8Array[] = []
  const events = yield* source
    .unifiedBytes(
      ReviewDiffAcquisition.make({ generation, expectedRevision: source.offer.expectedRevision }),
    )
    .pipe(Stream.runCollect)
  for (const event of events) {
    if (event instanceof ReviewDiffByteCompletion) continue
    chunks.push(event.bytes)
  }
  return concat(chunks)
})

const successfulExit = (request: ProcessRequest): ProcessExit =>
  ProcessExit.make({
    result: ProcessResult.make({
      command: request.command,
      args: request.args,
      cwd: request.cwd,
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      outputTruncated: false,
    }),
  })

const lastCommitTarget = (root: string, base: string, head: string): LocalReviewTarget =>
  LocalReviewTarget.make({
    kind: "local",
    rootPath: RepositoryCheckoutPath.make(root),
    comparison: LastCommitComparison.make({
      baseSha: ReviewRevision.make(base),
      headSha: ReviewRevision.make(head),
    }),
  })

const branchTarget = (root: string, base: string): LocalReviewTarget =>
  LocalReviewTarget.make({
    kind: "local",
    rootPath: RepositoryCheckoutPath.make(root),
    comparison: BranchComparison.make({
      branchName: RepositoryComparisonRef.make("main"),
      baseRef: RepositoryComparisonRef.make("refs/heads/main"),
      baseSha: ReviewRevision.make(base),
    }),
  })

const acceptedDiffBytes = (root: string, path: string): Uint8Array => {
  try {
    return gitBytes(
      root,
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--no-index",
      "--",
      "/dev/null",
      path,
    )
  } catch (cause) {
    if (
      cause !== null &&
      typeof cause === "object" &&
      "status" in cause &&
      cause.status === 1 &&
      "stdout" in cause &&
      cause.stdout instanceof Buffer
    ) {
      return cause.stdout
    }
    throw cause
  }
}

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function gitBytes(cwd: string, ...args: readonly string[]): Uint8Array {
  return execFileSync("git", args, {
    cwd,
    env: sanitizedGitTestEnvironment(process.env),
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function git(cwd: string, ...args: readonly string[]): string {
  return new TextDecoder().decode(gitBytes(cwd, ...args)).trim()
}

function commitAll(cwd: string, message: string): void {
  git(cwd, "add", "-A")
  git(
    cwd,
    "-c",
    "user.name=DiffDash Test",
    "-c",
    "user.email=test@diffdash.dev",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-m",
    message,
  )
}
