import { Cause, Effect } from "effect"
import { randomUUID } from "node:crypto"
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"

import { isNodeError } from "./node-errors"

const NO_FAILURE = Symbol("NO_FAILURE")

/** Reads an optional UTF-8 file, treating only a missing path as absent. */
export const readOptionalTextFile = (
  path: string,
): Effect.Effect<string | null, Cause.UnknownException> =>
  Effect.try(() => {
    try {
      return readFileSync(path, "utf8")
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") return null
      throw cause
    }
  })

/** Atomically replaces a file with private, fsynced, pretty-printed JSON. */
export const writePrettyJsonFile = (
  path: string,
  value: unknown,
): Effect.Effect<void, Cause.UnknownException> =>
  Effect.try(() => {
    const content = `${JSON.stringify(value, null, 2)}\n`
    const directory = dirname(path)
    const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`)
    let descriptor: number | null = null
    let temporaryFileExists = false
    let failure: unknown | typeof NO_FAILURE = NO_FAILURE

    mkdirSync(directory, { recursive: true, mode: 0o700 })

    try {
      descriptor = openSync(temporaryPath, "wx", 0o600)
      temporaryFileExists = true
      writeFileSync(descriptor, content, "utf8")
      fsyncSync(descriptor)

      const descriptorToClose = descriptor
      descriptor = null
      closeSync(descriptorToClose)

      renameSync(temporaryPath, path)
      temporaryFileExists = false
    } catch (cause) {
      failure = cause
    }

    const cleanupFailures: unknown[] = []
    if (descriptor !== null) {
      const descriptorToClose = descriptor
      descriptor = null
      try {
        closeSync(descriptorToClose)
      } catch (cause) {
        cleanupFailures.push(cause)
      }
    }
    if (temporaryFileExists) {
      try {
        unlinkSync(temporaryPath)
      } catch (cause) {
        if (!isNodeError(cause) || cause.code !== "ENOENT") cleanupFailures.push(cause)
      }
    }

    if (failure !== NO_FAILURE) {
      if (cleanupFailures.length > 0) {
        throw new AggregateError([failure, ...cleanupFailures], "Atomic JSON write cleanup failed")
      }
      throw failure
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, "Atomic JSON write cleanup failed")
    }
  })
