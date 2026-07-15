import { Context, Effect, Layer, Schema } from "effect"

import type { LocalReviewDetail } from "@diffdash/domain/local-review"
import type { PullRequestDetail } from "@diffdash/domain/pull-request"
import {
  Walkthrough,
  type WalkthroughGenerationDetails,
  type WalkthroughHunkDigest,
  type WalkthroughPromptStats,
  validateWalkthrough,
  type WalkthroughValidationError,
} from "@diffdash/domain/walkthrough"
import { AIAgent, type AIAgentGenerateOptions } from "./ai-agent"
import type { CliError } from "./cli"

const WALKTHROUGH_GENERATION_TIMEOUT_MS = 10 * 60 * 1_000

/** Input required to generate a reviewer-oriented walkthrough for a review diff. */
export interface WalkthroughGenerationInput {
  readonly review: WalkthroughReviewContext
  readonly diff: string
  readonly hunkDigest: readonly WalkthroughHunkDigest[]
  readonly changedFileTree: string
  readonly generation: WalkthroughGenerationDetails
  readonly promptStats?: WalkthroughPromptStats
}

/** Review metadata variants supported by walkthrough generation. */
export type WalkthroughReviewContext =
  | { readonly kind: "pullRequest"; readonly pullRequest: PullRequestDetail }
  | { readonly kind: "localDiff"; readonly localReview: LocalReviewDetail }

