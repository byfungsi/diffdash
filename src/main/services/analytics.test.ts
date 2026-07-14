import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AISettings, DEFAULT_AI_SETTINGS } from "../../shared/ai-settings"
import { Analytics } from "./analytics"
import { AppConfig } from "./app-config"
import { AppSettings } from "./app-settings"

const makeTempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-analytics-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

type CapturedEvent = {
  readonly distinctId: string
  readonly event: string
  readonly properties: Record<string, boolean | number | string>
  readonly disableGeoip: boolean
}

const makeLayer = (directory: string, events: CapturedEvent[]) => {
  const configLayer = AppConfig.layer({
    appVersion: "1.2.3",
    architecture: "arm64",
    databasePath: join(directory, "test.sqlite"),
    packaged: true,
    platform: "darwin",
    posthogHost: "https://us.i.posthog.com",
    posthogKey: "phc_test",
    settingsPath: join(directory, "diffdash", "settings.json"),
    tempDir: directory,
  })
  const settingsLayer = AppSettings.layer.pipe(Layer.provide(configLayer))
  return Analytics.makeLayer({
    clientFactory: () => ({
      capture: (event) => events.push(event),
      disable: async () => undefined,
      enable: async () => undefined,
      flush: async () => undefined,
    }),
  }).pipe(Layer.provideMerge(settingsLayer), Layer.provide(configLayer))
}

describe("Analytics", () => {
  it.scoped("reports install once and uses a stable anonymous ID", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const events: CapturedEvent[] = []

      yield* Effect.gen(function* () {
        const analytics = yield* Analytics
        yield* analytics.start
        yield* analytics.start
        yield* analytics.capture({ event: "repository_bookmarked" })
      }).pipe(Effect.provide(makeLayer(directory, events)))

      expect(events.map(({ event }) => event)).toEqual([
        "app_installed",
        "app_opened",
        "repository_bookmarked",
      ])
      expect(new Set(events.map(({ distinctId }) => distinctId))).toHaveLength(1)
      expect(events[0]?.disableGeoip).toBe(true)
      expect(events[0]?.properties).toMatchObject({
        $process_person_profile: false,
        app_version: "1.2.3",
        architecture: "arm64",
        packaged: true,
        platform: "darwin",
      })
      expect(
        JSON.parse(readFileSync(join(directory, "diffdash", "analytics.json"), "utf8")),
      ).toMatchObject({
        distinctId: events[0]?.distinctId,
        installReported: true,
      })
    }),
  )

  it.scoped("sends nothing after a persisted opt-out", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const events: CapturedEvent[] = []

      yield* Effect.gen(function* () {
        const settings = yield* AppSettings
        yield* settings.save(AISettings.make({ ...DEFAULT_AI_SETTINGS, telemetryEnabled: false }))
        const analytics = yield* Analytics
        yield* analytics.start
        yield* analytics.capture({ event: "repository_bookmarked" })
      }).pipe(Effect.provide(makeLayer(directory, events)))

      expect(events).toEqual([])
    }),
  )
})
