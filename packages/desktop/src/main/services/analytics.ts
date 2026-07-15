import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { PostHog } from "posthog-node"

import type { AnalyticsEvent } from "../../shared/analytics"
import { AppConfig } from "./app-config"
import { AppSettings } from "./app-settings"

const AnalyticsState = Schema.Struct({
  distinctId: Schema.String,
  installedAt: Schema.String,
  installReported: Schema.Boolean,
})
type AnalyticsState = typeof AnalyticsState.Type
const AnalyticsStateFromJson = Schema.parseJson(AnalyticsState)

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
export class Analytics extends Context.Tag("@diffdash/Analytics")<
  Analytics,
  {
    readonly capture: (event: AnalyticsEvent) => Effect.Effect<void>
    readonly start: Effect.Effect<void>
  }
>() {
  static readonly layer = Analytics.makeLayer()

  static makeLayer(options?: {
    readonly clientFactory?: (key: string, host: string) => AnalyticsClient
  }) {
    return Layer.scoped(
      Analytics,
      Effect.gen(function* () {
        const config = yield* AppConfig
        const settings = yield* AppSettings
        const statePath = join(dirname(config.settingsPath), "analytics.json")
        let state = readAnalyticsState(statePath)
        let started = false
        const client =
          !config.packaged || config.posthogKey.length === 0 || config.posthogHost.length === 0
            ? null
            : (options?.clientFactory ?? makePostHogClient)(config.posthogKey, config.posthogHost)

        if (client !== null) {
          yield* Effect.addFinalizer(() => ignorePromise(() => client.flush()))
        }

        const send = (event: AnalyticsEvent | { readonly event: "app_installed" | "app_opened" }) =>
          Effect.gen(function* () {
            if (client === null) return
            const currentSettings = yield* settings.get.pipe(
              Effect.catchAll(() => Effect.succeed(null)),
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
                    app_version: config.appVersion,
                    architecture: config.architecture,
                    packaged: config.packaged,
                    platform: config.platform,
                    $process_person_profile: false,
                  },
                }),
              catch: () => undefined,
            }).pipe(Effect.ignore)
          })

        const start = Effect.gen(function* () {
          if (started) return
          const currentSettings = yield* settings.get.pipe(
            Effect.catchAll(() => Effect.succeed(null)),
          )
          if (currentSettings?.telemetryEnabled !== true) return
          started = true

          if (!state.installReported && client !== null) {
            yield* send({ event: "app_installed" })
            state = { ...state, installReported: true }
            writeAnalyticsState(statePath, state)
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

const readAnalyticsState = (path: string): AnalyticsState => {
  try {
    return Schema.decodeUnknownSync(AnalyticsStateFromJson)(readFileSync(path, "utf8"))
  } catch {
    return {
      distinctId: randomUUID(),
      installedAt: new Date().toISOString(),
      installReported: false,
    }
  }
}

const writeAnalyticsState = (path: string, state: AnalyticsState) => {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  } catch {
    // Analytics must never prevent the application from running.
  }
}

const eventProperties = (
  event: AnalyticsEvent | { readonly event: "app_installed" | "app_opened" },
): Record<string, boolean | string> => {
  const { event: _event, ...properties } = event
  return properties
}

const ignorePromise = (run: () => Promise<void>) =>
  Effect.tryPromise({ try: run, catch: () => undefined }).pipe(Effect.ignore)
