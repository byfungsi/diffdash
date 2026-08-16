import {
  Array as EffectArray,
  Context,
  Effect,
  Layer,
  Match,
  Option,
  Schema,
  SchemaTransformation,
} from "effect"

import {
  AgentExecutionPolicy,
  AgentModelId,
  AgentProviderId,
  type AgentProviderManifest,
  type AgentProviderRegistration,
  AgentProviderOperationError,
  type AgentProviderResolutionError,
  InvalidAgentProviderResponseError,
  WalkthroughRequest,
} from "@diffdash/agent-provider"
import {
  AgentProviderRegistry,
  type AgentProviderRoute,
  NoAgentProviderAvailableError,
  type ResolvedWalkthroughCandidate,
} from "@diffdash/agent-provider/registry"
import type { AIAgentSelection } from "@diffdash/domain/ai-settings"
import {
  DEFAULT_WALKTHROUGH_PROMPT_BUDGET,
  Walkthrough,
  WalkthroughChapterId,
  WalkthroughGenerationDetails,
  WalkthroughHunkDigest,
  type WalkthroughHunkId,
  WalkthroughPromptStats,
  WalkthroughRisk,
  WalkthroughStopId,
  WalkthroughSupportItemId,
  makeWalkthroughHunkAlias,
  validateWalkthrough,
  WalkthroughValidationError,
} from "@diffdash/domain/walkthrough"
import { ReviewPromptFile, ReviewPromptIdentity } from "./review-prompt-context"
export { ReviewPromptFile, ReviewPromptIdentity } from "./review-prompt-context"
const WALKTHROUGH_GENERATION_TIMEOUT_MS = 10 * 60 * 1_000

/** Hard limits inherited from bounded walkthrough preparation and persisted tree summaries. */
export const WALKTHROUGH_PROMPT_CONTEXT_LIMITS = {
  maxDiffChars: DEFAULT_WALKTHROUGH_PROMPT_BUDGET.maxDiffChars,
  maxFiles: DEFAULT_WALKTHROUGH_PROMPT_BUDGET.maxFiles,
  maxHunks: DEFAULT_WALKTHROUGH_PROMPT_BUDGET.maxHunks,
  maxChangedFileTreeChars: 60_000,
} as const

/** Settings needed to route one walkthrough without knowing concrete providers. */
export interface WalkthroughRouteSelection {
  readonly selection: AIAgentSelection
}

/** Ordered provider/model identity captured before walkthrough acceptance. */
export interface WalkthroughCandidatePlanEntry {
  readonly providerId: AgentProviderId
  readonly modelIds: readonly AgentModelId[]
}

/** Immutable route and candidate plan used for one accepted walkthrough operation. */
export interface WalkthroughPreparedRoute extends WalkthroughRouteSelection {
  readonly candidates: readonly WalkthroughCandidatePlanEntry[]
}

/** Supplies the current user-selected walkthrough route and model preferences. */
export class WalkthroughRouting extends Context.Service<
  WalkthroughRouting,
  { readonly get: Effect.Effect<WalkthroughRouteSelection> }
>()("@diffdash/WalkthroughRouting") {}

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

/** Durable metadata and bounded, already-selected file inventory for walkthrough prompts. */
export const WalkthroughReviewContext = Schema.Struct({
  review: ReviewPromptIdentity,
  files: Schema.Array(ReviewPromptFile).pipe(
    Schema.check(Schema.isMaxLength(WALKTHROUGH_PROMPT_CONTEXT_LIMITS.maxFiles)),
  ),
})

/** Durable metadata and bounded, already-selected file inventory for walkthrough prompts. */
export type WalkthroughReviewContext = typeof WalkthroughReviewContext.Type

