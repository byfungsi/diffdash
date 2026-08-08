import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { Context, Effect, Layer, Match, Schema } from "effect"
import { PostHog } from "posthog-node"

import type { AnalyticsEvent } from "@diffdash/protocol/analytics"
import { AppSettings } from "@diffdash/settings/app-settings"
import { FileStorage, type FileStorageOperations } from "@diffdash/settings/file-storage"
import type { CoreAnalyticsState } from "../analytics-state"

const AnalyticsState = Schema.Struct({
  distinctId: Schema.String,
  installedAt: Schema.String,
  installReported: Schema.Boolean,
})
type AnalyticsState = typeof AnalyticsState.Type
const AnalyticsStateFromJson = Schema.fromJsonString(AnalyticsState)

interface AnalyticsClient {
  readonly capture: (message: {
    readonly distinctId: string
    readonly event: string
    readonly properties: Record<string, boolean | number | string>
    readonly disableGeoip: boolean
  }) => void
  readonly disable: () => Promise<void>
  readonly enable: () => Promise<void>
  readonly flush: () => Promise<void>
}

/** Main-process service for anonymous, privacy-reviewed product analytics. */
export class Analytics extends Context.Service<
  Analytics,
  {
    readonly capture: (event: AnalyticsEvent) => Effect.Effect<void>
    readonly start: Effect.Effect<void>
  }
>()("@diffdash/Analytics") {
  /** Creates the analytics service from host-decoded runtime configuration. */
  static makeLayer(options: {
    readonly appVersion: string
    readonly architecture: string
    readonly packaged: boolean
    readonly platform: string
    readonly analytics: CoreAnalyticsState
    readonly settingsPath: string
    readonly clientFactory?: (key: string, host: string) => AnalyticsClient
  }): Layer.Layer<Analytics, never, AppSettings | FileStorage> {
    return Layer.effect(
      Analytics,
      Effect.gen(function* () {
        const settings = yield* AppSettings
        const storage = yield* FileStorage
        const statePath = join(dirname(options.settingsPath), "analytics.json")
        let state = yield* readAnalyticsState(storage, statePath)
        let started = false
        const client = !options.packaged
          ? null
          : Match.valueTags(options.analytics, {
              disabled: () => null,
              enabled: ({ projectKey, host }) =>
                (options.clientFactory ?? makePostHogClient)(projectKey, host),
            })

        if (client !== null) {
          yield* Effect.addFinalizer(() => ignorePromise(() => client.flush()))
        }

        const send = (event: AnalyticsEvent | { readonly event: "app_installed" | "app_opened" }) =>
          Effect.gen(function* () {
            if (client === null) return
            const currentSettings = yield* settings.get.pipe(
              Effect.catch(() => Effect.succeed(null)),
            )
            if (currentSettings?.telemetryEnabled !== true) {
              yield* ignorePromise(() => client.disable())
              return
            }

            yield* ignorePromise(() => client.enable())
            yield* Effect.try({
              try: () =>
                client.capture({
                  distinctId: state.distinctId,
                  event: event.event,
                  disableGeoip: true,
                  properties: {
                    ...eventProperties(event),
                    app_version: options.appVersion,
                    architecture: options.architecture,
                    packaged: options.packaged,
                    platform: options.platform,
                    $process_person_profile: false,
                  },
                }),
              catch: () => undefined,
            }).pipe(Effect.ignore)
          })

        const start = Effect.gen(function* () {
          if (started) return
          const currentSettings = yield* settings.get.pipe(Effect.catch(() => Effect.succeed(null)))
          if (currentSettings?.telemetryEnabled !== true) return
          started = true

          if (!state.installReported && client !== null) {
            yield* send({ event: "app_installed" })
            state = { ...state, installReported: true }
            yield* writeAnalyticsState(storage, statePath, state)
          }
          yield* send({ event: "app_opened" })
        })

        return Analytics.of({
          capture: Effect.fn("Analytics.capture")(function* (event) {
            if (!started) return
            yield* send(event)
          }),
          start,
        })
      }),
    )
  }
}

const makePostHogClient = (key: string, host: string): AnalyticsClient =>
  new PostHog(key, {
    host,
    enableExceptionAutocapture: false,
    flushAt: 10,
    flushInterval: 10_000,
    isServer: false,
    privacyMode: true,
  })

const newAnalyticsState = (): AnalyticsState => ({
  distinctId: randomUUID(),
  installedAt: new Date().toISOString(),
  installReported: false,
})

const readAnalyticsState = (storage: FileStorageOperations, path: string) =>
  storage.readOptionalTextFile(path).pipe(
    Effect.flatMap((source) =>
      source === null
        ? Effect.succeed(newAnalyticsState())
        : Schema.decodeUnknownEffect(AnalyticsStateFromJson)(source),
    ),
    Effect.catch(() => Effect.succeed(newAnalyticsState())),
  )

const writeAnalyticsState = (storage: FileStorageOperations, path: string, state: AnalyticsState) =>
  storage.writePrettyJsonFile(path, state).pipe(Effect.catch(() => Effect.void))

const eventProperties = (
  event: AnalyticsEvent | { readonly event: "app_installed" | "app_opened" },
): Record<string, boolean | string> => {
  const { event: _event, ...properties } = event
  return properties
}

const ignorePromise = (run: () => Promise<void>) =>
  Effect.tryPromise({ try: run, catch: () => undefined }).pipe(Effect.ignore)
