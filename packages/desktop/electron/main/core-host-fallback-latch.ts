import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import { Effect, Schema } from "effect"

import { CoreHostCandidateError, type CoreHostFallbackLatch } from "./core-host-selection"

const FallbackLatchRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  fallbackAllowed: Schema.Literal(false),
})

const fallbackDisabled = JSON.stringify({ schemaVersion: 1, fallbackAllowed: false })

const latchFailure = () =>
  CoreHostCandidateError.make({
    reason: "latch-failed",
    qualificationCapability: null,
    safeMessage: "DiffDash could not prepare a Core host candidate.",
  })

/** Creates a fail-closed durable latch that can transition from allowed to disabled only once. */
export const makeCoreHostFallbackLatch = (path: string): CoreHostFallbackLatch => ({
  fallbackAllowed: Effect.try({
    try: () => {
      if (!existsSync(path)) return true
      Schema.decodeUnknownSync(FallbackLatchRecord)(JSON.parse(readFileSync(path, "utf8")))
      return false
    },
    catch: latchFailure,
  }).pipe(Effect.catch(() => Effect.succeed(false))),
  disableBeforeOwnershipAuthorization: Effect.try({
    try: () => {
      if (existsSync(path)) {
        Schema.decodeUnknownSync(FallbackLatchRecord)(JSON.parse(readFileSync(path, "utf8")))
        return
      }
      const temporaryPath = `${path}.${randomUUID()}.tmp`
      try {
        writeFileSync(temporaryPath, fallbackDisabled, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        })
        syncFile(temporaryPath)
        renameSync(temporaryPath, path)
        syncDirectory(dirname(path))
      } finally {
        rmSync(temporaryPath, { force: true })
      }
    },
    catch: latchFailure,
  }),
})

const syncFile = (path: string): void => {
  const descriptor = openSync(path, "r")
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

const syncDirectory = (path: string): void => {
  if (process.platform === "win32") return
  const descriptor = openSync(path, "r")
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}