/** Input required to generate a reviewer-oriented walkthrough for a review diff. */
export const WalkthroughGenerationInput = Schema.Struct({
  review: WalkthroughReviewContext,
  diff: Schema.String.pipe(
    Schema.check(Schema.isMaxLength(WALKTHROUGH_PROMPT_CONTEXT_LIMITS.maxDiffChars)),
  ),
  hunkDigest: Schema.Array(WalkthroughHunkDigest).pipe(
    Schema.check(Schema.isMaxLength(WALKTHROUGH_PROMPT_CONTEXT_LIMITS.maxHunks)),
  ),
  changedFileTree: Schema.String.pipe(
    Schema.check(Schema.isMaxLength(WALKTHROUGH_PROMPT_CONTEXT_LIMITS.maxChangedFileTreeChars)),
  ),
  generation: WalkthroughGenerationDetails,
  promptStats: Schema.OptionFromOptional(WalkthroughPromptStats),
  workingDirectory: Schema.OptionFromOptional(Schema.String),
})

/** Input required to generate a reviewer-oriented walkthrough for a review diff. */
export type WalkthroughGenerationInput = typeof WalkthroughGenerationInput.Type

class WalkthroughProviderStop extends Schema.Class<WalkthroughProviderStop>(
  "WalkthroughProviderStop",
)({
  id: WalkthroughStopId,
  title: Schema.String,
  summary: Schema.String,
  risk: WalkthroughRisk,
  hunkIds: Schema.Array(Schema.String),
}) {}

class WalkthroughProviderChapter extends Schema.Class<WalkthroughProviderChapter>(
  "WalkthroughProviderChapter",
)({
  id: WalkthroughChapterId,
  title: Schema.String,
  summary: Schema.String,
  stops: Schema.Array(WalkthroughProviderStop),
}) {}

class WalkthroughProviderSupportItem extends Schema.Class<WalkthroughProviderSupportItem>(
  "WalkthroughProviderSupportItem",
)({
  id: WalkthroughSupportItemId,
  title: Schema.String,
  reason: Schema.String,
  hunkIds: Schema.Array(Schema.String),
}) {}

class WalkthroughProviderOutput extends Schema.Class<WalkthroughProviderOutput>(
  "WalkthroughProviderOutput",
)({
  title: Schema.String,
  summary: Schema.String,
  chapters: Schema.Array(WalkthroughProviderChapter),
  support: Schema.OptionFromOptional(Schema.Array(WalkthroughProviderSupportItem)),
}) {}

/** A typed failure for walkthrough generation and model-output parsing. */
export class WalkthroughGenerationError extends Schema.TaggedError<WalkthroughGenerationError>()(
  "WalkthroughGenerationError",
  {
    operation: Schema.String,
    output: Schema.String,
    cause: Schema.ErrorInstance(),
  },
) {}

