import { describe, expect, it } from "@effect/vitest"
import { Array as EffectArray, Effect, Fiber, Layer, Option, Schema } from "effect"

import {
  AgentCapabilityDeclaration,
  AgentCapabilityManifest,
  AgentCapabilityPolicyUnsupported,
  AgentCapabilityReady,
  AgentCapabilityUnavailable,
  AgentModelDescriptor,
  AgentModelId,
  AgentProviderDefaults,
  AgentProviderDescriptor,
  AgentProviderId,
  AgentProviderManifest,
  AgentRuntimeRequirement,
  AgentSessionSupport,
  InvalidAgentProviderResponseError,
  InvalidAgentProviderRegistrationError,
  type AgentProviderRegistration,
  AgentPolicyEnforcementError,
  type WalkthroughRequest,
  WalkthroughResult,
} from "@diffdash/agent-provider"
import { AgentProviderRegistry } from "@diffdash/agent-provider/registry"
import { makeAgentProviderOperationErrorFactory } from "@diffdash/agent-provider/runtime"
import { AIAgentSelection, AIModelId, AIProviderId } from "@diffdash/domain/ai-settings"

import { LocalReviewDetail } from "@diffdash/domain/local-review"
import {
  GitCommitSha,
  RepositoryComparisonDetail,
  RepositoryComparisonRef,
  RepositoryComparisonTarget,
} from "@diffdash/domain/repository-comparison"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ReviewDiffIdentity, ReviewRevision } from "@diffdash/domain/review-identity"
import { WebUrl } from "@diffdash/domain/web-url"
import {
  BranchRevision,
  ChangedFile,
  HostedReviewDetail,
  HostedReviewSummary,
  ProviderActor,
  ReviewCommit,
  makeHostedReviewLocator,
} from "@diffdash/domain/git-provider"
import {
  WalkthroughGenerationDetails,
  WalkthroughHunkId,
  type WalkthroughHunkDigest,
  WalkthroughValidationError,
} from "@diffdash/domain/walkthrough"
import {
  WalkthroughGenerationInput,
  WalkthroughReviewContext,
  WalkthroughRouting,
  WalkthroughService,
} from "./walkthrough"

const first = <A>(values: readonly A[]): A => Option.getOrThrow(EffectArray.head(values))

