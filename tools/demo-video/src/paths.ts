/* eslint-disable no-await-in-loop -- File promotion and rollback must preserve transaction order. */
import { access, rename, rm } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"

const DEMO_SLUG = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u

/** Validates a filesystem-safe, URL-safe demo identifier. */
export const assertDemoSlug = (value: string, label: string): string => {
  if (!DEMO_SLUG.test(value)) {
    throw new Error(
      `${label} must contain lowercase letters, digits, dots, and single hyphens only`,
    )
  }
  return value
}

/** Resolves a path and rejects any value that escapes its declared root. */
export const resolveContainedPath = (root: string, ...segments: readonly string[]): string => {
  const resolvedRoot = resolve(root)
  const candidate = resolve(resolvedRoot, ...segments)
  const relativePath = relative(resolvedRoot, candidate)
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Resolved path escapes demo output root: ${candidate}`)
  }
  return candidate
}

/** Replaces a set of generated files as one rollback-capable promotion. */
export const replaceGeneratedFiles = async (
  entries: readonly { readonly source: string; readonly destination: string }[],
  backupDirectory: string,
) => {
  const backups: { readonly destination: string; readonly backup: string }[] = []
  const promoted: string[] = []
  try {
    for (const [index, entry] of entries.entries()) {
      const exists = await access(entry.destination).then(
        () => true,
        () => false,
      )
      if (!exists) continue
      const backup = resolveContainedPath(backupDirectory, `.previous-${index}`)
      await rename(entry.destination, backup)
      backups.push({ destination: entry.destination, backup })
    }
    for (const entry of entries) {
      await rename(entry.source, entry.destination)
      promoted.push(entry.destination)
    }
  } catch (cause) {
    await Promise.all(promoted.map((path) => rm(path, { force: true })))
    for (const { destination, backup } of backups.toReversed()) {
      await rename(backup, destination).catch(() => undefined)
    }
    throw cause
  }
  await Promise.all(backups.map(({ backup }) => rm(backup, { force: true })))
}
