import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"

import {
  assertPathFreeSummary,
  OrchestrationGateError,
  parseOrchestrationOptions,
  runOwnedCommand,
  summarizeOrchestrationReport,
  terminateChild,
  validateFullFixtureManifest,
} from "../src/orchestration.mjs"
import { repositoryScaleProfile } from "../src/synthetic-fixture.mjs"

const passingReport = () => ({
  version: 1,
  profile: "smoke",
  host: "utility",
  session: "smoke-utility",
  fixture: {
    id: "pathological-safe",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    changedFiles: 64,
    addedRows: 20_000,
  },
  gates: {
    packaged: true,
    hostSelected: true,
    exactComparison: true,
    firstRange: true,
    farTarget: true,
    broadSearch: true,
    mountedRowsBounded: true,
    rapidSwitches: true,
    coreRestart: true,
    processTeardown: true,
    disposalComplete: true,
    rescanCancellation: true,
  },
  observations: { maximumMountedRows: 180, switchCount: 4 },
  blocked: [],
  switchReports: [],
})

test("validates smoke and full orchestration options", () => {
  assert.deepEqual(parseOrchestrationOptions(["--host=bun"], "smoke"), {
    host: "bun",
    profile: "smoke",
  })
  assert.deepEqual(parseOrchestrationOptions(["--host=utility", "--session=linux-main"], "full"), {
    host: "utility",
    manifest: undefined,
    profile: "full",
    session: "linux-main",
  })
  assert.throws(() => parseOrchestrationOptions(["--host=embedded"], "smoke"), /bun, utility/)
  assert.throws(
    () => parseOrchestrationOptions(["--host=bun", "--session=../private"], "full"),
    /session must contain/,
  )
  assert.throws(
    () => parseOrchestrationOptions(["--host=bun", "--session=x"], "smoke"),
    /Unknown option/,
  )
})

test("accepts only the exact generated full fixture profile", () => {
  const manifest = {
    version: 2,
    kind: "synthetic-repository-scale",
    id: "pathological-pinned",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    revisionSha: "c".repeat(40),
    profile: repositoryScaleProfile,
    scale: { changedFiles: 61_000, addedRows: 30_000_000 },
  }
  assert.equal(validateFullFixtureManifest(manifest), manifest)
  assert.throws(
    () =>
      validateFullFixtureManifest({ ...manifest, scale: { ...manifest.scale, changedFiles: 60 } }),
    /61k-file\/30m-row/,
  )
})

test("emits path-free summaries and rejects path-bearing summary data", () => {
  const summary = summarizeOrchestrationReport(passingReport())
  assert.equal(summary.passed, true)
  assert.equal(JSON.stringify(summary).includes(process.cwd()), false)
  assert.throws(
    () => assertPathFreeSummary({ ...summary, rawReportPath: "/private/results/raw.json" }),
    /private field/,
  )
  assert.throws(
    () => assertPathFreeSummary({ ...summary, blocked: [{ scenario: "/private/repo" }] }),
    /absolute path/,
  )
})

test("fails nonzero-worthy objective gates without inventing measurements", () => {
  const report = passingReport()
  report.gates.broadSearch = false
  assert.throws(
    () => summarizeOrchestrationReport(report),
    (error) =>
      error instanceof OrchestrationGateError &&
      error.summary.passed === false &&
      error.summary.failedGates.includes("broadSearch") &&
      error.summary.memory === null,
  )
})

test("rejects reports that only describe missing lifecycle evidence", () => {
  const report = passingReport()
  report.gates.disposalComplete = false
  report.gates.rescanCancellation = false
  report.blocked = [
    { scenario: "foreground disposal completion", reason: "No lifecycle signal." },
    { scenario: "rescan cancellation counters", reason: "No lifecycle signal." },
  ]
  assert.throws(
    () => summarizeOrchestrationReport(report),
    (error) =>
      error instanceof OrchestrationGateError &&
      error.summary.failedGates.includes("disposalComplete") &&
      error.summary.failedGates.includes("rescanCancellation"),
  )
})

test("terminates an owned child and removes command signal handlers", async () => {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.signals = []
  child.kill = (signal) => {
    child.signals.push(signal)
    return true
  }
  assert.equal(terminateChild(child), true)
  assert.deepEqual(child.signals, ["SIGTERM"])
  child.exitCode = 0
  assert.equal(terminateChild(child), false)

  const before = process.listenerCount("SIGTERM")
  const command = runOwnedCommand("fixture-command", [], {
    spawnImplementation: () => child,
    stdio: "ignore",
  })
  child.emit("close", 0, null)
  await command
  assert.equal(process.listenerCount("SIGTERM"), before)
})
