import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import "./load-local-env.mjs"

const args = process.argv.slice(2)
const appPathArg = args.find((arg) => !arg.startsWith("--"))

if (appPathArg === undefined) {
  throw new Error(
    "Usage: node scripts/release/notarize-app.mjs <path-to-app> [--submission-id ID] [--timeout-minutes N] [--poll-seconds N]",
  )
}

const timeoutMinutes = Number(
  readOption("--timeout-minutes") ?? process.env.NOTARIZATION_TIMEOUT_MINUTES ?? "240",
)
const pollSeconds = Number(
  readOption("--poll-seconds") ?? process.env.NOTARIZATION_POLL_SECONDS ?? "120",
)

if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
  throw new Error(`Invalid notarization timeout: ${timeoutMinutes}`)
}

if (!Number.isFinite(pollSeconds) || pollSeconds <= 0) {
  throw new Error(`Invalid notarization poll interval: ${pollSeconds}`)
}

const appPath = path.resolve(appPathArg)
const authArgs = [
  "--key",
  requiredEnv("APPLE_API_KEY"),
  "--key-id",
  requiredEnv("APPLE_API_KEY_ID"),
  "--issuer",
  requiredEnv("APPLE_API_ISSUER"),
]
const tempDir = mkdtempSync(path.join(tmpdir(), "diffdash-notarize-"))
const zipPath = path.join(tempDir, "DiffDash.zip")
let submissionId = readOption("--submission-id")

if (typeof submissionId !== "string" || submissionId.length === 0) {
  console.log(`Creating notarization archive for ${appPath}`)
  const zipResult = await run(
    "ditto",
    ["-c", "-k", "--sequesterRsrc", "--keepParent", path.basename(appPath), zipPath],
    { cwd: path.dirname(appPath), inherit: true, timeoutMs: 10 * 60_000 },
  )
  if (zipResult.code !== 0) failWithOutput("Failed to create notarization archive.", zipResult)

  console.log("Submitting app to Apple notarization service")
  const submitResult = await run(
    "xcrun",
    ["notarytool", "submit", zipPath, ...authArgs, "--output-format", "json"],
    { timeoutMs: 20 * 60_000 },
  )
  if (submitResult.code !== 0)
    failWithOutput("Failed to submit app for notarization.", submitResult)

  const submission = parseJson(submitResult.stdout, "notarytool submit")
  submissionId = submission.id
  if (typeof submissionId !== "string" || submissionId.length === 0) {
    failWithOutput("Notarization submission did not return an id.", submitResult)
  }
  console.log(`Notarization submitted: ${submissionId}`)
} else {
  console.log(`Resuming notarization submission: ${submissionId}`)
}

const deadline = Date.now() + timeoutMinutes * 60_000
const completed = await waitForNotarization(deadline)

if (!completed) {
  console.error(`Timed out waiting ${timeoutMinutes} minutes for notarization: ${submissionId}`)
  process.exit(1)
}

async function waitForNotarization(deadlineMs) {
  if (Date.now() >= deadlineMs) return false

  const infoResult = await run(
    "xcrun",
    ["notarytool", "info", submissionId, ...authArgs, "--output-format", "json"],
    { timeoutMs: 60_000 },
  )

  if (infoResult.code !== 0) {
    console.warn("Unable to read notarization status; retrying.")
    if (infoResult.timedOut) console.warn("notarytool info timed out.")
    if (infoResult.stderr) console.warn(infoResult.stderr)
    await sleep(pollSeconds * 1_000)
    return waitForNotarization(deadlineMs)
  }

  const info = parseJson(infoResult.stdout, "notarytool info")
  console.log(`Notarization status: ${info.status}`)

  if (info.status === "Accepted") {
    const stapled = await stapleTicket()
    if (stapled) return true

    console.error("Failed to staple accepted notarization ticket.")
    process.exit(1)
  }

  if (info.status === "Invalid" || info.status === "Rejected") {
    const logResult = await run("xcrun", ["notarytool", "log", submissionId, ...authArgs], {
      timeoutMs: 2 * 60_000,
    })
    failWithOutput(`Notarization ${info.status}.`, logResult)
  }

  await sleep(pollSeconds * 1_000)
  return waitForNotarization(deadlineMs)
}

async function stapleTicket(attempt = 1) {
  if (attempt > 5) return false

  console.log(`Stapling app, attempt ${attempt}`)
  const stapleResult = await run("xcrun", ["stapler", "staple", "-v", appPath], {
    inherit: true,
    timeoutMs: 5 * 60_000,
  })
  if (stapleResult.code === 0) {
    console.log("Notarization ticket stapled.")
    return true
  }

  await sleep(30_000)
  return stapleTicket(attempt + 1)
}

function readOption(name) {
  const index = args.indexOf(name)
  if (index === -1) return undefined

  const value = args[index + 1]
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`)
  }
  return value
}

function requiredEnv(name) {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

async function run(command, commandArgs, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000
  const child = spawn(command, commandArgs, {
    cwd: options.cwd,
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  })

  let stdout = ""
  let stderr = ""
  let timedOut = false
  let killTimeout

  if (!options.inherit) {
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
  }

  const timeout = setTimeout(() => {
    timedOut = true
    child.kill("SIGTERM")
    killTimeout = setTimeout(() => child.kill("SIGKILL"), 5_000)
    killTimeout.unref()
  }, timeoutMs)

  const result = await Promise.race([
    once(child, "close").then(([code]) => ({ code, stdout, stderr, timedOut })),
    once(child, "error").then(([error]) => ({
      code: 1,
      stdout,
      stderr: `${stderr}${error.message}`,
      timedOut,
    })),
  ])

  clearTimeout(timeout)
  if (killTimeout !== undefined) clearTimeout(killTimeout)

  return result
}

function failWithOutput(message, result) {
  console.error(message)
  if (result?.timedOut) console.error("Command timed out.")
  if (result?.stdout) console.error(result.stdout)
  if (result?.stderr) console.error(result.stderr)
  process.exit(1)
}

function parseJson(text, context) {
  try {
    return JSON.parse(text)
  } catch (error) {
    console.error(`Failed to parse JSON from ${context}:`)
    console.error(text)
    throw error
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
