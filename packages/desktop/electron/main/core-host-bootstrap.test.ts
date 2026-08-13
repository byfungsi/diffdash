import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { ApplicationInstanceId, CoreProcessEpoch, HostRequestId } from "@diffdash/core-rpc/identity"
import { CoreHealth } from "@diffdash/core-rpc/lifecycle"
import { TempResources } from "@diffdash/process/temp-resource"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Redacted, Ref } from "effect"
import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  bootstrapCoreHost,
  CoreHostBootstrap,
  CoreHostBootstrapError,
  coreHostBootstrapLayer,
  type CoreHostBootstrapState,
} from "./core-host-bootstrap"
import { CoreRpcClient, CoreRpcHealthVerificationError } from "./core-rpc-client"

const applicationInstanceId = ApplicationInstanceId.make("app-bootstrap")
const processEpoch = CoreProcessEpoch.make("epoch-bootstrap")
const requestId = HostRequestId.make("h:bootstrap-health")
const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const bootstrapDependencies = Layer.merge(
  TempResources.layer.pipe(Layer.provide(platformLayer)),
  NodePath.layer,
)

const options = {
  applicationInstanceId,
  generateProcessEpoch: () => processEpoch,
  generateRequestId: () => requestId,
  generateToken: () => Redacted.make("bootstrap-token-with-at-least-32-bytes"),
} as const

