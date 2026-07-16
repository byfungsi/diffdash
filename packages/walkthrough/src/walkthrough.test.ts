import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer } from "effect"

import {
  AgentCapabilityDeclaration,
  AgentCapabilityManifest,
  AgentCapabilityPolicyUnsupported,
  AgentCapabilityReady,
  AgentModelDescriptor,
  AgentModelId,
  AgentProviderDefaults,
  AgentProviderDescriptor,
  AgentProviderId,
  AgentProviderManifest,
  AgentProviderOperationError,
  AgentRuntimeRequirement,
  AgentSessionSupport,
  type AgentProviderRegistration,
  AgentPolicyEnforcementError,
  UnsupportedAgentCapabilityError,
  type WalkthroughRequest,
  WalkthroughResult,
} from "@diffdash/agent-provider"
import { AgentProviderRegistry } from "@diffdash/agent-provider/registry"

import { LocalReviewDetail } from "@diffdash/domain/local-review"
import {
  PullRequestCommit,
  PullRequestDetail,
  PullRequestFile,
  ReviewActor,
} from "@diffdash/domain/pull-request"
import {
  WalkthroughGenerationDetails,
  type WalkthroughHunkDigest,
} from "@diffdash/domain/walkthrough"
import { WalkthroughRouting, WalkthroughService } from "./walkthrough"

const pullRequest = PullRequestDetail.make({
  author: ReviewActor.make({ login: "octocat" }),
  baseRefName: "main",
  baseRefOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  body: "Adds a walkthrough mode.",
  commits: [
    PullRequestCommit.make({
      authoredDate: "2026-07-08T00:00:00Z",
      messageHeadline: "Add walkthrough mode",
      oid: "cccccccccccccccccccccccccccccccccccccccc",
    }),
  ],
  createdAt: "2026-07-08T00:00:00Z",
  files: [
    PullRequestFile.make({
      additions: 10,
      changeType: "modified",
      deletions: 2,
      path: "src/app.tsx",
    }),
    PullRequestFile.make({
      additions: 5,
      changeType: "modified",
      deletions: 1,
      path: "src/service.ts",
    }),
  ],
  headRefName: "feature/walkthrough",
  headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  isDraft: false,
  number: 51,
  repoName: "diffdash",
  repoOwner: "fungsi",
  state: "OPEN",
  title: "Add walkthrough mode",
  updatedAt: "2026-07-08T01:00:00Z",
  url: "https://github.com/fungsi/diffdash/pull/51",
})

const generationInput = {
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
      id: "src/app.tsx:pull-request:51:h1",
      path: "src/app.tsx",
      synthetic: false,
    },
    {
      additions: 1,
      deletions: 0,
      header: "@@ -10,0 +10,1 @@",
      id: "src/service.ts:pull-request:51:h1",
      path: "src/service.ts",
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
  review: { kind: "pullRequest" as const, pullRequest },
}

const localReview = LocalReviewDetail.make({
  baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  branchName: "feature/walkthrough",
  diffHash: "local-diff-hash",
  fetchedAt: "2026-07-08T01:00:00Z",
  files: pullRequest.files,
  headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  repoName: "diffdash",
  rootPath: "/workspace/repo",
  title: "Local changes in diffdash",
})

const localGenerationInput = {
  ...generationInput,
  review: { kind: "localDiff" as const, localReview },
}

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

const primaryProviderId = AgentProviderId.make("primary")
const fallbackProviderId = AgentProviderId.make("fallback")

