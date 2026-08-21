import { spawn } from "node:child_process"
import { readlinkSync } from "node:fs"
import { join } from "node:path"
import { setTimeout } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const CLOSE_DEV_INSTANCE_ARGUMENT = "--diffdash-close-dev-instance"
const PROBE_RETRY_DELAY_MS = 100
const GRACEFUL_SHUTDOWN_MS = 1_000
const PROBE_TIMEOUT_MS = 5_000
const OWNER_PID_PREFIX = "DIFFDASH_DEV_OWNER_PID="
const scriptPath = fileURLToPath(import.meta.url)

if (process.versions.electron) {
  const { app } = await import("electron")
  const developmentName = "DiffDash Development"
  app.setName(developmentName)
  app.setAppUserModelId("dev.diffdash.app.development")
  const userDataPath = join(app.getPath("appData"), developmentName)
  app.setPath("userData", userDataPath)

  const acquired = app.requestSingleInstanceLock()
  if (acquired) app.releaseSingleInstanceLock()
  else {
    try {
      const owner = readlinkSync(join(userDataPath, "SingletonLock"))
      const ownerPid = owner.match(/-(\d+)$/u)?.[1]
      if (ownerPid !== undefined) console.info(`${OWNER_PID_PREFIX}${ownerPid}`)
    } catch {
      // Current development builds close through the single-instance event without a PID fallback.
    }
  }
  app.exit(acquired ? 0 : 2)
} else {
  const electronPath = (await import("electron")).default
  const runProbe = () =>
    new Promise((resolve, reject) => {
      const probe = spawn(electronPath, [scriptPath, CLOSE_DEV_INSTANCE_ARGUMENT], {
        stdio: ["ignore", "pipe", "inherit"],
      })
      let output = ""
      probe.stdout.setEncoding("utf8")
      probe.stdout.on("data", (chunk) => {
        output += chunk
      })
      probe.once("error", reject)
      probe.once("exit", (code, signal) => {
        if (signal !== null) {
          console.error(`DiffDash development restart probe exited from signal ${signal}`)
          resolve({ code: 1, ownerPid: null })
          return
        }
        const ownerPid = output.match(new RegExp(`${OWNER_PID_PREFIX}(\\d+)`, "u"))?.[1] ?? null
        resolve({ code, ownerPid })
      })
    })

  let result = await runProbe()
  if (result.code === 2) console.info("Closing the previous DiffDash development instance...")

  const gracefulDeadline = Date.now() + GRACEFUL_SHUTDOWN_MS
  while (result.code === 2 && Date.now() < gracefulDeadline) {
    await setTimeout(PROBE_RETRY_DELAY_MS)
    result = await runProbe()
  }

  if (result.code === 2 && result.ownerPid !== null && process.platform !== "win32") {
    const ownerPid = Number(result.ownerPid)
    const command = await new Promise((resolve) => {
      const inspect = spawn("ps", ["-p", String(ownerPid), "-o", "command="], {
        stdio: ["ignore", "pipe", "ignore"],
      })
      let output = ""
      inspect.stdout.setEncoding("utf8")
      inspect.stdout.on("data", (chunk) => {
        output += chunk
      })
      inspect.once("error", () => resolve(""))
      inspect.once("exit", () => resolve(output.trim()))
    })
    if (command.startsWith(electronPath)) process.kill(ownerPid, "SIGTERM")

    const deadline = Date.now() + PROBE_TIMEOUT_MS
    while (result.code === 2 && Date.now() < deadline) {
      await setTimeout(PROBE_RETRY_DELAY_MS)
      result = await runProbe()
    }
  }

  if (result.code !== 0) {
    console.error("The previous DiffDash development instance did not close within 5 seconds")
    process.exitCode = 1
  }
}