describe("Core host bootstrap", () => {
  it.effect("creates, authenticates, and verifies one scoped private transport", () =>
    Effect.gen(function* () {
      const temporaryDirectory = mkdtempSync(join(tmpdir(), "dd-bootstrap-parent-"))
      const states = yield* Ref.make<ReadonlyArray<CoreHostBootstrapState>>([])
      const observedConfiguration = yield* Ref.make<{
        readonly socketPath: string
        readonly token: Redacted.Redacted
      } | null>(null)
      const session = yield* bootstrapCoreHost({
        ...options,
        temporaryDirectory,
        onStateChange: (state) => Ref.update(states, (current) => [...current, state]),
        startTransport: (configuration) =>
          Ref.set(observedConfiguration, {
            socketPath: configuration.socketPath,
            token: configuration.token,
          }),
        makeClientLayer: () =>
          Layer.succeed(
            CoreRpcClient,
            CoreRpcClient.of({
              health: (request) =>
                Effect.succeed(
                  CoreHealth.make({
                    applicationInstanceId: request.applicationInstanceId,
                    processEpoch: request.processEpoch,
                    lifecycle: "awaitingOwnership",
                  }),
                ),
            }),
          ),
      })

      expect(session.health.lifecycle).toBe("awaitingOwnership")
      expect(yield* session.state).toBe("awaitingOwnership")
      expect(yield* Ref.get(states)).toEqual([
        "preparingRuntime",
        "transportListening",
        "authenticating",
        "epochVerified",
        "awaitingOwnership",
      ])
      const configuration = yield* Ref.get(observedConfiguration)
      expect(configuration).not.toBeNull()
      if (configuration === null) return
      expect(existsSync(join(temporaryDirectory, readdirSync(temporaryDirectory)[0] ?? ""))).toBe(
        true,
      )
      expect(configuration.socketPath).toContain("core.sock")
      expect(statSync(dirname(configuration.socketPath)).mode & 0o777).toBe(0o700)
      expect(JSON.stringify(session)).not.toContain(configuration.socketPath)
      expect(JSON.stringify(session)).not.toContain(Redacted.value(configuration.token))
    }).pipe(Effect.provide(bootstrapDependencies)),
  )

  it.effect("closes private runtime resources immediately when epoch verification fails", () =>
    Effect.gen(function* () {
      const temporaryDirectory = mkdtempSync(join(tmpdir(), "dd-bootstrap-parent-"))
      const states = yield* Ref.make<ReadonlyArray<CoreHostBootstrapState>>([])
      const transportClosed = yield* Ref.make(false)
      const failure = yield* bootstrapCoreHost({
        ...options,
        temporaryDirectory,
        onStateChange: (state) => Ref.update(states, (current) => [...current, state]),
        startTransport: () => Effect.addFinalizer(() => Ref.set(transportClosed, true)),
        makeClientLayer: () =>
          Layer.succeed(
            CoreRpcClient,
            CoreRpcClient.of({
              health: () =>
                CoreRpcHealthVerificationError.make({
                  expectedApplicationInstanceId: applicationInstanceId,
                  expectedProcessEpoch: processEpoch,
                  actualApplicationInstanceId: applicationInstanceId,
                  actualProcessEpoch: "epoch-stale",
                }),
            }),
          ),
      }).pipe(Effect.flip)

      expect(failure).toEqual(
        CoreHostBootstrapError.make({
          stage: "authenticating",
          safeMessage: "DiffDash could not establish its private Core connection.",
        }),
      )
      expect(yield* Ref.get(states)).toEqual([
        "preparingRuntime",
        "transportListening",
        "authenticating",
        "failed",
      ])
      expect(readdirSync(temporaryDirectory)).toEqual([])
      expect(yield* Ref.get(transportClosed)).toBe(true)
      expect(JSON.stringify(failure)).not.toContain("epoch-stale")
    }).pipe(Effect.provide(bootstrapDependencies)),
  )

  it.effect("rejects an identity-matching Core outside awaiting ownership", () =>
    Effect.gen(function* () {
      const temporaryDirectory = mkdtempSync(join(tmpdir(), "dd-bootstrap-parent-"))
      const failure = yield* bootstrapCoreHost({
        ...options,
        temporaryDirectory,
        startTransport: () => Effect.void,
        makeClientLayer: () =>
          Layer.succeed(
            CoreRpcClient,
            CoreRpcClient.of({
              health: () =>
                Effect.succeed(
                  CoreHealth.make({
                    applicationInstanceId,
                    processEpoch,
                    lifecycle: "failed",
                  }),
                ),
            }),
          ),
      }).pipe(Effect.flip)

      expect(failure.stage).toBe("authenticating")
      expect(readdirSync(temporaryDirectory)).toEqual([])
    }).pipe(Effect.provide(bootstrapDependencies)),
  )

  it.effect("shares one transport across concurrent and repeated starts", () =>
    Effect.gen(function* () {
      const temporaryDirectory = mkdtempSync(join(tmpdir(), "dd-bootstrap-parent-"))
      const starts = yield* Ref.make(0)
      const layer = coreHostBootstrapLayer({
        ...options,
        temporaryDirectory,
        startTransport: () => Ref.update(starts, (count) => count + 1),
        makeClientLayer: () =>
          Layer.succeed(
            CoreRpcClient,
            CoreRpcClient.of({
              health: () =>
                Effect.succeed(
                  CoreHealth.make({
                    applicationInstanceId,
                    processEpoch,
                    lifecycle: "awaitingOwnership",
                  }),
                ),
            }),
          ),
      }).pipe(Layer.provide(bootstrapDependencies))

      return yield* Effect.gen(function* () {
        const bootstrap = yield* CoreHostBootstrap
        const sessions = yield* Effect.all([bootstrap.start, bootstrap.start], {
          concurrency: "unbounded",
        })
        const repeated = yield* bootstrap.start

        expect(yield* Ref.get(starts)).toBe(1)
        expect(sessions[0]).toBe(sessions[1])
        expect(repeated).toBe(sessions[0])
        expect(readdirSync(temporaryDirectory)).toHaveLength(1)
      }).pipe(Effect.provide(layer))
    }),
  )

  it.effect("does not launch Core until the first start request", () =>
    Effect.gen(function* () {
      const temporaryDirectory = mkdtempSync(join(tmpdir(), "dd-bootstrap-parent-"))
      const starts = yield* Ref.make(0)
      const layer = coreHostBootstrapLayer({
        ...options,
        temporaryDirectory,
        startTransport: () => Ref.update(starts, (count) => count + 1),
        makeClientLayer: () =>
          Layer.succeed(
            CoreRpcClient,
            CoreRpcClient.of({
              health: () =>
                Effect.succeed(
                  CoreHealth.make({
                    applicationInstanceId,
                    processEpoch,
                    lifecycle: "awaitingOwnership",
                  }),
                ),
            }),
          ),
      }).pipe(Layer.provide(bootstrapDependencies))

      return yield* Effect.gen(function* () {
        expect(yield* Ref.get(starts)).toBe(0)
        expect(readdirSync(temporaryDirectory)).toEqual([])
        const bootstrap = yield* CoreHostBootstrap
        expect(yield* Ref.get(starts)).toBe(0)
        yield* bootstrap.start
        expect(yield* Ref.get(starts)).toBe(1)
      }).pipe(Effect.provide(layer))
    }),
  )

  it.effect("caller interruption does not cancel or poison the shared bootstrap", () =>
    Effect.gen(function* () {
      const temporaryDirectory = mkdtempSync(join(tmpdir(), "dd-bootstrap-parent-"))
      const listening = yield* Deferred.make<void>()
      const continueStartup = yield* Deferred.make<void>()
      const starts = yield* Ref.make(0)
      const layer = coreHostBootstrapLayer({
        ...options,
        temporaryDirectory,
        startTransport: () =>
          Ref.update(starts, (count) => count + 1).pipe(
            Effect.andThen(Deferred.succeed(listening, undefined)),
            Effect.andThen(Deferred.await(continueStartup)),
          ),
        makeClientLayer: () =>
          Layer.succeed(
            CoreRpcClient,
            CoreRpcClient.of({
              health: () =>
                Effect.succeed(
                  CoreHealth.make({
                    applicationInstanceId,
                    processEpoch,
                    lifecycle: "awaitingOwnership",
                  }),
                ),
            }),
          ),
      }).pipe(Layer.provide(bootstrapDependencies))

      return yield* Effect.gen(function* () {
        const bootstrap = yield* CoreHostBootstrap
        const caller = yield* bootstrap.start.pipe(Effect.forkChild)
        yield* Deferred.await(listening)
        yield* Fiber.interrupt(caller)
        yield* Deferred.succeed(continueStartup, undefined)

        const session = yield* bootstrap.start
        expect(session.health.lifecycle).toBe("awaitingOwnership")
        expect(yield* Ref.get(starts)).toBe(1)
      }).pipe(Effect.provide(layer))
    }),
  )
})
