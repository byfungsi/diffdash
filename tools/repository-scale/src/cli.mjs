#!/usr/bin/env node
import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { prepareGitFixture } from "./git-fixture.mjs"
import { generateSyntheticFixture } from "./synthetic-fixture.mjs"
import { parseOrchestrationOptions, runRepositoryScaleOrchestration } from "./orchestration.mjs"
import {
  captureMachineProfile,
  evaluateSwitchMemoryPlateau,
  measureManagedStorage,
  measureProcessTree,
  REPOSITORY_SCALE_MEASUREMENT_POLICY,
  validateSwitchReports,
} from "./process-metrics.mjs"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(packageRoot, "../..")
const defaultCacheDirectory = resolve(packageRoot, ".cache")
const execFilePromise = promisify(execFile)

const usage = `Usage:
  pnpm repository-scale:generate [--name=pathological]
  pnpm repository-scale:prepare -- --source=<local-git-repository> --base=<revision> --head=<revision> [--name=linux]
  pnpm repository-scale:measure -- --pid=<electron-pid> --manifest=<fixture-manifest.json> --database=<diffdash.sqlite> --snapshot-root=<diffdash.sqlite.snapshot-blocks> --spool-root=<snapshot-spools> --worktree-root=<worktree-pool> --remote-worktree-root=<remote-worktree-pool> --session=<name> --switch=<1-10> --host=<bun|utility> --scenario=<pathological|small> --app-version=<version> --artifact-digest=<sha256> --review-session-id=<id> [--bun-version=<version>] --packaged=true --disposal-complete=true
  pnpm repository-scale:evaluate -- --session=<name>
  pnpm --filter @diffdash/repository-scale smoke -- --host=<bun|utility>
  pnpm --filter @diffdash/repository-scale run -- --host=<bun|utility> --session=<name> [--manifest=<path>]
`

const commandOptions = {
  generate: new Set(["name"]),
  prepare: new Set(["source", "base", "head", "name"]),
  measure: new Set([
    "pid",
    "manifest",
    "session",
    "switch",
    "host",
    "scenario",
    "app-version",
    "packaged",
    "disposal-complete",
    "database",
    "snapshot-root",
    "spool-root",
    "worktree-root",
    "remote-worktree-root",
    "artifact-digest",
    "bun-version",
    "review-session-id",
    "duration-ms",
    "interval-ms",
    "plateau-window-ms",
    "plateau-threshold",
  ]),
  evaluate: new Set(["session"]),
  smoke: new Set(["host"]),
  run: new Set(["host", "session", "manifest"]),
}

const parseOptions = (args) => {
  const options = new Map()
  for (const argument of args) {
    if (argument === "--") continue
    if (!argument.startsWith("--") || !argument.includes("=")) {
      throw new Error(`Invalid option: ${argument}`)
    }
    const separator = argument.indexOf("=")
    const name = argument.slice(2, separator)
    const value = argument.slice(separator + 1)
    if (options.has(name)) throw new Error(`Duplicate option: --${name}`)
    options.set(name, value)
  }
  return options
}

const validateOptions = (command, options) => {
  const allowed = commandOptions[command]
  if (allowed === undefined) throw new Error(`Unknown command: ${command}`)
  for (const name of options.keys()) {
    if (!allowed.has(name)) throw new Error(`Unknown option for ${command}: --${name}`)
  }
}

const required = (options, name) => {
  const value = options.get(name)
  if (value === undefined || value.length === 0)
    throw new Error(`Missing required option: --${name}`)
  return value
}

