import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Stream } from "effect"

import { makeHostedRepositoryLocator } from "@diffdash/domain/git-provider"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import {
  GitCommitSha,
  makeRepositoryComparisonReviewKey,
  RepositoryComparisonRef,
  RepositoryComparisonTarget,
} from "@diffdash/domain/repository-comparison"
import type { ReviewDiffSource } from "@diffdash/git-provider"
import { reviewDiffSourceConformance } from "@diffdash/git-provider/testing"
import { ProcessService } from "@diffdash/process"
import { makeRepositoryComparisonReviewDiffSource } from "./repository-comparison-review-diff-source"
import { sanitizedGitTestEnvironment } from "./test-support/git-environment"

const fixtureRoot = mkdtempSync(join(tmpdir(), "diffdash-comparison-source-"))
git("init", "-b", "main")
writeFileSync(join(fixtureRoot, "file.txt"), "old\n")
commitAll("base")
const baseSha = git("rev-parse", "HEAD")
writeFileSync(join(fixtureRoot, "file.txt"), "new\n")
commitAll("head")
const headSha = git("rev-parse", "HEAD")
const target = RepositoryComparisonTarget.make({
  kind: "repositoryComparison",
  repository: makeHostedRepositoryLocator("fixture", "team", "repository"),
  baseRef: RepositoryComparisonRef.make(baseSha),
  headRef: RepositoryComparisonRef.make("main"),
  baseSha: GitCommitSha.make(baseSha),
  headSha: GitCommitSha.make(headSha),
  mergeBaseSha: GitCommitSha.make(baseSha),
})
const input = {
  reviewKey: makeRepositoryComparisonReviewKey(target),
  target,
  repositoryPath: RepositoryCheckoutPath.make(fixtureRoot),
}
const expectedBytes = new Uint8Array(
  execFileSync(
    "git",
    ["-C", fixtureRoot, "diff", "--no-ext-diff", "--no-color", baseSha, headSha, "--"],
    { env: sanitizedGitTestEnvironment(process.env), encoding: "buffer" },
  ),
)
const sources: ReviewDiffSource[] = []

beforeAll(async () => {
  sources.push(
    ...(await Promise.all(
      Array.from({ length: 6 }, () =>
        Effect.runPromise(
          makeRepositoryComparisonReviewDiffSource(input).pipe(
            Effect.provide(ProcessService.layer),
          ),
        ),
      ),
    )),
  )
})

afterAll(() => rmSync(fixtureRoot, { force: true, recursive: true }))

const takeSource = (): ReviewDiffSource => {
  const source = sources.shift()
  if (source === undefined) throw new Error("Repository comparison conformance exhausted fixtures")
  return source
}

reviewDiffSourceConformance("repository comparison exact Git", {
  create: takeSource,
  createCancellable: () => {
    let closed = false
    const source = takeSource()
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
  expectedBytes,
  expectedFiles: [],
})

describe("repository comparison review diff source", () => {
  it.effect("offers the immutable repository-comparison identity and exact Git objects", () =>
    Effect.gen(function* () {
      const source = yield* makeRepositoryComparisonReviewDiffSource(input)

      expect(source.offer.target).toEqual({
        _tag: "repositoryComparison",
        reviewKey: input.reviewKey,
        target,
      })
      expect(source.offer.facts).toMatchObject({
        origin: "local",
        revisionKind: "immutableGit",
        reproducible: true,
        complete: true,
        declaredBytes: expectedBytes.byteLength,
      })
      expect(source.offer.methods.map((method) => method["_tag"])).toEqual([
        "unifiedBytes",
        "materializedGit",
      ])
    }).pipe(Effect.provide(ProcessService.layer)),
  )
})

function git(...args: readonly string[]): string {
  return execFileSync("git", ["-C", fixtureRoot, ...args], {
    env: sanitizedGitTestEnvironment(process.env),
    encoding: "utf8",
  }).trim()
}

function commitAll(message: string): void {
  git("add", ".")
  git("-c", "user.name=DiffDash", "-c", "user.email=diffdash@example.com", "commit", "-m", message)
}
