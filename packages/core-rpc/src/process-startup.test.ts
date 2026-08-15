import { ApplicationInstanceId, CoreProcessEpoch } from "./identity"
import {
  CoreProcessStartupConfiguration,
  decodeCoreProcessStartupConfiguration,
  encodeCoreProcessStartupConfiguration,
} from "./process-startup"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"

describe("Core process startup configuration", () => {
  it.effect("round-trips branded identities while redacting the transport token", () =>
    Effect.gen(function* () {
      const token = "private-process-token-with-at-least-32-bytes"
      const configuration = CoreProcessStartupConfiguration.make({
        schemaVersion: 1,
        applicationInstanceId: ApplicationInstanceId.make("app-process-startup"),
        processEpoch: CoreProcessEpoch.make("epoch-process-startup"),
        socketPath: "/tmp/dd-core/core.sock",
        databasePath: "/tmp/dd-core/diffdash.sqlite",
        statePath: "/tmp/dd-core/state.json",
        token: Redacted.make(token),
      })

      const encoded = yield* encodeCoreProcessStartupConfiguration(configuration)
      const decoded = yield* decodeCoreProcessStartupConfiguration(encoded)

      expect(decoded.applicationInstanceId).toBe(configuration.applicationInstanceId)
      expect(decoded.processEpoch).toBe(configuration.processEpoch)
      expect(Redacted.value(decoded.token)).toBe(token)
      expect(JSON.stringify(decoded.token)).not.toContain(token)
    }),
  )

  it.effect("rejects short credentials", () =>
    decodeCoreProcessStartupConfiguration(
      JSON.stringify({
        schemaVersion: 1,
        applicationInstanceId: "app-process-startup",
        processEpoch: "epoch-process-startup",
        socketPath: "/tmp/dd-core/core.sock",
        databasePath: "/tmp/dd-core/diffdash.sqlite",
        statePath: "/tmp/dd-core/state.json",
        token: "short",
      }),
    ).pipe(
      Effect.flip,
      Effect.map((failure) => expect(failure).toBeDefined()),
    ),
  )
})
