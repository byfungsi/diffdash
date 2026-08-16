import { spawn } from "node:child_process"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { evaluateSwitchMemoryPlateau } from "./process-metrics.mjs"
import { generateSyntheticFixture, repositoryScaleProfile } from "./synthetic-fixture.mjs"

const HOSTS = new Set(["bun", "utility"])
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const SHA = /^[a-f0-9]{40}$/u
const smokeProfile = Object.freeze({
  fileCount: 64,
  rowCount: 20_000,
  enormousFileRows: 10_000,
  wrappedLineBytes: 4 * 1024,
})
const smallProfile = Object.freeze({
  fileCount: 12,
  rowCount: 240,
  enormousFileRows: 120,
  wrappedLineBytes: 512,
})

/** Parses and validates source-safe packaged orchestration options. */
export const parseOrchestrationOptions = (args, profile) => {
  if (profile !== "smoke" && profile !== "full") throw new Error(`Unknown profile: ${profile}`)
  const allowed = new Set(profile === "full" ? ["host", "session", "manifest"] : ["host"])
  const values = new Map()
  for (const argument of args) {
    if (argument === "--") continue
    const match = /^--([^=]+)=(.*)$/u.exec(argument)
    if (match === null) throw new Error(`Invalid option: ${argument}`)
    const [, name, value] = match
    if (!allowed.has(name)) throw new Error(`Unknown option for ${profile}: --${name}`)
    if (values.has(name)) throw new Error(`Duplicate option: --${name}`)
    values.set(name, value)
  }
  const host = values.get("host")
  if (!HOSTS.has(host)) throw new Error("--host must be one of bun, utility")
  if (profile === "smoke") return { host, profile }
  const session = values.get("session")
  if (session === undefined || !SAFE_NAME.test(session)) {
    throw new Error("--session must contain only letters, numbers, dots, underscores, and dashes")
  }
  return { host, manifest: values.get("manifest"), profile, session }
}

const isRecord = (value) => value !== null && Object.getPrototypeOf(value) === Object.prototype

/** Rejects unpinned or incorrectly-sized manifests before a full evidence run starts. */
export const validateFullFixtureManifest = (manifest) => {
  if (
    !isRecord(manifest) ||
    manifest.version !== 2 ||
    manifest.kind !== "synthetic-repository-scale" ||
    !SAFE_NAME.test(String(manifest.id)) ||
    !SHA.test(String(manifest.baseSha)) ||
    !SHA.test(String(manifest.headSha)) ||
    !SHA.test(String(manifest.revisionSha)) ||
    JSON.stringify(manifest.profile) !== JSON.stringify(repositoryScaleProfile) ||
    manifest.scale?.changedFiles !== repositoryScaleProfile.fileCount ||
    manifest.scale?.addedRows !== repositoryScaleProfile.rowCount
  ) {
    throw new Error("Full runs require the generated, pinned 61k-file/30m-row fixture manifest")
  }
  return manifest
}

/** Terminates an owned child without signalling unrelated processes. */
export const terminateChild = (child, signal = "SIGTERM") => {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return false
  return child.kill(signal)
}

/** Runs one child command and always removes signal handlers after completion. */
export const runOwnedCommand = (command, args, options = {}) =>
  new Promise((resolvePromise, reject) => {
    const spawnImplementation = options.spawnImplementation ?? spawn
    const child = spawnImplementation(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? "inherit",
    })
    const terminate = () => terminateChild(child)
    process.once("SIGINT", terminate)
    process.once("SIGTERM", terminate)
    const cleanup = () => {
      process.removeListener("SIGINT", terminate)
      process.removeListener("SIGTERM", terminate)
    }
    child.once("error", (error) => {
      cleanup()
      reject(error)
    })
    child.once("close", (code, signal) => {
      cleanup()
      if (signal !== null) reject(new Error(`${command} exited with signal ${signal}`))
      else if (code !== 0) reject(new Error(`${command} exited with status ${code ?? 1}`))
      else resolvePromise()
    })
  })

const privacyKeys = new Set([
  "fixturePath",
  "manifestPath",
  "repository",
  "rawReportPath",
  "userData",
  "xdgConfigHome",
])