/** Domain service for generating validated walkthrough artifacts through registered providers. */
export class WalkthroughService extends Context.Service<
  WalkthroughService,
  {
    readonly prepareRoute: Effect.Effect<WalkthroughPreparedRoute>
    readonly generatePrepared: (
      input: WalkthroughGenerationInput,
      route: WalkthroughPreparedRoute,
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
>()("@diffdash/WalkthroughService") {
  static readonly layer = (options: { readonly remoteWorkingDirectory: string }) =>
    Layer.effect(
      WalkthroughService,
      Effect.gen(function* () {
        const registry = yield* AgentProviderRegistry
        const routing = yield* WalkthroughRouting
        const prepareRoute = routing.get.pipe(
          Effect.flatMap((selection) =>
            registry.list.pipe(
              Effect.map((registrations) => ({
                ...selection,
                candidates: walkthroughCandidatePlan(registry, registrations, selection),
              })),
            ),
          ),
        )

        const generatePrepared = Effect.fn("WalkthroughService.generatePrepared")(function (
          input: WalkthroughGenerationInput,
          route: WalkthroughPreparedRoute,
        ) {
          const promptContext = buildWalkthroughPromptContext(input)
          return executeWalkthroughRoute(
            registry,
            route,
            {
              prompt: promptContext.prompt,
              workingDirectory: walkthroughWorkingDirectory(
                input.review,
                options.remoteWorkingDirectory,
                input.workingDirectory,
              ),
              reasoningEffort: "low",
              timeoutMs: WALKTHROUGH_GENERATION_TIMEOUT_MS,
              policy: WALKTHROUGH_EXECUTION_POLICY,
            },
            (output) =>
              parseModelJson(output).pipe(
                Effect.flatMap(decodeWalkthroughProviderOutput),
                Effect.map((walkthrough) =>
                  expandWalkthroughHunkAliases(walkthrough, promptContext.aliasToHunkId),
                ),
                Effect.flatMap((walkthrough) => validateWalkthrough(walkthrough, input.hunkDigest)),
                Effect.map((walkthrough) =>
                  Walkthrough.make({ ...walkthrough, generation: input.generation }),
                ),
              ),
          )
        })

        return WalkthroughService.of({
          prepareRoute,
          generatePrepared,
          generate: Effect.fn("WalkthroughService.generate")((input) =>
            prepareRoute.pipe(Effect.flatMap((route) => generatePrepared(input, route))),
          ),
        })
      }),
    )
}

const walkthroughWorkingDirectory = (
  review: WalkthroughReviewContext,
  remoteWorkingDirectory: string,
  explicitWorkingDirectory: Option.Option<string>,
): string =>
  Option.getOrElse(explicitWorkingDirectory, () =>
    Match.valueTags(review.review.descriptor, {
      hosted: () => remoteWorkingDirectory,
      local: (descriptor) => descriptor.target.rootPath,
      repositoryComparison: () => remoteWorkingDirectory,
    }),
  )

type Registry = Context.Service.Shape<typeof AgentProviderRegistry>

const walkthroughCandidatePlan = (
  registry: Registry,
  registrations: readonly AgentProviderRegistration[],
  selection: WalkthroughRouteSelection,
): readonly WalkthroughCandidatePlanEntry[] => {
  const byId = new Map(
    registrations.map((registration) => [registration.manifest.descriptor.id, registration]),
  )
  const providerIds = Match.valueTags(selection.selection, {
    Automatic: () => registry.autoCandidates.walkthrough,
    Pinned: ({ providerId }) => [AgentProviderId.make(providerId)],
  })
  return providerIds.map((providerId) => {
    const registration = byId.get(providerId)
    return {
      providerId,
      modelIds:
        registration === undefined
          ? Match.valueTags(selection.selection, {
              Automatic: () => [],
              Pinned: ({ modelId }) => (modelId === null ? [] : [AgentModelId.make(modelId)]),
            })
          : walkthroughModels(registration.manifest, selection, providerId),
    }
  })
}
type WalkthroughRouteError =
  | WalkthroughModelUnavailableError
  | AgentProviderResolutionError
  | NoAgentProviderAvailableError
  | AgentProviderOperationError
  | InvalidAgentProviderResponseError
  | WalkthroughGenerationError
  | WalkthroughValidationError

type WalkthroughSubstantiveError = Exclude<
  WalkthroughRouteError,
  AgentProviderResolutionError | NoAgentProviderAvailableError
>

const executeWalkthroughRoute = (
  registry: Registry,
  selection: WalkthroughRouteSelection,
  request: Omit<WalkthroughRequest, "model">,
  processOutput: (
    output: string,
  ) => Effect.Effect<Walkthrough, WalkthroughGenerationError | WalkthroughValidationError>,
): Effect.Effect<Walkthrough, WalkthroughRouteError> => {
  const route = providerRoute(selection.selection)

  const executeProvider = (provider: ResolvedWalkthroughCandidate) =>
    Effect.gen(function* () {
      const { registration, capability } = provider
      yield* provider.ready
      const providerId = registration.manifest.descriptor.id
      const models = walkthroughModels(registration.manifest, selection, providerId)
      if (models.length === 0) {
        return yield* WalkthroughModelUnavailableError.make({
          providerId,
          modelId: Match.valueTags(selection.selection, {
            Automatic: () => null,
            Pinned: ({ modelId }) => modelId,
          }),
        })
      }

      const executeCandidate = (
        model: AgentModelId,
        retryInvalidOutput: boolean,
      ): Effect.Effect<
        Walkthrough,
        | AgentProviderOperationError
        | InvalidAgentProviderResponseError
        | WalkthroughGenerationError
        | WalkthroughValidationError
      > =>
        capability.execute(WalkthroughRequest.make({ ...request, model })).pipe(
          Effect.flatMap((result) => processOutput(result.text)),
          Effect.catchTags({
            InvalidAgentProviderResponseError: (error) =>
              retryInvalidOutput ? executeCandidate(model, false) : Effect.fail(error),
            WalkthroughGenerationError: (error) =>
              retryInvalidOutput ? executeCandidate(model, false) : Effect.fail(error),
            WalkthroughValidationError: (error) =>
              retryInvalidOutput ? executeCandidate(model, false) : Effect.fail(error),
          }),
        )

      const executeModel = (
        remaining: readonly AgentModelId[],
      ): Effect.Effect<
        Walkthrough,
        | WalkthroughModelUnavailableError
        | AgentProviderOperationError
        | InvalidAgentProviderResponseError
        | WalkthroughGenerationError
        | WalkthroughValidationError
      > =>
        EffectArray.matchLeft(remaining, {
          onEmpty: () => WalkthroughModelUnavailableError.make({ providerId, modelId: null }),
          onNonEmpty: (model, rest) =>
            executeCandidate(model, true).pipe(
              Effect.catch((error) =>
                Match.valueTags(selection.selection, {
                  Automatic: () =>
                    EffectArray.match(rest, {
                      onEmpty: () => Effect.fail(error),
                      onNonEmpty: () => executeModel(rest),
                    }),
                  Pinned: () => Effect.fail(error),
                }),
              ),
            ),
        })

      return yield* executeModel(models)
    })

  const executeAutomatic = (
    remaining: readonly ResolvedWalkthroughCandidate[],
    lastExecutionError: Option.Option<WalkthroughSubstantiveError>,
  ): Effect.Effect<Walkthrough, WalkthroughRouteError> =>
    EffectArray.matchLeft(remaining, {
      onEmpty: () =>
        Option.match(lastExecutionError, {
          onNone: () =>
            Effect.fail(NoAgentProviderAvailableError.make({ capability: "walkthrough" })),
          onSome: Effect.fail,
        }),
      onNonEmpty: (provider, rest) =>
        executeProvider(provider).pipe(
          Effect.catch((error) =>
            executeAutomatic(
              rest,
              isWalkthroughSubstantiveError(error) ? Option.some(error) : lastExecutionError,
            ),
          ),
        ),
    })

  return registry.resolveWalkthroughCandidates(route).pipe(
    Effect.flatMap((candidates) =>
      Match.valueTags(selection.selection, {
        Pinned: () => {
          const candidate = candidates[0]
          return candidate === undefined
            ? NoAgentProviderAvailableError.make({ capability: "walkthrough" })
            : executeProvider(candidate)
        },
        Automatic: () => executeAutomatic(candidates, Option.none()),
      }),
    ),
  )
}

const isWalkthroughSubstantiveError = (
  error: WalkthroughRouteError,
): error is WalkthroughSubstantiveError =>
  Match.valueTags(error, {
    WalkthroughModelUnavailableError: () => true,
    AgentProviderOperationError: () => true,
    InvalidAgentProviderResponseError: () => true,
    WalkthroughGenerationError: () => true,
    WalkthroughValidationError: () => true,
    MissingAgentProviderError: () => false,
    UnsupportedAgentCapabilityError: () => false,
    AgentCapabilityUnavailableError: () => false,
    AgentPolicyEnforcementError: () => false,
    AgentProviderProbeError: () => false,
    InvalidAgentProviderRegistrationError: () => false,
    NoAgentProviderAvailableError: () => false,
  })

const walkthroughModels = (
  manifest: AgentProviderManifest,
  selection: WalkthroughRouteSelection,
  providerId: AgentProviderId,
): readonly AgentModelId[] => {
  const compatible = manifest.models.filter((model) => model.capabilities.includes("walkthrough"))
  return Match.valueTags(selection.selection, {
    Automatic: ({ quality }) =>
      compatible.filter((model) => model.quality === quality).map((model) => model.id),
    Pinned: ({ providerId: selectedProviderId, modelId }) =>
      String(selectedProviderId) !== String(providerId)
        ? []
        : modelId === null
          ? compatible
              .filter(({ id }) => id === manifest.defaults.walkthroughModel)
              .map(({ id }) => id)
          : compatible.some((model) => String(model.id) === String(modelId))
            ? [AgentModelId.make(modelId)]
            : [],
  })
}

const providerRoute = (selection: AIAgentSelection): AgentProviderRoute =>
  Match.valueTags(selection, {
    Automatic: () => ({ mode: "auto" as const }),
    Pinned: ({ providerId }) => ({
      mode: "provider" as const,
      providerId: AgentProviderId.make(providerId),
    }),
  })

const WalkthroughJson = Schema.fromJsonString(Schema.Json)

const parseModelJson = (output: string) =>
  Schema.decodeUnknownEffect(WalkthroughJson)(extractJsonObject(output)).pipe(
    Effect.mapError((cause) =>
      WalkthroughGenerationError.make({ operation: "parseModelJson", output, cause }),
    ),
  )

const decodeWalkthroughProviderOutput = (
  input: Schema.Json,
): Effect.Effect<WalkthroughProviderOutput, WalkthroughValidationError> =>
  Schema.decodeUnknownEffect(WalkthroughProviderOutput)(input).pipe(
    Effect.mapError(() =>
      WalkthroughValidationError.make({
        reason: "invalid_shape",
        details: ["Walkthrough output does not match the required JSON contract."],
      }),
    ),
  )

const extractJsonObject = (output: string) => {
  const trimmed = output.trim()
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed

  const fencedJson = Option.fromNullishOr(/```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)).pipe(
    Option.flatMap((match) => Option.fromUndefinedOr(match[1])),
    Option.map((json) => json.trim()),
  )
  return Option.match(fencedJson, {
    onSome: (json) => json,
    onNone: () => {
      const firstBrace = trimmed.indexOf("{")
      const lastBrace = trimmed.lastIndexOf("}")
      return firstBrace >= 0 && lastBrace > firstBrace
        ? trimmed.slice(firstBrace, lastBrace + 1)
        : trimmed
    },
  })
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
    alias: makeWalkthroughHunkAlias(index),
    path: hunk.path,
    header: hunk.header,
    additions: hunk.additions,
    deletions: hunk.deletions,
    synthetic: hunk.synthetic,
  }))
  const aliasToHunkId = new Map<string, WalkthroughHunkId>()
  hunkDigest.forEach((hunk, index) => {
    aliasToHunkId.set(makeWalkthroughHunkAlias(index), hunk.id)
  })
  const payload = Schema.encodeSync(WalkthroughPromptPayload)({
    review: walkthroughReviewPayload(review, hunkDigest),
    hunks: promptHunks,
    generation,
    prompt: promptStats,
  })
  let sampledTreeGuidance = ""
  let changedFileTreeSection = ""
  if (generation.mode === "sampled-tree") {
    sampledTreeGuidance = `
- This is a sampled-tree walkthrough for an unusually large review.
- Use the changed file tree to infer each folder's use case, then use representative excerpts to ground the review order.
- Combine folders that implement the same use case. Do not imply that representative files exhaustively cover the review.`
    changedFileTreeSection = `

Changed file tree. Folder totals cover the large review; excerpts below are representative samples:
${changedFileTree}`
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

const EncodedWalkthroughPromptHunk = Schema.Struct({
  h: Schema.String,
  p: Schema.String,
  r: Schema.String,
  a: Schema.Number,
  d: Schema.Number,
  s: Schema.Literals([0, 1]),
})

const WalkthroughPromptHunk = EncodedWalkthroughPromptHunk.pipe(
  Schema.decodeTo(
    Schema.Struct({
      alias: Schema.String,
      path: Schema.String,
      header: Schema.String,
      additions: Schema.Number,
      deletions: Schema.Number,
      synthetic: Schema.Boolean,
    }),
    SchemaTransformation.transform({
      decode: ({ h, p, r, a, d, s }) => ({
        alias: h,
        path: p,
        header: r,
        additions: a,
        deletions: d,
        synthetic: s === 1,
      }),
      encode: ({ alias, path, header, additions, deletions, synthetic }) => ({
        h: alias,
        p: path,
        r: header,
        a: additions,
        d: deletions,
        s: synthetic ? 1 : 0,
      }),
    }),
  ),
)

const EncodedWalkthroughPromptReviewFile = Schema.Struct({
  a: Schema.Number,
  d: Schema.Number,
  p: Schema.String,
  t: Schema.String,
})

const WalkthroughPromptReviewFile = EncodedWalkthroughPromptReviewFile.pipe(
  Schema.decodeTo(
    Schema.Struct({
      additions: Schema.Number,
      deletions: Schema.Number,
      path: Schema.String,
      changeType: Schema.String,
    }),
    SchemaTransformation.transform({
      decode: ({ a, d, p, t }) => ({
        additions: a,
        deletions: d,
        path: p,
        changeType: t,
      }),
      encode: ({ additions, deletions, path, changeType }) => ({
        a: additions,
        d: deletions,
        p: path,
        t: changeType,
      }),
    }),
  ),
)

const LocalWalkthroughPromptReview = Schema.Struct({
  type: Schema.Literal("local-diff"),
  title: Schema.String,
  repo: Schema.String,
  root: Schema.String,
  branch: Schema.NullOr(Schema.String),
  base: Schema.String,
  head: Schema.String,
  files: Schema.Array(WalkthroughPromptReviewFile),
})

const RepositoryComparisonWalkthroughPromptReview = Schema.Struct({
  type: Schema.Literal("repository-comparison"),
  context: Schema.Literal("diff-only"),
  provider: Schema.String,
  namespace: Schema.String,
  repository: Schema.String,
  title: Schema.String,
  base: Schema.String,
  baseSha: Schema.String,
  mergeBaseSha: Schema.String,
  head: Schema.String,
  headSha: Schema.String,
  files: Schema.Array(WalkthroughPromptReviewFile),
})

const HostedWalkthroughPromptReview = Schema.Struct({
  type: Schema.Literal("hosted-review"),
  context: Schema.Literal("diff-only"),
  provider: Schema.String,
  namespace: Schema.String,
  repository: Schema.String,
  n: Schema.Number,
  title: Schema.String,
  author: Schema.String,
  base: Schema.String,
  baseSha: Schema.NullOr(Schema.String),
  head: Schema.String,
  headSha: Schema.NullOr(Schema.String),
  files: Schema.Array(WalkthroughPromptReviewFile),
})

const WalkthroughPromptReview = Schema.Union([
  LocalWalkthroughPromptReview,
  RepositoryComparisonWalkthroughPromptReview,
  HostedWalkthroughPromptReview,
])

const WalkthroughPromptPayload = Schema.Struct({
  review: WalkthroughPromptReview,
  hunks: Schema.Array(WalkthroughPromptHunk),
  generation: WalkthroughGenerationDetails,
  prompt: Schema.OptionFromNullOr(WalkthroughPromptStats),
})

const walkthroughReviewPayload = (
  review: WalkthroughReviewContext,
  hunkDigest: readonly WalkthroughHunkDigest[],
): typeof WalkthroughPromptReview.Type => {
  const identity = review.review
  return Match.valueTags(identity.descriptor, {
    local: (descriptor) =>
      LocalWalkthroughPromptReview.make({
        type: "local-diff",
        title: descriptor.title,
        repo: descriptor.repoName,
        root: descriptor.target.rootPath,
        branch: descriptor.branchName,
        base: identity.baseRevision,
        head: identity.headRevision,
        files: walkthroughPromptReviewFiles(review.files, hunkDigest),
      }),
    repositoryComparison: (descriptor) => {
      const target = descriptor.target
      return RepositoryComparisonWalkthroughPromptReview.make({
        type: "repository-comparison",
        context: "diff-only",
        provider: target.repository.providerId,
        namespace: target.repository.namespace,
        repository: target.repository.name,
        title: descriptor.title,
        base: target.baseRef,
        baseSha: target.baseSha,
        mergeBaseSha: target.mergeBaseSha,
        head: target.headRef,
        headSha: target.headSha,
        files: walkthroughPromptReviewFiles(review.files, hunkDigest),
      })
    },
    hosted: (descriptor) => {
      const target = descriptor.review
      return HostedWalkthroughPromptReview.make({
        type: "hosted-review",
        context: "diff-only",
        provider: target.repository.providerId,
        namespace: target.repository.namespace,
        repository: target.repository.name,
        n: target.number,
        title: descriptor.title,
        author: descriptor.authorUsername,
        base: descriptor.baseRef,
        baseSha: identity.baseRevision,
        head: descriptor.headRef,
        headSha: identity.headRevision,
        files: walkthroughPromptReviewFiles(review.files, hunkDigest),
      })
    },
  })
}

const walkthroughPromptReviewFiles = (
  files: readonly ReviewPromptFile[],
  hunkDigest: readonly WalkthroughHunkDigest[],
) => {
  const totalsByPath = new Map<ReviewPromptFile["path"], { additions: number; deletions: number }>()
  const fileByPath = new Map(files.map((file) => [file.path, file]))

  for (const hunk of hunkDigest) {
    const total = Option.getOrElse(Option.fromUndefinedOr(totalsByPath.get(hunk.path)), () => ({
      additions: 0,
      deletions: 0,
    }))
    totalsByPath.set(hunk.path, {
      additions: total.additions + hunk.additions,
      deletions: total.deletions + hunk.deletions,
    })
  }

  return Array.from(totalsByPath, ([path, totals]) => {
    return {
      additions: totals.additions,
      deletions: totals.deletions,
      path,
      changeType: Option.getOrElse(
        Option.map(Option.fromUndefinedOr(fileByPath.get(path)), (file) => file.status),
        () => "modified",
      ),
    }
  })
}

const expandWalkthroughHunkAliases = (
  input: WalkthroughProviderOutput,
  aliasToHunkId: ReadonlyMap<string, WalkthroughHunkId>,
) => ({
  title: input.title,
  summary: input.summary,
  chapters: input.chapters.map((chapter) => ({
    id: chapter.id,
    title: chapter.title,
    summary: chapter.summary,
    stops: chapter.stops.map((stop) => ({
      id: stop.id,
      title: stop.title,
      summary: stop.summary,
      risk: stop.risk,
      hunkIds: expandHunkIds(stop.hunkIds, aliasToHunkId),
    })),
  })),
  support: Option.getOrElse(input.support, () => []).map((item) => ({
    id: item.id,
    title: item.title,
    reason: item.reason,
    hunkIds: expandHunkIds(item.hunkIds, aliasToHunkId),
  })),
})

const expandHunkIds = (
  hunkIds: readonly string[],
  aliasToHunkId: ReadonlyMap<string, WalkthroughHunkId>,
): readonly (string | WalkthroughHunkId)[] =>
  hunkIds.map((hunkId) =>
    Option.getOrElse(Option.fromUndefinedOr(aliasToHunkId.get(hunkId)), () => hunkId),
  )
