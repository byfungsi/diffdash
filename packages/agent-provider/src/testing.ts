import { describe, expect, it } from "@effect/vitest"
import { Effect, Either, Fiber, Schema, TestClock } from "effect"

import {
  AgentCapabilityReady,
  AgentExecutionPolicy,
  AgentProviderId,
  AgentProviderManifest,
  AgentProviderOperationError,
  type AgentProviderRegistration,
  DuplicateAgentProviderError,
  InvalidAgentProviderResponseError,
  MissingAgentProviderError,
  type ReviewThreadRequest,
  ReviewThreadResult,
  UnsupportedAgentCapabilityError,
  type WalkthroughRequest,
  WalkthroughResult,
} from "./agent-provider"
import {
  type AgentAutoRoutingPolicies,
  AgentProviderRegistry,
  type AgentProviderRoute,
} from "./registry"

/** Fixtures required by the static manifest conformance suite. */
export interface AgentManifestConformanceFixtures {
  readonly create: () => AgentProviderRegistration
}

/** Verifies manifest shape, model ownership, defaults, and optional capability declarations. */
export const agentManifestConformance = (
  name: string,
  fixtures: AgentManifestConformanceFixtures,
) => {
  describe(`${name} agent manifest conformance`, () => {
    it.effect("publishes a valid, internally coherent manifest", () =>
      Effect.gen(function* () {
        const registration = fixtures.create()
        const manifest = yield* Schema.decodeUnknown(AgentProviderManifest)(registration.manifest)
        const ids = manifest.models.map(({ id }) => id)
        expect(new Set(ids).size).toBe(ids.length)
        for (const model of manifest.models) expect(model.capabilities.length).toBeGreaterThan(0)
        assertDefaultModel(manifest.defaults.walkthroughModel, "walkthrough", manifest)
        assertDefaultModel(manifest.defaults.reviewThreadModel, "review-thread", manifest)
        expect(manifest.capabilities.walkthrough.supported).toBe(
          registration.walkthrough !== undefined,
        )
        expect(manifest.capabilities.reviewThread.supported).toBe(
          registration.reviewThread !== undefined,
        )
        if (!manifest.capabilities.walkthrough.supported) {
          expect(manifest.capabilities.walkthrough.autoPriority).toBeNull()
        }
        if (!manifest.capabilities.reviewThread.supported) {
          expect(manifest.capabilities.reviewThread.autoPriority).toBeNull()
        }
      }),
    )
  })
}

/** Fixtures required by walkthrough capability conformance. */
export interface WalkthroughConformanceFixtures {
  readonly create: () => AgentProviderRegistration
  readonly request: () => WalkthroughRequest
  readonly expectedFailure: () => Effect.Effect<never, unknown>
  readonly temporaryFiles: () => Effect.Effect<readonly string[]>
}

/** Verifies independent probing, explicit non-mutation policy, output, and bounded errors. */
export const walkthroughConformance = (name: string, fixtures: WalkthroughConformanceFixtures) => {
  describe(`${name} walkthrough conformance`, () => {
    it.effect("probes and executes with an explicit non-mutating policy", () =>
      Effect.gen(function* () {
        const capability = requireWalkthrough(fixtures.create())
        const probe = yield* capability.probe
        expect(probe).toBeInstanceOf(AgentCapabilityReady)
        const request = fixtures.request()
        assertNonMutatingPolicy(request.policy)
        const before = yield* fixtures.temporaryFiles()
        const result = yield* capability.execute(request)
        yield* Schema.decodeUnknown(WalkthroughResult)(result)
        expect(yield* fixtures.temporaryFiles()).toEqual(before)
      }),
    )

    it.effect("uses only bounded SDK errors for expected failures", () =>
      Effect.gen(function* () {
        const result = yield* fixtures.expectedFailure().pipe(Effect.either)
        expect(Either.isLeft(result)).toBe(true)
        if (!Either.isLeft(result)) return
        expect(
          result.left instanceof InvalidAgentProviderResponseError ||
            result.left instanceof AgentProviderOperationError,
        ).toBe(true)
      }),
    )
  })
}

/** Fixtures required by review-thread protocol conformance. */
export interface ReviewConformanceFixtures {
  readonly create: () => AgentProviderRegistration
  readonly request: () => ReviewThreadRequest
}

