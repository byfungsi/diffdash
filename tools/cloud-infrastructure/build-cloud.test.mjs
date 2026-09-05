import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url))
const outputDirectory = join(repositoryRoot, "packages/cloud/dist")
const privateBuildValue = "diffdash-private-build-test-value"

test("Cloud builds both environments without exposing deployment credentials", async () => {
  // Invoke from the repository root to exercise path handling outside the tooling directory.
  execFileSync(process.execPath, [fileURLToPath(new URL("./build-cloud.mjs", import.meta.url))], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CLOUDFLARE_API_KEY: privateBuildValue,
      GITHUB_APP_PRIVATE_KEY: privateBuildValue,
      GITHUB_OAUTH_CLIENT_SECRET: privateBuildValue,
    },
    stdio: "pipe",
    timeout: 60_000,
  })

  const html = readFileSync(join(outputDirectory, "client/index.html"), "utf8")
  assert.match(html, /<div id="root"><\/div>/)
  assert.match(html, /assets\/index-[^" ]+\.js/)
  for (const file of outputFiles(outputDirectory)) {
    assert.equal(readFileSync(file).includes(Buffer.from(privateBuildValue)), false, file)
  }

  const { default: worker } = await import(
    pathToFileURL(join(outputDirectory, "ssr/index.js")).href
  )
  const redirect = await worker.fetch(new Request("http://diffshub.com/reviews?tab=files"), {})
  assert.equal(redirect.status, 301)
  assert.equal(redirect.headers.get("location"), "https://diffshub.com/reviews?tab=files")

  const response = await worker.fetch(new Request("https://diffshub.com/reviews"), {
    ASSETS: { fetch: async () => new Response(html, { headers: { "content-type": "text/html" } }) },
  })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), html)
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/)
  assert.equal(response.headers.get("x-content-type-options"), "nosniff")
  assert.equal(response.headers.get("referrer-policy"), "no-referrer")
})

function outputFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? outputFiles(path) : [path]
  })
}
