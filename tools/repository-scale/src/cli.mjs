#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { prepareGitFixture } from "./git-fixture.mjs"
import { generateSyntheticFixture } from "./synthetic-fixture.mjs"
import {
  evaluateSwitchMemoryPlateau,
  measureProcessTree,
  validateSwitchReports,
} from "./process-metrics.mjs"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const defaultCacheDirectory = resolve(packageRoot, ".cache")

const usage = `Usage:
  pnpm repository-scale:generate [--name=pathological]
  pnpm repository-scale:prepare -- --source=<local-git-repository> --base=<revision> --head=<revision> [--name=linux]
  pnpm repository-scale:measure -- --pid=<electron-pid> --fixture=<fixture-id> --session=<name> --switch=<1-10>
  pnpm repository-scale:evaluate -- --session=<name>
`

const commandOptions = {
  generate: new Set(["name"]),
  prepare: new Set(["source", "base", "head", "name"]),
  measure: new Set([
    "pid",
    "fixture",
    "session",
    "switch",
    "duration-ms",
    "interval-ms",
    "plateau-window-ms",
    "plateau-threshold",
  ]),
  evaluate: new Set(["session"]),
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

const measure = async (options) => {
  const pid = positiveNumber(options, "pid", null)
  if (pid === null || !Number.isSafeInteger(pid)) throw new Error("--pid must be a process ID")
  const switchIndex = positiveNumber(options, "switch", null)
  if (switchIndex === null || !Number.isSafeInteger(switchIndex) || switchIndex > 10) {
    throw new Error("--switch must be an integer from 1 through 10")
  }
  const fixtureId = safeName(options, "fixture")
  const session = safeName(options, "session")
  const measurement = await measureProcessTree({
    rootPid: pid,
    durationMs: positiveNumber(options, "duration-ms", 60_000),
    intervalMs: positiveNumber(options, "interval-ms", 500),
    plateauWindowMs: positiveNumber(options, "plateau-window-ms", 10_000),
    plateauThreshold: positiveNumber(options, "plateau-threshold", 0.05),
  })
  const report = { ...measurement, fixtureId, session, switchIndex }
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
  const { fixtureId } = validateSwitchReports(reports, session)
  const evaluation = {
    ...evaluateSwitchMemoryPlateau(reports),
    fixtureId,
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
  return evaluate(options)
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})
