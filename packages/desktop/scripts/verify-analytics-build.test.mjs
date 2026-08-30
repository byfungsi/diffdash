import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { verifyEmbeddedDesktopAnalytics } from "./verify-analytics-build.mjs"

const withBundle = (source, run) => {
  const directory = mkdtempSync(path.join(tmpdir(), "diffdash-analytics-build-test-"))
  const bundlePath = path.join(directory, "index.js")
  writeFileSync(bundlePath, source)
  try {
    run(bundlePath)
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
}

test("accepts a desktop bundle containing its configured analytics values", () => {
  const environment = {
    VITE_POSTHOG_HOST: "https://analytics.example.test",
    VITE_POSTHOG_KEY: "public-project-key",
  }

  withBundle(
    `const host = ${JSON.stringify(environment.VITE_POSTHOG_HOST)}; const key = ${JSON.stringify(environment.VITE_POSTHOG_KEY)}`,
    (bundlePath) => assert.equal(verifyEmbeddedDesktopAnalytics(bundlePath, environment), true),
  )
})

test("rejects a configured desktop bundle missing its analytics values", () => {
  const environment = {
    VITE_POSTHOG_HOST: "https://analytics.example.test",
    VITE_POSTHOG_KEY: "public-project-key",
  }

  withBundle("const analytics = null", (bundlePath) => {
    assert.throws(
      () => verifyEmbeddedDesktopAnalytics(bundlePath, environment),
      /Desktop analytics build verification failed/u,
    )
  })
})

test("keeps unconfigured development builds as analytics no-ops", () => {
  assert.equal(verifyEmbeddedDesktopAnalytics("missing-development-bundle.js", {}), false)
})