const providerManifest = (providerId: AgentProviderId) =>
  AgentProviderManifest.make({
    descriptor: AgentProviderDescriptor.make({
      id: providerId,
      displayName: providerId,
      description: "Walkthrough fixture",
      homepage: null,
    }),
    models: [
      AgentModelDescriptor.make({
        id: AgentModelId.make(`${providerId}-balanced`),
        displayName: "Balanced",
        capabilities: ["walkthrough"],
        quality: "balanced",
      }),
    ],
    defaults: AgentProviderDefaults.make({
      walkthroughModel: AgentModelId.make(`${providerId}-balanced`),
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
          const text = outputs[Math.min(index, outputs.length - 1)] ?? ""
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
      get: Effect.succeed({ route: { mode: "auto" }, models: {}, autoQuality: "balanced" }),
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
    | { readonly mode: "provider"; readonly providerId: AgentProviderId },
  order: readonly AgentProviderId[],
) =>
  WalkthroughService.layer({ remoteWorkingDirectory: "/app/remote" }).pipe(
    Layer.provide(
      AgentProviderRegistry.layer(registrations, { walkthrough: order, reviewThread: [] }),
    ),
    Layer.provide(
      Layer.succeed(
        WalkthroughRouting,
        WalkthroughRouting.of({
          get: Effect.succeed({ route, models: {}, autoQuality: "balanced" }),
        }),
      ),
    ),
  )

describe("WalkthroughService", () => {
  it.effect("FUN-48 AC: returns validated walkthrough data from valid generation", () =>
    Effect.gen(function* () {
      const { calls, layer } = makeLayer([validOutput])

      const walkthrough = yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate(generationInput)
      }).pipe(Effect.provide(layer))

      expect(walkthrough.chapters[0]?.stops.map((stop) => stop.title)).toEqual(["Entry point"])
      expect(walkthrough.chapters[0]?.stops[0]?.hunkIds).toEqual(["src/app.tsx:pull-request:51:h1"])
      expect(walkthrough.support.map((item) => item.title)).toEqual(["Other changes"])
      expect(walkthrough.support[0]?.hunkIds).toEqual(["src/service.ts:pull-request:51:h1"])
      expect(walkthrough.generation?.mode).toBe("standard")
      expect(calls).toHaveLength(1)
      expect(calls[0]?.workingDirectory).toBe("/app/remote")
      expect(calls[0]?.model).toBe("primary-balanced")
      expect(calls[0]?.prompt).toContain("Return JSON only")
      expect(calls[0]?.prompt).toContain('"h":"h1"')
      expect(calls[0]?.prompt).toContain('"context":"diff-only"')
      expect(calls[0]?.prompt).toContain('"baseSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"')
      expect(calls[0]?.prompt).toContain('"headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"')
      expect(calls[0]?.prompt).not.toContain("src/app.tsx:pull-request:51:h1")
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

      expect(calls[0]?.reasoningEffort).toBe("low")
      expect(calls[0]?.timeoutMs).toBe(10 * 60 * 1_000)
      expect(calls[0]?.policy).toMatchObject({
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

      expect(calls[0]?.workingDirectory).toBe("/workspace/repo")
      expect(calls[0]?.prompt).toContain('"type":"local-diff"')
    }),
  )

  it.effect("uses bounded diff excerpts and prompt preparation stats", () =>
    Effect.gen(function* () {
      const { calls, layer } = makeLayer([validOutput])
      const firstHunk = generationInput.hunkDigest[0]
      if (firstHunk === undefined) throw new Error("Expected hunk fixture")
      const noisyPullRequest = PullRequestDetail.make({
        ...pullRequest,
        files: [
          ...pullRequest.files,
          PullRequestFile.make({
            additions: 1_000,
            changeType: "modified",
            deletions: 1_000,
            path: "pnpm-lock.yaml",
          }),
        ],
      })

      yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate({
          ...generationInput,
          diff: "### h1 src/app.tsx\n+new bounded excerpt",
          hunkDigest: [firstHunk],
          review: { kind: "pullRequest", pullRequest: noisyPullRequest },
          promptStats: {
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
          },
        })
      }).pipe(Effect.provide(layer))

      expect(calls[0]?.prompt).toContain("Bounded diff excerpts")
      expect(calls[0]?.prompt).not.toContain("Unified diff:")
      expect(calls[0]?.prompt).toContain('"omittedFiles":2')
      expect(calls[0]?.prompt).toContain("new bounded excerpt")
      expect(calls[0]?.prompt).not.toContain("pnpm-lock.yaml")
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

      expect(calls[0]?.prompt).toContain("sampled-tree walkthrough")
      expect(calls[0]?.prompt).toContain("src/auth (60 files")
      expect(calls[0]?.prompt).toContain("representative samples")
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

      expect(error).toBeInstanceOf(UnsupportedAgentCapabilityError)
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
                Effect.fail(
                  AgentProviderOperationError.make({
                    providerId: primaryProviderId,
                    capability: "walkthrough",
                    reason: "primary failed",
                  }),
                ),
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
      let fallbackCalls = 0
      const primary: AgentProviderRegistration = {
        manifest: providerManifest(primaryProviderId),
        walkthrough: {
          probe: Effect.succeed(
            AgentCapabilityReady.make({ capability: "walkthrough", runtimeVersion: "1" }),
          ),
          execute: () =>
            Effect.never.pipe(Effect.ensuring(Effect.sync(() => void (interrupted = true)))),
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
              fallbackCalls += 1
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
      }).pipe(Effect.provide(layer), Effect.fork)

      yield* Effect.yieldNow()
      yield* Fiber.interrupt(fiber)
      expect(interrupted).toBe(true)
      expect(fallbackCalls).toBe(0)
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
