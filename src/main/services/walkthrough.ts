import { Context, Effect, Layer, Schema } from "effect"

import type { LocalReviewDetail, PullRequestDetail } from "../../shared/domain"
import {
  Walkthrough,
  type WalkthroughHunkDigest,
  validateWalkthrough,
  type WalkthroughValidationError,
} from "../../shared/walkthrough"
import { AIAgent } from "./ai-agent"
import type { CliError } from "./cli"

const WALKTHROUGH_GENERATION_TIMEOUT_MS = 90_000

/** Input required to generate a reviewer-oriented walkthrough for a review diff. */
export interface WalkthroughGenerationInput {
  readonly review: WalkthroughReviewContext
  readonly diff: string
  readonly hunkDigest: readonly WalkthroughHunkDigest[]
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

        return aiAgent
          .generateText(promptContext.prompt, {
            reasoningEffort: "low",
            timeoutMs: WALKTHROUGH_GENERATION_TIMEOUT_MS,
          })
          .pipe(
            Effect.flatMap((output) => parseModelJson(output)),
            Effect.map((json) => expandWalkthroughHunkAliases(json, promptContext.aliasToHunkId)),
            Effect.flatMap((json) => validateWalkthrough(json, input.hunkDigest)),
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
    review: walkthroughReviewPayload(review),
    hunks: promptHunks,
  }

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

Data compact JSON. h=alias, p=path, r=hunk header, a=additions, d=deletions, s=synthetic file unit:
${JSON.stringify(payload)}

Unified diff:
${diff}
`,
  }
}

const walkthroughReviewPayload = (review: WalkthroughReviewContext) => {
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
      files: localReview.files.map((file) => ({
        p: file.path,
        a: file.additions,
        d: file.deletions,
        t: file.changeType,
      })),
    }
  }

  const pullRequest = review.pullRequest
  return {
    type: "pull-request",
    n: pullRequest.number,
    title: pullRequest.title,
    body: pullRequest.body,
    author: pullRequest.author.login,
    base: pullRequest.baseRefName,
    head: pullRequest.headRefName,
    commits: pullRequest.commits.map((commit) => ({
      oid: commit.oid,
      msg: commit.messageHeadline,
      date: commit.authoredDate,
    })),
    files: pullRequest.files.map((file) => ({
      p: file.path,
      a: file.additions,
      d: file.deletions,
      t: file.changeType,
    })),
  }
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