const summary = HostedReviewSummary.make({
  locator: makeHostedReviewLocator("github", "fungsi", "diffdash", 51),
  author: ProviderActor.make({
    id: null,
    username: "octocat",
    displayName: null,
    avatarUrl: null,
  }),
  base: BranchRevision.make({
    name: RepositoryComparisonRef.make("main"),
    revision: ReviewRevision.make("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
  }),
  body: "Adds a walkthrough mode.",
  createdAt: "2026-07-08T00:00:00Z",
  decision: "none",
  draft: false,
  head: BranchRevision.make({
    name: RepositoryComparisonRef.make("feature/walkthrough"),
    revision: ReviewRevision.make("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
  }),
  state: "OPEN",
  title: "Add walkthrough mode",
  updatedAt: "2026-07-08T01:00:00Z",
  url: WebUrl.make("https://github.com/fungsi/diffdash/pull/51"),
})

const hostedReview = HostedReviewDetail.make({
  summary,
  commits: [
    ReviewCommit.make({
      authoredAt: "2026-07-08T00:00:00Z",
      title: "Add walkthrough mode",
      revision: ReviewRevision.make("cccccccccccccccccccccccccccccccccccccccc"),
    }),
  ],
  files: [
    ChangedFile.make({
      additions: 10,
      changeType: "modified",
      deletions: 2,
      path: RepositoryRelativePath.make("src/app.tsx"),
    }),
    ChangedFile.make({
      additions: 5,
      changeType: "modified",
      deletions: 1,
      path: RepositoryRelativePath.make("src/service.ts"),
    }),
  ],
})

const generationInput = WalkthroughGenerationInput.make({
  changedFileTree: "",
  diff: `diff --git a/src/app.tsx b/src/app.tsx
--- a/src/app.tsx
+++ b/src/app.tsx
@@ -1,1 +1,1 @@
-old
+new`,
  hunkDigest: [
    {
      additions: 1,
      deletions: 1,
      header: "@@ -1,1 +1,1 @@",
      id: WalkthroughHunkId.make("src/app.tsx:hosted-review:github:fungsi/diffdash#51:h1"),
      path: RepositoryRelativePath.make("src/app.tsx"),
      synthetic: false,
    },
    {
      additions: 1,
      deletions: 0,
      header: "@@ -10,0 +10,1 @@",
      id: WalkthroughHunkId.make("src/service.ts:hosted-review:github:fungsi/diffdash#51:h1"),
      path: RepositoryRelativePath.make("src/service.ts"),
      synthetic: false,
    },
  ] satisfies readonly WalkthroughHunkDigest[],
  generation: WalkthroughGenerationDetails.make({
    mode: "standard",
    totalFiles: 2,
    analyzedFiles: 2,
    totalFolders: 1,
    analyzedFolders: 1,
  }),
  review: WalkthroughReviewContext.make({ kind: "hosted", hostedReview }),
  promptStats: Option.none(),
  workingDirectory: Option.none(),
})

const localReview = LocalReviewDetail.make({
  baseSha: ReviewRevision.make("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
  branchName: RepositoryComparisonRef.make("feature/walkthrough"),
  diffHash: ReviewDiffIdentity.make("local-diff-hash"),
  fetchedAt: "2026-07-08T01:00:00Z",
  files: hostedReview.files,
  headSha: ReviewRevision.make("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
  repoName: "diffdash",
  rootPath: RepositoryCheckoutPath.make("/workspace/repo"),
  title: "Local changes in diffdash",
})

const localGenerationInput = WalkthroughGenerationInput.make({
  ...generationInput,
  review: WalkthroughReviewContext.make({ kind: "localDiff", localReview }),
})

const repositoryComparison = RepositoryComparisonDetail.make({
  target: RepositoryComparisonTarget.make({
    kind: "repositoryComparison",
    repository: summary.locator.repository,
    baseRef: RepositoryComparisonRef.make("main"),
    headRef: RepositoryComparisonRef.make("feature/walkthrough"),
    baseSha: GitCommitSha.make("b".repeat(40)),
    headSha: GitCommitSha.make("a".repeat(40)),
    mergeBaseSha: GitCommitSha.make("c".repeat(40)),
  }),
  title: "Compare feature/walkthrough with main",
  files: hostedReview.files,
  fetchedAt: "2026-07-08T01:00:00Z",
})

const repositoryComparisonGenerationInput = WalkthroughGenerationInput.make({
  ...generationInput,
  review: WalkthroughReviewContext.make({
    kind: "repositoryComparison",
    comparison: repositoryComparison,
  }),
  workingDirectory: Option.some("/workspace/comparison"),
})

const validOutput = JSON.stringify({
  title: "Review path",
  summary: "Review app entry first, then the service support change.",
  chapters: [
    {
      id: "c1",
      summary: "Runtime changes.",
      title: "Runtime",
      stops: [
        {
          hunkIds: ["h1"],
          id: "s1",
          risk: "critical",
          summary: "Entry point controls the visible walkthrough behavior.",
          title: "Entry point",
        },
      ],
    },
  ],
})

const invalidIdentityOutput = validOutput.replace('"id":"c1"', '"id":""')

const invalidCoverageOutput = JSON.stringify({
  title: "Invalid path",
  summary: "Incomplete output.",
  chapters: [
    {
      id: "c1",
      summary: "Runtime changes.",
      title: "Runtime",
      stops: [
        {
          hunkIds: ["h999"],
          id: "s1",
          risk: "critical",
          summary: "Unknown hunk.",
          title: "Entry point",
        },
      ],
    },
  ],
  support: [],
})

const invalidShapeOutput = JSON.stringify({
  title: "Invalid shape",
  summary: "Contains a non-string hunk alias.",
  chapters: [
    {
      id: "c1",
      summary: "Runtime changes.",
      title: "Runtime",
      stops: [
        {
          hunkIds: [1],
          id: "s1",
          risk: "critical",
          summary: "Invalid hunk alias.",
          title: "Entry point",
        },
      ],
    },
  ],
})

const primaryProviderId = AgentProviderId.make("primary")
const fallbackProviderId = AgentProviderId.make("fallback")
const primaryOperationErrors = makeAgentProviderOperationErrorFactory({
  providerId: primaryProviderId,
  fallbackReason: "Primary provider failed",
})

const providerManifest = (
  providerId: AgentProviderId,
  modelIds: readonly AgentModelId[] = [AgentModelId.make(`${providerId}-balanced`)],
) =>
  AgentProviderManifest.make({
    descriptor: AgentProviderDescriptor.make({
      id: providerId,
      displayName: providerId,
      description: "Walkthrough fixture",
      homepage: null,
    }),
    models: modelIds.map((modelId) =>
      AgentModelDescriptor.make({
        id: modelId,
        displayName: "Balanced",
        capabilities: ["walkthrough"],
        quality: "balanced",
      }),
    ),
    defaults: AgentProviderDefaults.make({
      walkthroughModel: Option.getOrNull(EffectArray.head(modelIds)),
      reviewThreadModel: null,
    }),
    requirements: [
      AgentRuntimeRequirement.make({ name: providerId, versionRange: null, installHint: null }),
    ],
    capabilities: AgentCapabilityManifest.make({
      walkthrough: AgentCapabilityDeclaration.make({ supported: true, autoPriority: 10 }),
      reviewThread: AgentCapabilityDeclaration.make({ supported: false, autoPriority: null }),
    }),
    session: AgentSessionSupport.make({ mode: "none" }),
  })

const readyWalkthroughRegistration = (
  providerId: AgentProviderId,
  modelIds: readonly AgentModelId[],
  execute: NonNullable<AgentProviderRegistration["walkthrough"]>["execute"],
): AgentProviderRegistration => ({
  manifest: providerManifest(providerId, modelIds),
  walkthrough: {
    probe: Effect.succeed(
      AgentCapabilityReady.make({ capability: "walkthrough", runtimeVersion: "1" }),
    ),
    execute,
  },
})

const makeLayer = (outputs: readonly string[]) => {
  const calls: WalkthroughRequest[] = []
  let index = 0
  const registration: AgentProviderRegistration = {
    manifest: providerManifest(primaryProviderId),
    walkthrough: {
      probe: Effect.succeed(
        AgentCapabilityReady.make({ capability: "walkthrough", runtimeVersion: "1" }),
      ),
      execute: (request) =>
        Effect.sync(() => {
          calls.push(request)
          const text = Option.getOrElse(
            EffectArray.get(outputs, Math.min(index, outputs.length - 1)),
            () => "",
          )
          index += 1
          return WalkthroughResult.make({ text })
        }),
    },
  }
  const registryLayer = AgentProviderRegistry.layer([registration], {
    walkthrough: [primaryProviderId],
    reviewThread: [],
  })
  const routingLayer = Layer.succeed(
    WalkthroughRouting,
    WalkthroughRouting.of({
      get: Effect.succeed({
        selection: AIAgentSelection.cases.Automatic.make({ quality: "balanced" }),
      }),
    }),
  )
  const layer = WalkthroughService.layer({ remoteWorkingDirectory: "/app/remote" }).pipe(
    Layer.provide(registryLayer),
    Layer.provide(routingLayer),
  )

  return { calls, layer }
}

const serviceLayer = (
  registrations: readonly AgentProviderRegistration[],
  route:
    | { readonly mode: "auto" }
    | {
        readonly mode: "provider"
        readonly providerId: AgentProviderId
        readonly useDefaultModel?: boolean
      },
  order: readonly AgentProviderId[],
) => {
  const selection =
    route.mode === "auto"
      ? AIAgentSelection.cases.Automatic.make({ quality: "balanced" })
      : AIAgentSelection.cases.Pinned.make({
          providerId: AIProviderId.make(route.providerId),
          modelId: route.useDefaultModel
            ? null
            : AIModelId.make(
                registrations.find(({ manifest }) => manifest.descriptor.id === route.providerId)
                  ?.manifest.defaults.walkthroughModel ?? "missing-model",
              ),
        })
  return WalkthroughService.layer({ remoteWorkingDirectory: "/app/remote" }).pipe(
    Layer.provide(
      AgentProviderRegistry.layer(registrations, { walkthrough: order, reviewThread: [] }),
    ),
    Layer.provide(
      Layer.succeed(
        WalkthroughRouting,
        WalkthroughRouting.of({
          get: Effect.succeed({ selection }),
        }),
      ),
    ),
  )
}

describe("WalkthroughService", () => {
  it.effect("captures the configured route and ordered provider/model plan", () => {
    const primaryModels = [AgentModelId.make("primary-fast"), AgentModelId.make("primary-balanced")]
    const fallbackModels = [AgentModelId.make("fallback-balanced")]
    const registrations = [
      readyWalkthroughRegistration(primaryProviderId, primaryModels, () => Effect.never),
      readyWalkthroughRegistration(fallbackProviderId, fallbackModels, () => Effect.never),
    ]
    return Effect.gen(function* () {
      const service = yield* WalkthroughService
      const route = yield* service.prepareRoute

      expect(route.selection).toMatchObject({ _tag: "Automatic", quality: "balanced" })
      expect(route.candidates).toEqual([
        { providerId: fallbackProviderId, modelIds: fallbackModels },
        { providerId: primaryProviderId, modelIds: primaryModels },
      ])
    }).pipe(
      Effect.provide(
        serviceLayer(registrations, { mode: "auto" }, [fallbackProviderId, primaryProviderId]),
      ),
    )
  })

  it("round-trips generation input through its schema", () => {
    const input = WalkthroughGenerationInput.make({
      ...generationInput,
      promptStats: Option.some({
        hiddenFiles: 1,
        omittedFiles: 2,
        omittedHunks: 3,
        selectedFiles: 4,
        selectedHunks: 5,
        totalFiles: 6,
        totalHunks: 8,
        truncatedByCharBudget: true,
        truncatedHunks: 1,
        usedHiddenFallback: false,
      }),
      workingDirectory: Option.some("/workspace/repo"),
    })

    const encoded = Schema.encodeSync(WalkthroughGenerationInput)(input)

    expect(Schema.decodeUnknownSync(WalkthroughGenerationInput)(encoded)).toEqual(input)
  })

  it.effect("FUN-48 AC: returns validated walkthrough data from valid generation", () =>
    Effect.gen(function* () {
      const { calls, layer } = makeLayer([validOutput])

      const walkthrough = yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate(generationInput)
      }).pipe(Effect.provide(layer))

      const chapter = first(walkthrough.chapters)
      expect(chapter.stops.map((stop) => stop.title)).toEqual(["Entry point"])
      expect(first(chapter.stops).hunkIds).toEqual([
        "src/app.tsx:hosted-review:github:fungsi/diffdash#51:h1",
      ])
      expect(walkthrough.support.map((item) => item.title)).toEqual(["Other changes"])
      expect(first(walkthrough.support).hunkIds).toEqual([
        "src/service.ts:hosted-review:github:fungsi/diffdash#51:h1",
      ])
      expect(Option.getOrThrow(Option.fromUndefinedOr(walkthrough.generation)).mode).toBe(
        "standard",
      )
      expect(calls).toHaveLength(1)
      const call = first(calls)
      expect(call.workingDirectory).toBe("/app/remote")
      expect(call.model).toBe("primary-balanced")
      expect(call.prompt).toContain("Return JSON only")
      expect(call.prompt).toContain('"h":"h1"')
      expect(call.prompt).toContain('"s":0')
      expect(call.prompt).toContain('"prompt":null')
      expect(call.prompt).toContain('"context":"diff-only"')
      expect(call.prompt).toContain('"baseSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"')
      expect(call.prompt).toContain('"headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"')
      expect(call.prompt).toContain(
        '"files":[{"a":1,"d":1,"p":"src/app.tsx","t":"modified"},{"a":1,"d":0,"p":"src/service.ts","t":"modified"}]',
      )
      expect(call.prompt).toContain(
        '"commits":[{"oid":"cccccccccccccccccccccccccccccccccccccccc","msg":"Add walkthrough mode","date":"2026-07-08T00:00:00Z"}]',
      )
      expect(call.prompt).not.toContain("src/app.tsx:hosted-review:github:fungsi/diffdash#51:h1")
      expect(call.prompt).not.toContain('"alias":')
      expect(call.prompt).not.toContain('"synthetic":')
      expect(call.prompt).not.toContain('"changeType":')
      expect(call.prompt).not.toContain('"authoredAt":')
    }),
  )

  it.effect("uses the manifest default for a provider-default pinned route", () =>
    Effect.gen(function* () {
      const selectedModels: AgentModelId[] = []
      const defaultModel = AgentModelId.make("primary-default")
      const registration = readyWalkthroughRegistration(
        primaryProviderId,
        [defaultModel],
        (request) =>
          Effect.sync(() => {
            selectedModels.push(request.model)
            return WalkthroughResult.make({ text: validOutput })
          }),
      )

      yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        yield* service.generate(generationInput)
      }).pipe(
        Effect.provide(
          serviceLayer(
            [registration],
            { mode: "provider", providerId: primaryProviderId, useDefaultModel: true },
            [primaryProviderId],
          ),
        ),
      )

      expect(selectedModels).toEqual([defaultModel])
    }),
  )

  it.effect("FUN-48 AC: invalid JSON retries once and then succeeds", () =>
    Effect.gen(function* () {
      const { calls, layer } = makeLayer(["not json", validOutput])

      const walkthrough = yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate(generationInput)
      }).pipe(Effect.provide(layer))

      expect(walkthrough.summary).toContain("Review app entry")
      expect(calls).toHaveLength(2)
    }),
  )

  it.effect("invalid provider output shape retries once and then fails", () =>
    Effect.gen(function* () {
      const { calls, layer } = makeLayer([invalidShapeOutput, invalidShapeOutput])

      const error = yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate(generationInput)
      }).pipe(Effect.provide(layer), Effect.flip)

      expect(error).toBeInstanceOf(WalkthroughValidationError)
      expect(calls).toHaveLength(2)
    }),
  )

  it.effect("decodes provider-supplied walkthrough identities into typed validation failures", () =>
    Effect.gen(function* () {
      const { calls, layer } = makeLayer([invalidIdentityOutput, invalidIdentityOutput])

      const error = yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate(generationInput)
      }).pipe(Effect.provide(layer), Effect.flip)

      expect(error).toBeInstanceOf(WalkthroughValidationError)
      if (!(error instanceof WalkthroughValidationError)) {
        throw new Error("Expected walkthrough identity validation to fail")
      }
      expect(error.reason).toBe("invalid_shape")
      expect(calls).toHaveLength(2)
    }),
  )

  it.effect("Auto retries invalid output on the same model before advancing models", () =>
    Effect.gen(function* () {
      const firstModel = AgentModelId.make("primary-first")
      const secondModel = AgentModelId.make("primary-second")
      const calls: AgentModelId[] = []
      const registration = readyWalkthroughRegistration(
        primaryProviderId,
        [firstModel, secondModel],
        (request) =>
          Effect.sync(() => {
            calls.push(request.model)
            return WalkthroughResult.make({
              text: request.model === firstModel ? "not json" : validOutput,
            })
          }),
      )

      const walkthrough = yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate(generationInput)
      }).pipe(Effect.provide(serviceLayer([registration], { mode: "auto" }, [primaryProviderId])))

      expect(walkthrough.title).toBe("Review path")
      expect(calls).toEqual([firstModel, firstModel, secondModel])
    }),
  )

  it.effect("Auto retries empty output but advances immediately after a process failure", () =>
    Effect.gen(function* () {
      const emptyModel = AgentModelId.make("primary-empty")
      const failingModel = AgentModelId.make("primary-failing")
      const fallbackModel = AgentModelId.make("fallback-balanced")
      const calls: string[] = []
      const primary = readyWalkthroughRegistration(
        primaryProviderId,
        [emptyModel, failingModel],
        (request) => {
          calls.push(`${primaryProviderId}:${request.model}`)
          return request.model === emptyModel
            ? Effect.fail(
                InvalidAgentProviderResponseError.make({
                  providerId: primaryProviderId,
                  capability: "walkthrough",
                  reason: "Provider returned empty output",
                }),
              )
            : Effect.fail(
                primaryOperationErrors.fromReason("walkthrough", "primary process failed"),
              )
        },
      )
      const fallback = readyWalkthroughRegistration(
        fallbackProviderId,
        [fallbackModel],
        (request) =>
          Effect.sync(() => {
            calls.push(`${fallbackProviderId}:${request.model}`)
            return WalkthroughResult.make({ text: validOutput })
          }),
      )

      const walkthrough = yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate(generationInput)
      }).pipe(
        Effect.provide(
          serviceLayer([primary, fallback], { mode: "auto" }, [
            primaryProviderId,
            fallbackProviderId,
          ]),
        ),
      )

      expect(walkthrough.generation).toEqual(generationInput.generation)
      expect(calls).toEqual([
        `${primaryProviderId}:${emptyModel}`,
        `${primaryProviderId}:${emptyModel}`,
        `${primaryProviderId}:${failingModel}`,
        `${fallbackProviderId}:${fallbackModel}`,
      ])
    }),
  )

  it.effect("an explicit provider retries invalid output once without changing candidates", () =>
    Effect.gen(function* () {
      const selectedModel = AgentModelId.make("primary-selected")
      const unusedModel = AgentModelId.make("primary-unused")
      const calls: string[] = []
      const primary = readyWalkthroughRegistration(
        primaryProviderId,
        [selectedModel, unusedModel],
        (request) =>
          Effect.sync(() => {
            calls.push(`${primaryProviderId}:${request.model}`)
            return WalkthroughResult.make({ text: invalidCoverageOutput })
          }),
      )
      const fallbackModel = AgentModelId.make("fallback-balanced")
      const fallback = readyWalkthroughRegistration(
        fallbackProviderId,
        [fallbackModel],
        (request) =>
          Effect.sync(() => {
            calls.push(`${fallbackProviderId}:${request.model}`)
            return WalkthroughResult.make({ text: validOutput })
          }),
      )

      const error = yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate(generationInput)
      }).pipe(
        Effect.provide(
          serviceLayer([primary, fallback], { mode: "provider", providerId: primaryProviderId }, [
            fallbackProviderId,
            primaryProviderId,
          ]),
        ),
        Effect.flip,
      )

      expect(error).toBeInstanceOf(WalkthroughValidationError)
      expect(calls).toEqual([
        `${primaryProviderId}:${selectedModel}`,
        `${primaryProviderId}:${selectedModel}`,
      ])
    }),
  )

  it.effect("Auto preserves the final substantive error past unavailable providers", () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const primaryModel = AgentModelId.make("primary-balanced")
      const primary = readyWalkthroughRegistration(primaryProviderId, [primaryModel], (request) =>
        Effect.sync(() => {
          calls.push(`${primaryProviderId}:${request.model}`)
          return WalkthroughResult.make({ text: invalidCoverageOutput })
        }),
      )
      const unavailableFallback: AgentProviderRegistration = {
        manifest: providerManifest(fallbackProviderId),
        walkthrough: {
          probe: Effect.succeed(
            AgentCapabilityUnavailable.make({
              capability: "walkthrough",
              reason: "Unavailable fixture",
            }),
          ),
          execute: () => Effect.die(new Error("Unavailable provider must not execute")),
        },
      }

      const error = yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate(generationInput)
      }).pipe(
        Effect.provide(
          serviceLayer([primary, unavailableFallback], { mode: "auto" }, [
            primaryProviderId,
            fallbackProviderId,
          ]),
        ),
        Effect.flip,
      )

      expect(error).toBeInstanceOf(WalkthroughValidationError)
      expect(calls).toEqual([
        `${primaryProviderId}:primary-balanced`,
        `${primaryProviderId}:primary-balanced`,
      ])
    }),
  )

  it.effect("FUN-48 AC: invalid coverage retries once and then fails if still invalid", () =>
    Effect.gen(function* () {
      const { calls, layer } = makeLayer([invalidCoverageOutput, invalidCoverageOutput])

      const error = yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate(generationInput)
      }).pipe(Effect.provide(layer), Effect.flip)

      expect(error["_tag"]).toBe("WalkthroughValidationError")
      expect(calls).toHaveLength(2)
    }),
  )

  it.effect("FUN-48 AC: generation passes fast generation options to the AI agent", () =>
    Effect.gen(function* () {
      const { calls, layer } = makeLayer([validOutput])

      yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate(generationInput)
      }).pipe(Effect.provide(layer))

      const call = first(calls)
      expect(call.reasoningEffort).toBe("low")
      expect(call.timeoutMs).toBe(10 * 60 * 1_000)
      expect(call.policy).toMatchObject({
        sensitiveFiles: "deny",
        shell: "read-only",
        fileMutation: "deny",
        gitMutation: "deny",
        providerPublishing: "deny",
      })
    }),
  )

  it.effect("passes local repository cwd for local walkthrough generation", () =>
    Effect.gen(function* () {
      const { calls, layer } = makeLayer([validOutput])

      yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate(localGenerationInput)
      }).pipe(Effect.provide(layer))

      const call = first(calls)
      expect(call.workingDirectory).toBe("/workspace/repo")
      expect(call.prompt).toContain('"type":"local-diff"')
    }),
  )

  it.effect("encodes repository comparison review context", () =>
    Effect.gen(function* () {
      const { calls, layer } = makeLayer([validOutput])

      yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate(repositoryComparisonGenerationInput)
      }).pipe(Effect.provide(layer))

      const call = first(calls)
      expect(call.workingDirectory).toBe("/workspace/comparison")
      expect(call.prompt).toContain('"type":"repository-comparison"')
      expect(call.prompt).toContain(`"mergeBaseSha":"${"c".repeat(40)}"`)
    }),
  )

  it.effect("uses bounded diff excerpts and prompt preparation stats", () =>
    Effect.gen(function* () {
      const { calls, layer } = makeLayer([validOutput])
      const firstHunk = first(generationInput.hunkDigest)
      const noisyHostedReview = HostedReviewDetail.make({
        ...hostedReview,
        files: [
          ...hostedReview.files,
          ChangedFile.make({
            additions: 1_000,
            changeType: "modified",
            deletions: 1_000,
            path: RepositoryRelativePath.make("pnpm-lock.yaml"),
          }),
        ],
      })

      yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate({
          ...generationInput,
          diff: "### h1 src/app.tsx\n+new bounded excerpt",
          hunkDigest: [firstHunk],
          review: WalkthroughReviewContext.make({
            kind: "hosted",
            hostedReview: noisyHostedReview,
          }),
          promptStats: Option.some({
            hiddenFiles: 1,
            omittedFiles: 2,
            omittedHunks: 3,
            selectedFiles: 4,
            selectedHunks: 5,
            totalFiles: 6,
            totalHunks: 8,
            truncatedByCharBudget: true,
            truncatedHunks: 1,
            usedHiddenFallback: false,
          }),
        })
      }).pipe(Effect.provide(layer))

      const call = first(calls)
      expect(call.prompt).toContain("Bounded diff excerpts")
      expect(call.prompt).not.toContain("Unified diff:")
      expect(call.prompt).toContain('"omittedFiles":2')
      expect(call.prompt).toContain("new bounded excerpt")
      expect(call.prompt).not.toContain("pnpm-lock.yaml")
    }),
  )

  it.effect("uses the changed file tree for sampled walkthrough generation", () =>
    Effect.gen(function* () {
      const { calls, layer } = makeLayer([validOutput])
      const generation = WalkthroughGenerationDetails.make({
        mode: "sampled-tree",
        totalFiles: 120,
        analyzedFiles: 4,
        totalFolders: 8,
        analyzedFolders: 4,
      })

      const result = yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate({
          ...generationInput,
          changedFileTree: "src/auth (60 files, +600 -200)\nsrc/billing (60 files, +400 -100)",
          generation,
        })
      }).pipe(Effect.provide(layer))

      const call = first(calls)
      expect(call.prompt).toContain("sampled-tree walkthrough")
      expect(call.prompt).toContain("src/auth (60 files")
      expect(call.prompt).toContain("representative samples")
      expect(result.generation).toEqual(generation)
    }),
  )

  it.effect("FUN-136 AC: reports a missing walkthrough capability for an explicit route", () =>
    Effect.gen(function* () {
      const registration: AgentProviderRegistration = {
        manifest: providerManifest(primaryProviderId),
      }
      const error = yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate(generationInput)
      }).pipe(
        Effect.provide(
          serviceLayer([registration], { mode: "provider", providerId: primaryProviderId }, [
            primaryProviderId,
          ]),
        ),
        Effect.flip,
      )

      expect(error).toBeInstanceOf(InvalidAgentProviderRegistrationError)
    }),
  )

  it.effect(
    "FUN-136 AC: follows explicit automatic order and falls back after execution failure",
    () =>
      Effect.gen(function* () {
        const calls: AgentProviderId[] = []
        const registration = (
          providerId: AgentProviderId,
          execute: NonNullable<AgentProviderRegistration["walkthrough"]>,
        ): AgentProviderRegistration => ({
          manifest: providerManifest(providerId),
          walkthrough: execute,
        })
        const primary = registration(primaryProviderId, {
          probe: Effect.succeed(
            AgentCapabilityReady.make({ capability: "walkthrough", runtimeVersion: "1" }),
          ),
          execute: () =>
            Effect.sync(() => calls.push(primaryProviderId)).pipe(
              Effect.flatMap(() =>
                Effect.fail(primaryOperationErrors.fromReason("walkthrough", "primary failed")),
              ),
            ),
        })
        const fallback = registration(fallbackProviderId, {
          probe: Effect.succeed(
            AgentCapabilityReady.make({ capability: "walkthrough", runtimeVersion: "1" }),
          ),
          execute: () =>
            Effect.sync(() => calls.push(fallbackProviderId)).pipe(
              Effect.as(WalkthroughResult.make({ text: validOutput })),
            ),
        })

        const result = yield* Effect.gen(function* () {
          const service = yield* WalkthroughService
          return yield* service.generate(generationInput)
        }).pipe(
          Effect.provide(
            serviceLayer([fallback, primary], { mode: "auto" }, [
              primaryProviderId,
              fallbackProviderId,
            ]),
          ),
        )

        expect(result.title).toBe("Review path")
        expect(calls).toEqual([primaryProviderId, fallbackProviderId])
      }),
  )

  it.effect("FUN-136 AC: interruption does not trigger automatic fallback", () =>
    Effect.gen(function* () {
      let interrupted = false
      const calls: AgentProviderId[] = []
      const primary: AgentProviderRegistration = {
        manifest: providerManifest(primaryProviderId),
        walkthrough: {
          probe: Effect.succeed(
            AgentCapabilityReady.make({ capability: "walkthrough", runtimeVersion: "1" }),
          ),
          execute: () =>
            Effect.sync(() => calls.push(primaryProviderId)).pipe(
              Effect.flatMap(() => Effect.never),
              Effect.ensuring(Effect.sync(() => void (interrupted = true))),
            ),
        },
      }
      const fallback: AgentProviderRegistration = {
        manifest: providerManifest(fallbackProviderId),
        walkthrough: {
          probe: Effect.succeed(
            AgentCapabilityReady.make({ capability: "walkthrough", runtimeVersion: "1" }),
          ),
          execute: () =>
            Effect.sync(() => {
              calls.push(fallbackProviderId)
              return WalkthroughResult.make({ text: validOutput })
            }),
        },
      }
      const layer = serviceLayer([primary, fallback], { mode: "auto" }, [
        primaryProviderId,
        fallbackProviderId,
      ])
      const fiber = yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate(generationInput)
      }).pipe(Effect.provide(layer), Effect.forkChild)

      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      expect(interrupted).toBe(true)
      expect(calls).toEqual([primaryProviderId])
    }),
  )

  it.effect("FUN-136 AC: rejects a provider that cannot enforce walkthrough policy", () =>
    Effect.gen(function* () {
      const registration: AgentProviderRegistration = {
        manifest: providerManifest(primaryProviderId),
        walkthrough: {
          probe: Effect.succeed(
            AgentCapabilityPolicyUnsupported.make({
              capability: "walkthrough",
              reason: "sandbox is unavailable",
            }),
          ),
          execute: () => Effect.succeed(WalkthroughResult.make({ text: validOutput })),
        },
      }
      const error = yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate(generationInput)
      }).pipe(
        Effect.provide(
          serviceLayer([registration], { mode: "provider", providerId: primaryProviderId }, [
            primaryProviderId,
          ]),
        ),
        Effect.flip,
      )

      expect(error).toBeInstanceOf(AgentPolicyEnforcementError)
    }),
  )
})
