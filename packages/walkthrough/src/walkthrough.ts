import { Context, Effect, Layer, Predicate, Schema } from "effect"

import {
  AgentExecutionPolicy,
  AgentModelId,
  type AgentModelQuality,
  AgentProviderId,
  type AgentProviderManifest,
  AgentProviderOperationError,
  type AgentProviderResolutionError,
  InvalidAgentProviderResponseError,
  WalkthroughRequest,
} from "@diffdash/agent-provider"
import {
  AgentProviderRegistry,
  type AgentProviderRoute,
  NoAgentProviderAvailableError,
} from "@diffdash/agent-provider/registry"
import type { LocalReviewDetail } from "@diffdash/domain/local-review"
import type { HostedReviewDetail } from "@diffdash/domain/git-provider"
import {
  Walkthrough,
  WalkthroughGenerationDetails,
  type WalkthroughHunkDigest,
  type WalkthroughPromptStats,
  makeWalkthroughHunkAlias,
  validateWalkthrough,
  type WalkthroughValidationError,
} from "@diffdash/domain/walkthrough"
const WALKTHROUGH_GENERATION_TIMEOUT_MS = 10 * 60 * 1_000

/** Settings needed to route one walkthrough without knowing concrete providers. */
export interface WalkthroughRouteSelection {
  readonly route: AgentProviderRoute
  readonly models: Readonly<Record<string, string>>
  readonly autoQuality: AgentModelQuality
}

/** Supplies the current user-selected walkthrough route and model preferences. */
export class WalkthroughRouting extends Context.Tag("@diffdash/WalkthroughRouting")<
  WalkthroughRouting,
  { readonly get: Effect.Effect<WalkthroughRouteSelection> }
>() {}

/** The selected provider has no compatible model in its manifest catalog. */
export class WalkthroughModelUnavailableError extends Schema.TaggedError<WalkthroughModelUnavailableError>()(
  "WalkthroughModelUnavailableError",
  { providerId: AgentProviderId, modelId: Schema.NullOr(Schema.String) },
) {}

/** Explicit non-mutating policy required for every walkthrough execution. */
export const WALKTHROUGH_EXECUTION_POLICY = AgentExecutionPolicy.make({
  network: "allow",
  sensitiveFiles: "deny",
  repository: "local-working-copy",
  shell: "read-only",
  fileMutation: "deny",
  gitMutation: "deny",
  providerPublishing: "deny",
  providerPublishingTools: [],
  allowedMcpTools: [],
})

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
  | { readonly kind: "hosted"; readonly hostedReview: HostedReviewDetail }
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

/** Domain service for generating validated walkthrough artifacts through registered providers. */
export class WalkthroughService extends Context.Tag("@diffdash/WalkthroughService")<
  WalkthroughService,
  {
    readonly generate: (
      input: WalkthroughGenerationInput,
    ) => Effect.Effect<
      Walkthrough,
      | WalkthroughGenerationError
      | WalkthroughValidationError
      | WalkthroughModelUnavailableError
      | AgentProviderResolutionError
      | NoAgentProviderAvailableError
      | AgentProviderOperationError
      | InvalidAgentProviderResponseError
    >
  }