/** A typed failure for walkthrough generation and model-output parsing. */
export class WalkthroughGenerationError extends Schema.TaggedError<WalkthroughGenerationError>()(
  "WalkthroughGenerationError",
  {
    operation: Schema.String,
    output: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** Domain service for generating validated walkthrough artifacts through an AI agent. */
export class WalkthroughService extends Context.Tag("@diffdash/WalkthroughService")<
  WalkthroughService,
  {
    readonly generate: (
      input: WalkthroughGenerationInput,
    ) => Effect.Effect<
      Walkthrough,
      WalkthroughGenerationError | WalkthroughValidationError | CliError
    >
  }
>() {
  static readonly layer = Layer.effect(
    WalkthroughService,
    Effect.gen(function* () {
      const aiAgent = yield* AIAgent

      const runAttempt = (input: WalkthroughGenerationInput) => {
        const promptContext = buildWalkthroughPromptContext(input)
        const options = walkthroughGenerationOptions(input.review)

        return aiAgent.generateText(promptContext.prompt, options).pipe(
          Effect.flatMap((output) => parseModelJson(output)),
          Effect.map((json) => expandWalkthroughHunkAliases(json, promptContext.aliasToHunkId)),
          Effect.flatMap((json) => validateWalkthrough(json, input.hunkDigest)),
          Effect.map((walkthrough) =>
            Walkthrough.make({ ...walkthrough, generation: input.generation }),
          ),
        )
      }

      return WalkthroughService.of({
        generate: Effect.fn("WalkthroughService.generate")(function (input) {
          return runAttempt(input).pipe(
            Effect.catchTags({
              WalkthroughGenerationError: () => runAttempt(input),
              WalkthroughValidationError: () => runAttempt(input),
            }),
          )
        }),
      })
    }),
  )
}

const walkthroughGenerationOptions = (
  review: WalkthroughReviewContext,
): AIAgentGenerateOptions => ({
  ...(review.kind === "localDiff" ? { cwd: review.localReview.rootPath } : {}),
  reasoningEffort: "low",
  timeoutMs: WALKTHROUGH_GENERATION_TIMEOUT_MS,
})

const parseModelJson = (output: string): Effect.Effect<unknown, WalkthroughGenerationError> =>
  Effect.try({
    try: () => JSON.parse(extractJsonObject(output)) as unknown,
    catch: (cause) =>
      WalkthroughGenerationError.make({ operation: "parseModelJson", output, cause }),
  })

const extractJsonObject = (output: string) => {
  const trimmed = output.trim()
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed

  const fencedMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  if (fencedMatch?.[1] !== undefined) return fencedMatch[1].trim()

  const firstBrace = trimmed.indexOf("{")
  const lastBrace = trimmed.lastIndexOf("}")
  if (firstBrace >= 0 && lastBrace > firstBrace) return trimmed.slice(firstBrace, lastBrace + 1)

  return trimmed
}

const buildWalkthroughPromptContext = ({
  review,
  diff,
  hunkDigest,
  changedFileTree,
  generation,
  promptStats,
}: WalkthroughGenerationInput) => {
  const promptHunks = hunkDigest.map((hunk, index) => ({
    h: hunkAlias(index),
    p: hunk.path,
    r: hunk.header,
    a: hunk.additions,
    d: hunk.deletions,
    s: hunk.synthetic ? 1 : 0,
  }))
  const aliasToHunkId = new Map(
    hunkDigest.map((hunk, index) => [hunkAlias(index), hunk.id] as const),
  )
  const payload = {
    review: walkthroughReviewPayload(review, hunkDigest),
    hunks: promptHunks,
    generation,
    prompt: promptStatsPayload(promptStats),
  }
  const sampledTreeGuidance =
    generation.mode === "sampled-tree"
      ? `
- This is a sampled-tree walkthrough for an unusually large review.
- Use the changed file tree to infer each folder's use case, then use representative excerpts to ground the review order.
- Combine folders that implement the same use case. Do not imply that representative files exhaustively cover the review.`
      : ""
  const changedFileTreeSection =
    generation.mode === "sampled-tree"
      ? `

Changed file tree. Folder totals cover the large review; excerpts below are representative samples:
${changedFileTree}`
      : ""

  return {
    aliasToHunkId,
    prompt: `You generate a DiffDash code review walkthrough for a reviewer.

Return JSON only. Do not include markdown, prose outside JSON, comments, or trailing commas.

Goal:
Guide the reviewer through the changed hunks in the smartest review order, with the most critical changes first.

Required JSON shape:
{"title":"short walkthrough title","summary":"short review focus summary","chapters":[{"id":"c1","title":"chapter title","summary":"brief chapter summary","stops":[{"id":"s1","title":"stop title","summary":"brief explanation for the reviewer","risk":"review","hunkIds":["h1"]}]}]}

Rules:
- Use hunk aliases from data.hunks[].h only. Do not use paths or full hunk IDs in hunkIds.
- Pull request context is diff-only unless data.review.context says otherwise; do not assume repository filesystem access.
- Put only the main review path in chapters/stops. Omit lower-priority hunks; DiffDash adds support locally.
- Prefer 3-6 stops. Never return more than 8 stops unless unrelated critical changes require it.
- Every referenced alias should appear at most once.
- If the same file has unrelated hunks, split those aliases across different stops when that improves review order.
- If multiple hunks implement the same idea, keep them in one stop even across files.
- Preserve your chosen review order in the chapters and stops arrays.
- Use risk "critical" for entry points, data correctness, security, migrations, feature flags, and behavior that can break production.
- Use risk "review" for normal implementation changes that deserve careful review.
- Use risk "support" for tests, docs, fixtures, generated files, and low-risk supporting changes.
- Do not return support, path, additions, deletions, status, or patch data. DiffDash computes those locally.
- Do not suggest PR comments.
- Do not judge likely bugs; only orient the reviewer.
${sampledTreeGuidance}

Data compact JSON. h=alias, p=path, r=hunk header, a=additions, d=deletions, s=synthetic file unit:
${JSON.stringify(payload)}
${changedFileTreeSection}

Bounded diff excerpts. These may omit noisy files and truncate oversized hunks; data.hunks is the source of truth for aliases:
${diff}
`,
  }
}

const promptStatsPayload = (stats: WalkthroughPromptStats | undefined) =>
  stats === undefined
    ? null
    : {
        hiddenFiles: stats.hiddenFiles,
        omittedFiles: stats.omittedFiles,
        omittedHunks: stats.omittedHunks,
        selectedFiles: stats.selectedFiles,
        selectedHunks: stats.selectedHunks,
        totalFiles: stats.totalFiles,
        totalHunks: stats.totalHunks,
        truncatedByCharBudget: stats.truncatedByCharBudget,
        truncatedHunks: stats.truncatedHunks,
        usedHiddenFallback: stats.usedHiddenFallback,
      }

const walkthroughReviewPayload = (
  review: WalkthroughReviewContext,
  hunkDigest: readonly WalkthroughHunkDigest[],
) => {
  if (review.kind === "localDiff") {
    const localReview = review.localReview
    return {
      type: "local-diff",
      title: localReview.title,
      repo: localReview.repoName,
      root: localReview.rootPath,
      branch: localReview.branchName,
      base: localReview.baseSha,
      head: localReview.headSha,
      files: compactReviewFiles(localReview.files, hunkDigest),
    }
  }

  const pullRequest = review.pullRequest
  return {
    type: "pull-request",
    context: "diff-only",
    n: pullRequest.number,
    title: pullRequest.title,
    body: pullRequest.body,
    author: pullRequest.author.login,
    base: pullRequest.baseRefName,
    baseSha: pullRequest.baseRefOid,
    head: pullRequest.headRefName,
    headSha: pullRequest.headRefOid,
    commits: pullRequest.commits.map((commit) => ({
      oid: commit.oid,
      msg: commit.messageHeadline,
      date: commit.authoredDate,
    })),
    files: compactReviewFiles(pullRequest.files, hunkDigest),
  }
}

const compactReviewFiles = (
  files: readonly {
    readonly path: string
    readonly additions: number
    readonly deletions: number
    readonly changeType: string
  }[],
  hunkDigest: readonly WalkthroughHunkDigest[],
) => {
  const paths: string[] = []
  const totalsByPath = new Map<string, { additions: number; deletions: number }>()
  const fileByPath = new Map(files.map((file) => [file.path, file]))

  for (const hunk of hunkDigest) {
    if (!totalsByPath.has(hunk.path)) {
      paths.push(hunk.path)
      totalsByPath.set(hunk.path, { additions: 0, deletions: 0 })
    }
    const total = totalsByPath.get(hunk.path)
    if (total !== undefined) {
      totalsByPath.set(hunk.path, {
        additions: total.additions + hunk.additions,
        deletions: total.deletions + hunk.deletions,
      })
    }
  }

  return paths.map((path) => {
    const file = fileByPath.get(path)
    const totals = totalsByPath.get(path)
    return {
      a: totals?.additions ?? file?.additions ?? 0,
      d: totals?.deletions ?? file?.deletions ?? 0,
      p: path,
      t: file?.changeType ?? "modified",
    }
  })
}

const expandWalkthroughHunkAliases = (
  input: unknown,
  aliasToHunkId: ReadonlyMap<string, string>,
): unknown => {
  if (!isRecord(input)) return input

  const chapters = Array.isArray(input.chapters)
    ? input.chapters.map((chapter) => {
        if (!isRecord(chapter)) return chapter
        return {
          ...chapter,
          stops: Array.isArray(chapter.stops)
            ? chapter.stops.map((stop) => expandHunkIds(stop, aliasToHunkId))
            : chapter.stops,
        }
      })
    : input.chapters
  const support = Array.isArray(input.support)
    ? input.support.map((item) => expandHunkIds(item, aliasToHunkId))
    : input.support

  return { ...input, chapters, support }
}

const expandHunkIds = (input: unknown, aliasToHunkId: ReadonlyMap<string, string>): unknown => {
  if (!isRecord(input) || !Array.isArray(input.hunkIds)) return input
  return {
    ...input,
    hunkIds: input.hunkIds.map((hunkId) =>
      typeof hunkId === "string" ? (aliasToHunkId.get(hunkId) ?? hunkId) : hunkId,
    ),
  }
}

const hunkAlias = (index: number) => `h${index + 1}`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