/** Verifies independent probing, structured output, usage, artifacts, and sessions. */
export const reviewConformance = (name: string, fixtures: ReviewConformanceFixtures) => {
  describe(`${name} review conformance`, () => {
    it.effect("returns the validated review protocol and honors its session declaration", () =>
      Effect.gen(function* () {
        const registration = fixtures.create()
        const capability = requireReview(registration)
        const probe = yield* capability.probe
        expect(probe).toBeInstanceOf(AgentCapabilityReady)
        const request = fixtures.request()
        assertNonMutatingPolicy(request.policy)
        const result = yield* capability.execute(request)
        yield* Schema.decodeUnknown(ReviewThreadResult)(result)
        if (registration.manifest.session.mode === "none") expect(result.sessionId).toBeNull()
        if (registration.manifest.session.mode === "resume" && request.sessionId !== null) {
          expect(result.sessionId).not.toBeNull()
        }
        expect(
          request.mcp.allowedTools.every((tool) => request.policy.allowedMcpTools.includes(tool)),
        ).toBe(true)
        for (const value of usageValues(result)) {
          if (value !== null) expect(value).toBeGreaterThanOrEqual(0)
        }
      }),
    )
  })
}

/** Fixtures required to prove mutation, token, tool, and artifact safety. */
export interface AgentSecurityConformanceFixtures {
  readonly run: () => Effect.Effect<ReviewThreadResult, AgentProviderOperationError>
  readonly repositoryState: () => Effect.Effect<string>
  readonly mcpToken: string
  readonly sensitiveValues: readonly string[]
  readonly maxArtifactLength: number
  readonly allowedTools: readonly string[]
  readonly observedTools: () => readonly string[]
}

/** Verifies no repository mutation, MCP escape, token leak, or patch artifact is emitted. */
export const agentSecurityConformance = (
  name: string,
  fixtures: AgentSecurityConformanceFixtures,
) => {
  describe(`${name} agent security conformance`, () => {
    it.effect("preserves repository state and restricts MCP tools", () =>
      Effect.gen(function* () {
        const before = yield* fixtures.repositoryState()
        const result = yield* fixtures.run()
        const after = yield* fixtures.repositoryState()
        expect(after).toBe(before)
        expect(fixtures.observedTools().every((tool) => fixtures.allowedTools.includes(tool))).toBe(
          true,
        )
        const serialized = JSON.stringify(result)
        expect(serialized).not.toContain(fixtures.mcpToken)
        for (const sensitive of fixtures.sensitiveValues)
          expect(serialized).not.toContain(sensitive)
        for (const artifact of result.artifacts) {
          expect(artifact.content.length).toBeLessThanOrEqual(fixtures.maxArtifactLength)
        }
        expect(result.artifacts.some(({ type }) => type === ("patch" as string))).toBe(false)
        expect(result.artifacts.some(({ type }) => type === ("file-change" as string))).toBe(false)
      }),
    )
  })
}

/** Fixtures required to prove interruption and timeout cleanup. */
export interface AgentCancellationConformanceFixtures {
  readonly createRun: () => {
    readonly run: Effect.Effect<void, AgentProviderOperationError>
    readonly cleanedUp: Effect.Effect<boolean>
  }
}

/** Verifies provider resources are released when an execution fiber is interrupted. */
export const agentCancellationConformance = (
  name: string,
  fixtures: AgentCancellationConformanceFixtures,
) => {
  describe(`${name} agent cancellation conformance`, () => {
    it.effect("cleans up resources after interruption", () =>
      Effect.gen(function* () {
        const execution = fixtures.createRun()
        const fiber = yield* Effect.fork(execution.run)
        yield* Effect.yieldNow()
        yield* Fiber.interrupt(fiber)
        expect(yield* execution.cleanedUp).toBe(true)
      }),
    )

    it.effect("cleans up resources after timeout", () =>
      Effect.gen(function* () {
        const execution = fixtures.createRun()
        const fiber = yield* execution.run.pipe(Effect.timeout("1 millis"), Effect.fork)
        yield* TestClock.adjust("1 millis")
        yield* Fiber.await(fiber)
        expect(yield* execution.cleanedUp).toBe(true)
      }),
    )
  })
}

/** Fixtures required by reusable registry conformance. */
export interface AgentRegistryConformanceFixtures {
  readonly registrations: () => readonly AgentProviderRegistration[]
  readonly policies: AgentAutoRoutingPolicies
  readonly walkthroughAutoProviderId: AgentProviderId
  readonly reviewAutoProviderId: AgentProviderId
  readonly unsupportedWalkthroughProviderId: AgentProviderId
}