/** Produces a path-free aggregate and fails objective scenario gates. */
export const summarizeOrchestrationReport = (report) => {
  if (!isRecord(report) || report.version !== 1) throw new Error("Unsupported orchestration report")
  const requiredGates = [
    "packaged",
    "hostSelected",
    "exactComparison",
    "firstRange",
    "farTarget",
    "broadSearch",
    "mountedRowsBounded",
    "rapidSwitches",
    "coreRestart",
    "processTeardown",
  ]
  const failedGates = requiredGates.filter((gate) => report.gates?.[gate] !== true)
  let memory = null
  if (report.profile === "full") {
    if (!Array.isArray(report.switchReports) || report.switchReports.length !== 10) {
      failedGates.push("tenSwitchMeasurements")
    } else {
      memory = evaluateSwitchMemoryPlateau(report.switchReports)
      if (!memory.passed) failedGates.push("memoryPlateau")
      if (report.switchReports.some((entry) => entry.steadyWindow?.reached !== true)) {
        failedGates.push("steadyWindows")
      }
    }
  }
  const summary = {
    version: 1,
    profile: report.profile,
    host: report.host,
    session: report.session ?? null,
    fixture: {
      id: report.fixture?.id,
      baseSha: report.fixture?.baseSha,
      headSha: report.fixture?.headSha,
      changedFiles: report.fixture?.changedFiles,
      addedRows: report.fixture?.addedRows,
    },
    gates: Object.fromEntries(requiredGates.map((gate) => [gate, report.gates?.[gate] === true])),
    observations: {
      maximumMountedRows: report.observations?.maximumMountedRows ?? null,
      switchCount: report.observations?.switchCount ?? 0,
    },
    blocked: Array.isArray(report.blocked) ? report.blocked : [],
    memory,
    passed: failedGates.length === 0,
    failedGates,
  }
  assertPathFreeSummary(summary)
  if (!summary.passed) throw new OrchestrationGateError(summary)
  return summary
}

/** Verifies that promoted summaries contain no path-bearing fields or absolute path strings. */
export const assertPathFreeSummary = (summary) => {
  const visit = (value, key = "") => {
    if (privacyKeys.has(key)) throw new Error(`Summary contains private field: ${key}`)
    if (
      Object.prototype.toString.call(value) === "[object String]" &&
      (/^(?:[A-Za-z]:[\\/]|\/)/u.test(value) || value.includes("file://"))
    ) {
      throw new Error("Summary contains an absolute path")
    }
    if (Array.isArray(value)) value.forEach((entry) => visit(entry))
    else if (isRecord(value)) Object.entries(value).forEach(([name, entry]) => visit(entry, name))
  }
  visit(summary)
  return summary
}

export class OrchestrationGateError extends Error {
  constructor(summary) {
    super(`Repository-scale gates failed: ${summary.failedGates.join(", ")}`)
    this.name = "OrchestrationGateError"
    this.summary = summary
  }
}

const readManifest = async (path) => JSON.parse(await readFile(path, "utf8"))

const ensureFixture = async ({ cacheDirectory, manifest, profile }) => {
  if (profile === "full") {
    const manifestPath = resolve(
      manifest ?? resolve(cacheDirectory, "synthetic", "pathological", "manifest.json"),
    )
    const fixture = validateFullFixtureManifest(await readManifest(manifestPath))
    const repository = resolve(dirname(manifestPath), "repository")
    await access(repository)
    return { manifest: fixture, manifestPath, repository }
  }
  return generateSyntheticFixture({
    directory: resolve(cacheDirectory, "synthetic", "smoke", "repository"),
    profile: smokeProfile,
  })
}

/** Builds and runs the packaged deterministic scenario, then writes only a path-free summary. */
export const runRepositoryScaleOrchestration = async ({
  cacheDirectory,
  e2eDirectory,
  host,
  manifest,
  profile,
  session = `smoke-${host}`,
}) => {
  const fixture = await ensureFixture({ cacheDirectory, manifest, profile })
  const small = await generateSyntheticFixture({
    directory: resolve(cacheDirectory, "synthetic", "small", "repository"),
    profile: smallProfile,
  })
  const reportDirectory = resolve(cacheDirectory, "orchestration", session)
  const rawReportPath = resolve(reportDirectory, "raw.json")
  const summaryPath = resolve(reportDirectory, "summary.json")
  await mkdir(reportDirectory, { recursive: true })
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
  await runOwnedCommand(pnpm, ["package:e2e"], { cwd: e2eDirectory })
  let executionError = null
  try {
    await runOwnedCommand(
      pnpm,
      [
        "exec",
        "playwright",
        "test",
        "tests/packaged/repository-scale.spec.ts",
        "--project=packaged",
      ],
      {
        cwd: e2eDirectory,
        env: {
          ...process.env,
          DIFFDASH_REPOSITORY_SCALE_HOST: host,
          DIFFDASH_REPOSITORY_SCALE_MANIFEST: fixture.manifestPath,
          DIFFDASH_REPOSITORY_SCALE_PROFILE: profile,
          DIFFDASH_REPOSITORY_SCALE_RAW_REPORT: rawReportPath,
          DIFFDASH_REPOSITORY_SCALE_SESSION: session,
          DIFFDASH_REPOSITORY_SCALE_SMALL_MANIFEST: small.manifestPath,
        },
      },
    )
  } catch (error) {
    executionError = error
  }
  if (executionError !== null)
    await access(rawReportPath).catch(() => Promise.reject(executionError))
  const raw = JSON.parse(await readFile(rawReportPath, "utf8"))
  let summary
  try {
    summary = summarizeOrchestrationReport(raw)
  } catch (error) {
    if (isRecord(error) && error.name === "OrchestrationGateError" && isRecord(error.summary)) {
      await writeFile(summaryPath, `${JSON.stringify(error.summary, null, 2)}\n`)
    }
    throw error
  }
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
  if (executionError !== null) throw executionError
  return { summary, summaryPath }
}
