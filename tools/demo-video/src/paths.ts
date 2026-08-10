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
