import { readFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

/** Verifies that a configured desktop build contains its public PostHog configuration. */
export const verifyEmbeddedDesktopAnalytics = (bundlePath, environment = process.env) => {
  const host = environment.VITE_POSTHOG_HOST?.trim()
  const projectKey = environment.VITE_POSTHOG_KEY?.trim()
  if (!host || !projectKey) return false

  const bundle = readFileSync(bundlePath, "utf8")
  if (!bundle.includes(host) || !bundle.includes(projectKey)) {
    throw new Error(
      "Desktop analytics build verification failed: configured PostHog values were not embedded.",
    )
  }
  return true
}

const invokedPath = process.argv[1]
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  verifyEmbeddedDesktopAnalytics(path.resolve("out/main/index.js"))
}
