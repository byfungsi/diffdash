import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const leaseModule = fileURLToPath(new URL("./desktop-build-lease.mjs", import.meta.url))

test("complete Desktop workflows cannot interleave their shared build artifacts", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "diffdash-e2e-build-lease-"))
  const leasePath = resolve(directory, "build.lease")
  const eventsPath = resolve(directory, "events.log")
  try {
    const first = worker("first", 300, leasePath, eventsPath)
    await waitForEvent(eventsPath, "first")
    const second = worker("second", 0, leasePath, eventsPath)
    await Promise.all([first, second])

    const events = (await readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => {
        const [label, timestamp] = line.split(":")
        return { label, timestamp: Number(timestamp) }
      })
    assert.deepEqual(
      events.map(({ label }) => label),
      ["first", "second"],
    )
    assert.ok(events[1].timestamp - events[0].timestamp >= 250)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

const worker = (label, holdMilliseconds, leasePath, eventsPath) =>
  new Promise((resolvePromise, reject) => {
    const source = `
      import { appendFile } from "node:fs/promises"
      import { withDesktopBuildLease } from ${JSON.stringify(leaseModule)}
      await withDesktopBuildLease(async () => {
        await appendFile(${JSON.stringify(eventsPath)}, ${JSON.stringify(`${label}:`)} + Date.now() + "\\n")
        await new Promise((resolve) => setTimeout(resolve, ${holdMilliseconds}))
      })
    `
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      env: { ...process.env, DIFFDASH_E2E_BUILD_LEASE_PATH: leasePath },
      stdio: "inherit",
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`Lease worker exited with ${signal ?? code}`))
    })
  })

const waitForEvent = async (eventsPath, label) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const contents = await readFile(eventsPath, "utf8").catch(() => "")
    if (contents.includes(`${label}:`)) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }
  throw new Error(`Timed out waiting for ${label} to acquire the lease.`)
}