const positiveNumber = (options, name, fallback) => {
  const input = options.get(name)
  if (input === undefined) return fallback
  const value = Number(input)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be positive`)
  return value
}

const safeName = (options, name) => {
  const value = required(options, name)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`--${name} must contain only letters, numbers, dots, underscores, and dashes`)
  }
  return value
}

const choice = (options, name, choices) => {
  const value = required(options, name)
  if (!choices.includes(value)) throw new Error(`--${name} must be one of ${choices.join(", ")}`)
  return value
}

const requiredTrue = (options, name) => {
  if (required(options, name) !== "true") throw new Error(`--${name} must be true`)
  return true
}

const isString = (value) => Object.prototype.toString.call(value) === "[object String]"

const isRecord = (value) => value !== null && Object.getPrototypeOf(value) === Object.prototype

const prepare = async (options) => {
  const result = await prepareGitFixture({
    source: required(options, "source"),
    base: required(options, "base"),
    head: required(options, "head"),
    name: options.get("name"),
    cacheDirectory: defaultCacheDirectory,
  })
  process.stdout.write(
    `${JSON.stringify(
      {
        fixtureDirectory: result.fixtureDirectory,
        repository: result.repository,
        manifest: result.manifest,
      },
      null,
      2,
    )}\n`,
  )
}

const readFixtureManifest = async (options) => {
  const manifestPath = resolve(required(options, "manifest"))
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  if (
    !isRecord(manifest) ||
    !isString(manifest.id) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.id) ||
    !isString(manifest.baseSha) ||
    !isString(manifest.headSha)
  ) {
    throw new Error("Fixture manifest must contain a safe id and pinned base/head revisions")
  }
  return manifest
}

const measure = async (options) => {
  const pid = positiveNumber(options, "pid", null)
  if (pid === null || !Number.isSafeInteger(pid)) throw new Error("--pid must be a process ID")
  const switchIndex = positiveNumber(options, "switch", null)
  if (switchIndex === null || !Number.isSafeInteger(switchIndex) || switchIndex > 10) {
    throw new Error("--switch must be an integer from 1 through 10")
  }
  const fixture = await readFixtureManifest(options)
  const session = safeName(options, "session")
  const coreHost = choice(options, "host", ["bun", "utility"])
  const scenario = choice(options, "scenario", ["pathological", "small"])
  const appVersion = required(options, "app-version")
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(appVersion)) {
    throw new Error("--app-version must be a semantic version")
  }
  const packaged = requiredTrue(options, "packaged")
  const disposalComplete = requiredTrue(options, "disposal-complete")
  const packagedArtifactDigest = required(options, "artifact-digest")
  if (!/^[a-f0-9]{64}$/u.test(packagedArtifactDigest)) {
    throw new Error("--artifact-digest must be a SHA-256 digest")
  }
  const bunVersion = options.get("bun-version") ?? null
  if (coreHost === "bun" && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(String(bunVersion))) {
    throw new Error("--bun-version is required for Bun measurements")
  }
  if (coreHost === "utility" && bunVersion !== null) {
    throw new Error("--bun-version applies only to Bun measurements")
  }
  const reviewSessionId = required(options, "review-session-id")
  const storagePaths = {
    databasePath: resolve(required(options, "database")),
    snapshotBlocksRoot: resolve(required(options, "snapshot-root")),
    snapshotSpoolsRoot: resolve(required(options, "spool-root")),
    worktreePoolRoot: resolve(required(options, "worktree-root")),
    remoteWorktreePoolRoot: resolve(required(options, "remote-worktree-root")),
  }
  const { stdout: commitOutput } = await execFilePromise("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: workspaceRoot,
  })
  const diffdashCommit = commitOutput.trim()
  if (!/^[a-f0-9]{40}$/u.test(diffdashCommit)) {
    throw new Error("Unable to resolve the exact DiffDash commit")
  }
  const storageBefore = await measureManagedStorage(storagePaths)
  const measurement = await measureProcessTree({
    rootPid: pid,
    durationMs: positiveNumber(
      options,
      "duration-ms",
      REPOSITORY_SCALE_MEASUREMENT_POLICY.durationMs,
    ),
    intervalMs: positiveNumber(
      options,
      "interval-ms",
      REPOSITORY_SCALE_MEASUREMENT_POLICY.intervalMs,
    ),
    plateauWindowMs: positiveNumber(
      options,
      "plateau-window-ms",
      REPOSITORY_SCALE_MEASUREMENT_POLICY.plateauWindowMs,
    ),
    plateauThreshold: positiveNumber(
      options,
      "plateau-threshold",
      REPOSITORY_SCALE_MEASUREMENT_POLICY.plateauThreshold,
    ),
  })
  const storageAfter = await measureManagedStorage(storagePaths)
  const report = {
    ...measurement,
    appVersion,
    bunVersion,
    coreHost,
    coreIdentity: { host: coreHost, session, switchIndex, reviewSessionId },
    diffdashCommit,
    disposalComplete,
    fixtureId: fixture.id,
    fixtureManifest: fixture,
    machineProfile: captureMachineProfile(),
    packaged,
    packagedArtifactDigest,
    scenario,
    session,
    storage: {
      before: storageBefore,
      after: storageAfter,
      databaseDeltaBytes: storageAfter.databaseBytes - storageBefore.databaseBytes,
      managedDeltaBytes: storageAfter.managedBytes - storageBefore.managedBytes,
      freeSpaceDeltaBytes: storageAfter.filesystemFreeBytes - storageBefore.filesystemFreeBytes,
    },
    switchIndex,
  }
  const output = resolve(
    defaultCacheDirectory,
    "reports",
    session,
    `switch-${String(switchIndex).padStart(2, "0")}.json`,
  )
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${output}\n`)
}

const evaluate = async (options) => {
  const session = safeName(options, "session")
  const reportDirectory = resolve(defaultCacheDirectory, "reports", session)
  const reports = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      readFile(
        resolve(reportDirectory, `switch-${String(index + 1).padStart(2, "0")}.json`),
        "utf8",
      ).then(JSON.parse),
    ),
  )
  const provenance = validateSwitchReports(reports, session)
  const evaluation = {
    ...evaluateSwitchMemoryPlateau(reports),
    ...provenance,
    session,
  }
  const output = resolve(reportDirectory, "evaluation.json")
  await writeFile(output, `${JSON.stringify(evaluation, null, 2)}\n`)
  process.stdout.write(`${output}\n`)
}

const generate = async (options) => {
  const name = options.get("name") ?? "pathological"
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error("Invalid fixture name")
  const result = await generateSyntheticFixture({
    directory: resolve(defaultCacheDirectory, "synthetic", name, "repository"),
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

const orchestrate = async (command, args) => {
  const profile = command === "smoke" ? "smoke" : "full"
  const options = parseOrchestrationOptions(args, profile)
  const result = await runRepositoryScaleOrchestration({
    ...options,
    cacheDirectory: defaultCacheDirectory,
    e2eDirectory: resolve(workspaceRoot, "packages/e2e"),
  })
  process.stdout.write(`${result.summaryPath}\n`)
}

const main = async () => {
  const [command, ...args] = process.argv.slice(2)
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(usage)
    return
  }
  const options = parseOptions(args)
  validateOptions(command, options)
  if (command === "generate") return generate(options)
  if (command === "prepare") return prepare(options)
  if (command === "measure") return measure(options)
  if (command === "smoke" || command === "run") return orchestrate(command, args)
  return evaluate(options)
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})
