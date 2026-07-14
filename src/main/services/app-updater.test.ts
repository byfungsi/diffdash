import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { AppUpdater, type AppUpdaterOptions, type NativeUpdaterAdapter } from "./app-updater"

const baseOptions = (adapter: NativeUpdaterAdapter): AppUpdaterOptions => ({
  adapter,
  arch: "arm64",
  currentVersion: "0.1.4",
  feedBaseUrl: "https://updates.example.test/stable",
  packaged: true,
  platform: "darwin",
})

describe("AppUpdater", () => {
  it.scoped("selects the macOS architecture feed and waits for download approval", () => {
    const fake = makeFakeUpdater()

    return Effect.gen(function* () {
      const updater = yield* AppUpdater
      expect(fake.feedUrls).toEqual(["https://updates.example.test/stable/macos/arm64"])

      yield* updater.check
      expect(fake.checkCount).toBe(1)
      expect(fake.downloadCount).toBe(0)

      fake.emitAvailable("0.1.5")
      expect(yield* updater.state).toMatchObject({ _tag: "available", version: "0.1.5" })

      yield* updater.download
      expect(fake.downloadCount).toBe(1)
      expect(yield* updater.state).toMatchObject({
        _tag: "downloading",
        percent: 0,
        version: "0.1.5",
      })

      fake.emitProgress(62.5)
      expect(yield* updater.state).toMatchObject({ _tag: "downloading", percent: 62.5 })
      fake.emitDownloaded("0.1.5")
      expect(yield* updater.state).toMatchObject({ _tag: "downloaded", version: "0.1.5" })

      yield* updater.quitAndInstall
      expect(fake.installCount).toBe(1)
    }).pipe(Effect.provide(AppUpdater.layer(baseOptions(fake.adapter))))
  })

  it.scoped("selects the Linux x64 feed only for a real AppImage", () => {
    const fake = makeFakeUpdater()

    return Effect.gen(function* () {
      yield* AppUpdater
      expect(fake.feedUrls).toEqual(["https://updates.example.test/stable/linux/x64"])
    }).pipe(
      Effect.provide(
        AppUpdater.layer({
          ...baseOptions(fake.adapter),
          appImagePath: "/home/user/DiffDash.AppImage",
          arch: "x64",
          platform: "linux",
        }),
      ),
    )
  })

  it.scoped("marks deb and development installations as unsupported", () => {
    const fake = makeFakeUpdater()

    return Effect.gen(function* () {
      const updater = yield* AppUpdater
      expect(yield* updater.state).toMatchObject({ _tag: "unsupported", reason: "installation" })
      expect(fake.feedUrls).toEqual([])
    }).pipe(
      Effect.provide(
        AppUpdater.layer({
          ...baseOptions(fake.adapter),
          arch: "x64",
          platform: "linux",
        }),
      ),
    )
  })

  it.scoped("retains failures and notifies subscribers", () => {
    const fake = makeFakeUpdater({ checkError: new Error("feed unavailable") })
    const states: string[] = []

    return Effect.gen(function* () {
      const updater = yield* AppUpdater
      yield* updater.subscribe((state) => states.push(state["_tag"]))
      yield* Effect.either(updater.check)

      expect(yield* updater.state).toMatchObject({
        _tag: "error",
        message: "feed unavailable",
      })
      expect(states).toContain("error")
    }).pipe(Effect.provide(AppUpdater.layer(baseOptions(fake.adapter))))
  })
})

const makeFakeUpdater = (options: { readonly checkError?: Error } = {}) => {
  const checking = new Set<() => void>()
  const available = new Set<(info: { readonly version: string }) => void>()
  const notAvailable = new Set<() => void>()
  const progress = new Set<(info: { readonly percent: number }) => void>()
  const downloaded = new Set<(info: { readonly version: string }) => void>()
  const errors = new Set<(error: Error) => void>()
  const feedUrls: string[] = []
  let checkCount = 0
  let downloadCount = 0
  let installCount = 0

  const adapter: NativeUpdaterAdapter = {
    configure: (feedUrl) => feedUrls.push(feedUrl),
    check: async () => {
      checkCount += 1
      for (const listener of checking) listener()
      if (options.checkError !== undefined) throw options.checkError
    },
    download: async () => {
      downloadCount += 1
      return ["/tmp/update"]
    },
    quitAndInstall: () => {
      installCount += 1
    },
    onChecking: (listener) => subscribe(checking, listener),
    onAvailable: (listener) => subscribe(available, listener),
    onNotAvailable: (listener) => subscribe(notAvailable, listener),
    onProgress: (listener) => subscribe(progress, listener),
    onDownloaded: (listener) => subscribe(downloaded, listener),
    onError: (listener) => subscribe(errors, listener),
  }

  return {
    adapter,
    feedUrls,
    get checkCount() {
      return checkCount
    },
    get downloadCount() {
      return downloadCount
    },
    get installCount() {
      return installCount
    },
    emitAvailable: (version: string) => {
      for (const listener of available) listener({ version })
    },
    emitProgress: (percent: number) => {
      for (const listener of progress) listener({ percent })
    },
    emitDownloaded: (version: string) => {
      for (const listener of downloaded) listener({ version })
    },
  }
}

const subscribe = <A>(listeners: Set<A>, listener: A) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
