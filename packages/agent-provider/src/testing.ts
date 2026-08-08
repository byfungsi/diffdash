import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"

import {
  AgentCapabilityReady,
  AgentExecutionPolicy,
  AgentProviderId,
  AgentProviderManifest,
  AgentProviderOperationError,
  type AgentProviderRegistration,
  DuplicateAgentProviderError,
  InvalidAgentProviderResponseError,
  McpToolName,
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
import { isNonMutatingAgentExecutionPolicy } from "./policy"
import { isScopedMcpToolSubset } from "./security"

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
        const manifest = yield* Schema.decodeUnknownEffect(AgentProviderManifest)(
          registration.manifest,
        )
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
        yield* Schema.decodeUnknownEffect(WalkthroughResult)(result)
        expect(yield* fixtures.temporaryFiles()).toEqual(before)
      }),
    )

    it.effect("uses only bounded SDK errors for expected failures", () =>
      Effect.gen(function* () {
        const result = yield* fixtures.expectedFailure().pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        if (!Result.isFailure(result)) return
        expect(
          result.failure instanceof InvalidAgentProviderResponseError ||
            result.failure instanceof AgentProviderOperationError,
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
        yield* Schema.decodeUnknownEffect(ReviewThreadResult)(result)
        if (registration.manifest.session.mode === "none") expect(result.sessionId).toBeNull()
        if (registration.manifest.session.mode === "resume" && request.sessionId !== null) {
          expect(result.sessionId).not.toBeNull()
        }
        expect(
          isScopedMcpToolSubset(request.mcp.allowedTools, request.policy.allowedMcpTools),
        ).toBe(true)
        for (const value of usageValues(result)) {
          if (value !== null) expect(value).toBeGreaterThanOrEqual(0)
        }
      }),
    )

    it.effect("rejects scoped MCP tools outside the execution policy", () =>
      Effect.gen(function* () {
        const capability = requireReview(fixtures.create())
        const request = fixtures.request()
        const outOfPolicyTool = McpToolName.make("diffdashConformanceOutOfPolicyTool")
        const result = yield* capability
          .execute({
            ...request,
            mcp: {
              ...request.mcp,
              allowedTools: [...request.mcp.allowedTools, outOfPolicyTool],
            },
          })
          .pipe(Effect.result)

        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(AgentProviderOperationError)
          expect(result.failure.reason).toContain("outside the execution policy")
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
        expect(isScopedMcpToolSubset(fixtures.observedTools(), fixtures.allowedTools)).toBe(true)
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
        const fiber = yield* Effect.forkChild(execution.run)
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
        expect(yield* execution.cleanedUp).toBe(true)
      }),
    )

    it.effect("cleans up resources after timeout", () =>
      Effect.gen(function* () {
        const execution = fixtures.createRun()
        const fiber = yield* execution.run.pipe(Effect.timeout("1 millis"), Effect.forkChild)
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
          .pipe(Effect.result)
        const unsupported = yield* registry
          .resolveWalkthrough(providerRoute(fixtures.unsupportedWalkthroughProviderId))
          .pipe(Effect.result)
        expect(Result.isFailure(missing)).toBe(true)
        expect(Result.isFailure(unsupported)).toBe(true)
        if (Result.isFailure(missing))
          expect(missing.failure).toBeInstanceOf(MissingAgentProviderError)
        if (Result.isFailure(unsupported)) {
          expect(unsupported.failure).toBeInstanceOf(UnsupportedAgentCapabilityError)
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
          Effect.result,
        )
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result))
          expect(result.failure).toBeInstanceOf(DuplicateAgentProviderError)
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
  expect(isNonMutatingAgentExecutionPolicy(policy)).toBe(true)
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