>() {
  static readonly layer = (options: { readonly remoteWorkingDirectory: string }) =>
    Layer.effect(
      WalkthroughService,
      Effect.gen(function* () {
        const registry = yield* AgentProviderRegistry
        const routing = yield* WalkthroughRouting

        const runAttempt = (input: WalkthroughGenerationInput) => {
          const promptContext = buildWalkthroughPromptContext(input)
          return routing.get.pipe(
            Effect.flatMap((selection) =>
              executeWalkthroughRoute(registry, selection, {
                prompt: promptContext.prompt,
                workingDirectory: walkthroughWorkingDirectory(
                  input.review,
                  options.remoteWorkingDirectory,
                ),
                reasoningEffort: "low",
                timeoutMs: WALKTHROUGH_GENERATION_TIMEOUT_MS,
                policy: WALKTHROUGH_EXECUTION_POLICY,
              }),
            ),
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

const walkthroughWorkingDirectory = (
  review: WalkthroughReviewContext,
  remoteWorkingDirectory: string,
): string => (review.kind === "localDiff" ? review.localReview.rootPath : remoteWorkingDirectory)

type Registry = Context.Tag.Service<AgentProviderRegistry>
type WalkthroughRouteError =
  | WalkthroughModelUnavailableError
  | AgentProviderResolutionError
  | NoAgentProviderAvailableError
  | AgentProviderOperationError
  | InvalidAgentProviderResponseError

const executeWalkthroughRoute = (
  registry: Registry,
  selection: WalkthroughRouteSelection,
  request: Omit<WalkthroughRequest, "model">,
): Effect.Effect<string, WalkthroughRouteError> => {
  const providerIds = registry.walkthroughRoute(selection.route)

  const executeProvider = (providerId: AgentProviderId) =>
    Effect.gen(function* () {
      const registration = yield* registry.get(providerId)
      const capability = yield* registry.resolveWalkthrough({ mode: "provider", providerId })
      const models = walkthroughModels(registration.manifest, selection, providerId)
      if (models.length === 0) {
        return yield* WalkthroughModelUnavailableError.make({
          providerId,
          modelId:
            selection.route.mode === "provider" ? (selection.models[providerId] ?? null) : null,
        })
      }

      const executeModel = (
        remaining: readonly AgentModelId[],
      ): Effect.Effect<
        string,
        | WalkthroughModelUnavailableError
        | AgentProviderOperationError
        | InvalidAgentProviderResponseError
      > => {
        const [model, ...rest] = remaining
        if (model === undefined) {
          return WalkthroughModelUnavailableError.make({ providerId, modelId: null })
        }
        return capability.execute(WalkthroughRequest.make({ ...request, model })).pipe(
          Effect.map((result) => result.text),
          Effect.catchAll((error) =>
            selection.route.mode === "auto" && rest.length > 0
              ? executeModel(rest)
              : Effect.fail(error),
          ),
        )
      }

      return yield* executeModel(models)
    })

  if (selection.route.mode === "provider") return executeProvider(selection.route.providerId)

  const executeAutomatic = (
    remaining: readonly AgentProviderId[],
    lastExecutionError:
      | AgentProviderOperationError
      | InvalidAgentProviderResponseError
      | WalkthroughModelUnavailableError
      | undefined,
  ): Effect.Effect<string, WalkthroughRouteError> => {
    const [providerId, ...rest] = remaining
    if (providerId === undefined) {
      return lastExecutionError ?? NoAgentProviderAvailableError.make({ capability: "walkthrough" })
    }
    return executeProvider(providerId).pipe(
      Effect.catchAll((error) =>
        executeAutomatic(
          rest,
          error instanceof AgentProviderOperationError ||
            error instanceof InvalidAgentProviderResponseError ||
            error instanceof WalkthroughModelUnavailableError
            ? error
            : lastExecutionError,
        ),
      ),
    )
  }

  return executeAutomatic(providerIds, undefined)
}

const walkthroughModels = (
  manifest: AgentProviderManifest,
  selection: WalkthroughRouteSelection,
  providerId: AgentProviderId,
): readonly AgentModelId[] => {
  const compatible = manifest.models.filter((model) => model.capabilities.includes("walkthrough"))
  if (selection.route.mode === "auto") {
    return compatible
      .filter((model) => model.quality === selection.autoQuality)
      .map((model) => model.id)
  }

  const selected = selection.models[providerId]
  const modelId =
    selected === undefined ? manifest.defaults.walkthroughModel : AgentModelId.make(selected)
  return modelId !== null && compatible.some((model) => model.id === modelId) ? [modelId] : []
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
  changedFileTree,
  generation,
  promptStats,
}: WalkthroughGenerationInput) => {
  const promptHunks = hunkDigest.map((hunk, index) => ({
    h: makeWalkthroughHunkAlias(index),
    p: hunk.path,
    r: hunk.header,
    a: hunk.additions,
    d: hunk.deletions,
    s: hunk.synthetic ? 1 : 0,
  }))
  const aliasToHunkId = new Map(
    hunkDigest.map((hunk, index) => [makeWalkthroughHunkAlias(index), hunk.id] as const),
  )
  const payload = Schema.decodeUnknownSync(WalkthroughPromptPayload)({
    review: walkthroughReviewPayload(review, hunkDigest),
    hunks: promptHunks,
    generation,
    prompt: promptStatsPayload(promptStats),
  })
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
- Hosted review context is diff-only unless data.review.context says otherwise; do not assume repository filesystem access.
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

  const hostedReview = review.hostedReview
  const summary = hostedReview.summary
  return {
    type: "hosted-review",
    context: "diff-only",
    provider: summary.locator.repository.providerId,
    namespace: summary.locator.repository.namespace,
    repository: summary.locator.repository.name,
    n: summary.locator.number,
    title: summary.title,
    body: summary.body,
    author: summary.author.username,
    base: summary.base.name,
    baseSha: summary.base.revision,
    head: summary.head.name,
    headSha: summary.head.revision,
    commits: hostedReview.commits.map((commit) => ({
      oid: commit.revision,
      msg: commit.title,
      date: commit.authoredAt,
    })),
    files: compactReviewFiles(hostedReview.files, hunkDigest),
  }
}

const WalkthroughPromptHunk = Schema.Struct({
  h: Schema.String,
  p: Schema.String,
  r: Schema.String,
  a: Schema.Number,
  d: Schema.Number,
  s: Schema.Number,
})

const WalkthroughPromptStatsPayload = Schema.Struct({
  hiddenFiles: Schema.Number,
  omittedFiles: Schema.Number,
  omittedHunks: Schema.Number,
  selectedFiles: Schema.Number,
  selectedHunks: Schema.Number,
  totalFiles: Schema.Number,
  totalHunks: Schema.Number,
  truncatedByCharBudget: Schema.Boolean,
  truncatedHunks: Schema.Number,
  usedHiddenFallback: Schema.Boolean,
})

const WalkthroughPromptPayload = Schema.Struct({
  review: Schema.Unknown,
  hunks: Schema.Array(WalkthroughPromptHunk),
  generation: WalkthroughGenerationDetails,
  prompt: Schema.NullOr(WalkthroughPromptStatsPayload),
})

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
  if (!Predicate.isReadonlyRecord(input)) return input

  const chapters = Array.isArray(input.chapters)
    ? input.chapters.map((chapter) => {
        if (!Predicate.isReadonlyRecord(chapter)) return chapter
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
  if (!Predicate.isReadonlyRecord(input) || !Array.isArray(input.hunkIds)) return input
  return {
    ...input,
    hunkIds: input.hunkIds.map((hunkId) =>
      typeof hunkId === "string" ? (aliasToHunkId.get(hunkId) ?? hunkId) : hunkId,
    ),
  }
}