/** Verifies duplicate rejection, distinct auto routes, and explicit fail-closed resolution. */
export const agentRegistryConformance = (
  name: string,
  fixtures: AgentRegistryConformanceFixtures,
) => {
  describe(`${name} agent registry conformance`, () => {
    it.effect("uses separate automatic routes for each capability", () =>
      Effect.gen(function* () {
        const registry = yield* AgentProviderRegistry
        const walkthrough = yield* registry.resolveWalkthrough(autoRoute)
        const review = yield* registry.resolveReviewThread(autoRoute)
        const registrations = yield* registry.list
        expect(
          registrations.find(({ walkthrough: candidate }) => candidate === walkthrough)?.manifest
            .descriptor.id,
        ).toBe(fixtures.walkthroughAutoProviderId)
        expect(
          registrations.find(({ reviewThread: candidate }) => candidate === review)?.manifest
            .descriptor.id,
        ).toBe(fixtures.reviewAutoProviderId)
      }).pipe(
        Effect.provide(AgentProviderRegistry.layer(fixtures.registrations(), fixtures.policies)),
      ),
    )

    it.effect("fails closed for missing and unsupported explicit selections", () =>
      Effect.gen(function* () {
        const registry = yield* AgentProviderRegistry
        const missing = yield* registry
          .resolveWalkthrough(providerRoute(AgentProviderId.make("missing")))
          .pipe(Effect.either)
        const unsupported = yield* registry
          .resolveWalkthrough(providerRoute(fixtures.unsupportedWalkthroughProviderId))
          .pipe(Effect.either)
        expect(Either.isLeft(missing)).toBe(true)
        expect(Either.isLeft(unsupported)).toBe(true)
        if (Either.isLeft(missing)) expect(missing.left).toBeInstanceOf(MissingAgentProviderError)
        if (Either.isLeft(unsupported)) {
          expect(unsupported.left).toBeInstanceOf(UnsupportedAgentCapabilityError)
        }
      }).pipe(
        Effect.provide(AgentProviderRegistry.layer(fixtures.registrations(), fixtures.policies)),
      ),
    )

    it.effect("rejects duplicate provider IDs", () =>
      Effect.gen(function* () {
        const registration = fixtures.registrations()[0]
        expect(registration).toBeDefined()
        if (registration === undefined) return
        const result = yield* AgentProviderRegistry.pipe(
          Effect.provide(
            AgentProviderRegistry.layer([registration, registration], fixtures.policies),
          ),
          Effect.either,
        )
        expect(Either.isLeft(result)).toBe(true)
        if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(DuplicateAgentProviderError)
      }),
    )
  })
}

const autoRoute: AgentProviderRoute = { mode: "auto" }
const providerRoute = (providerId: AgentProviderId): AgentProviderRoute => ({
  mode: "provider",
  providerId,
})

const requireWalkthrough = (registration: AgentProviderRegistration) => {
  expect(registration.walkthrough).toBeDefined()
  if (registration.walkthrough === undefined) throw new Error("Missing walkthrough fixture")
  return registration.walkthrough
}

const requireReview = (registration: AgentProviderRegistration) => {
  expect(registration.reviewThread).toBeDefined()
  if (registration.reviewThread === undefined) throw new Error("Missing review fixture")
  return registration.reviewThread
}

const assertNonMutatingPolicy = (policy: AgentExecutionPolicy) => {
  expect(policy.sensitiveFiles).toBe("deny")
  expect(policy.fileMutation).toBe("deny")
  expect(policy.gitMutation).toBe("deny")
  expect(policy.providerPublishing).toBe("deny")
  expect(["deny", "read-only"]).toContain(policy.shell)
}

const assertDefaultModel = (
  modelId: AgentProviderManifest["defaults"]["walkthroughModel"],
  capability: "walkthrough" | "review-thread",
  manifest: AgentProviderManifest,
) => {
  if (modelId === null) return
  const model = manifest.models.find(({ id }) => id === modelId)
  expect(model).toBeDefined()
  expect(model?.capabilities).toContain(capability)
}

const usageValues = ({ usage }: ReviewThreadResult) =>
  usage === null
    ? []
    : [
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        usage.cacheWriteTokens,
        usage.costUsd,
      ]
