import { mkdtempSync, rmSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"

/** Runs synchronous work in a fresh directory and removes it on every exit path. */
export const withTemporaryDirectorySync = (prefix, operation) => {
  const directory = mkdtempSync(prefix)
  try {
    return operation(directory)
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
}

/** Runs asynchronous work in a fresh directory and removes it on every settled exit path. */
export const withTemporaryDirectory = async (prefix, operation) => {
  const directory = await mkdtemp(prefix)
  try {
    return await operation(directory)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}
