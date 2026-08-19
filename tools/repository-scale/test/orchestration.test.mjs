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
  provenance: {
    diffdashCommit: "c".repeat(40),
    appVersion: "0.8.1",
    machineProfile: {
      platform: process.platform,
      architecture: process.arch,
      operatingSystemRelease: "test-release",
      logicalCpuCount: 8,
      physicalMemoryBytes: 16 * 1024 * 1024 * 1024,
      nodeVersion: process.version,
    },
    fixtureManifest: {
      version: 2,
      kind: "synthetic-repository-scale",
      id: "pathological-safe",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      revisionSha: "d".repeat(40),
    },
    packaged: true,
    packagedArtifactDigest: "e".repeat(64),
    core: { host: "utility", session: "smoke-utility", bunVersion: null },
  },
  gates: {
    packaged: true,
    hostSelected: true,
    exactComparison: true,
    firstRange: true,
    farTarget: true,
    broadSearch: true,
    mountedRowsBounded: true,
    rendererMetricsObserved: true,
    rapidSwitches: true,
    coreRestart: true,
    processTeardown: true,
    disposalComplete: true,
    rescanCancellation: true,
  },
  observations: {
    maximumMountedRows: 180,
    switchCount: 4,
    disposedSessionId: "session:prior",
    replacementSessionId: "session:replacement",
    supersededOperationId: "core:operation-prior",
    drainedOperationId: "core:operation-prior",
    acquisitionCounters: { started: 2, superseded: 1, drained: 1 },
    renderer: {
      domNodes: 500,
      frameDurationMilliseconds: {
        count: 120,
        p50: 16.7,
        p95: 18.2,
        p99: 24.1,
        maximum: 32,
      },
      heap: { usedBytes: 64 * 1024 * 1024, limitBytes: 4 * 1024 * 1024 * 1024 },
      livePierreHosts: 4,
      longTasks: { count: 0, maximumDurationMilliseconds: 0, totalDurationMilliseconds: 0 },
    },
  },
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
  assert.equal(assertPathFreeSummary({ optional: undefined }).optional, undefined)
  assert.equal(summary.provenance.packagedArtifactDigest, "e".repeat(64))
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

test("rejects incomplete packaged provenance", () => {
  const report = passingReport()
  report.provenance.packagedArtifactDigest = null
  assert.throws(() => summarizeOrchestrationReport(report), /incomplete or inconsistent provenance/)
})

test("preserves path-free per-role process and managed-root observations", () => {
  const report = passingReport()
  const measurement = {
    coreIdentity: {
      host: "utility",
      session: "smoke-utility",
      switchIndex: 1,
      reviewSessionId: "review:one",
    },
    scenario: "pathological",
    peaks: {
      electron: {
        rssBytes: 100,
        privateBytes: 80,
        swapBytes: 0,
        readBytes: 20,
        writeBytes: 30,
      },
    },
    final: { electron: { processCount: 1, rssBytes: 90, privateBytes: 70, swapBytes: 0 } },
    totalPeakRssBytes: 100,
    totalFinalRssBytes: 90,
    steadyWindow: { reached: true },
    storage: {
      before: {
        databaseBytes: 10,
        managedBytes: 20,
        managedRoots: {
          snapshotBlockBytes: 5,
          snapshotSpoolBytes: 5,
          worktreePoolBytes: 5,
          remoteWorktreePoolBytes: 5,
        },
      },
      after: {
        databaseBytes: 11,
        managedBytes: 21,
        managedRoots: {
          snapshotBlockBytes: 6,
          snapshotSpoolBytes: 5,
          worktreePoolBytes: 5,
          remoteWorktreePoolBytes: 5,
        },
      },
    },
  }
  report.switchReports = [measurement]

  assert.deepEqual(summarizeOrchestrationReport(report).switchMeasurements, [measurement])
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

test("rejects renderer gates without measured heap, DOM, frame, and long-task evidence", () => {
  const report = passingReport()
  report.observations.renderer.frameDurationMilliseconds.count = 0
  assert.throws(
    () => summarizeOrchestrationReport(report),
    (error) =>
      error instanceof OrchestrationGateError &&
      error.summary.failedGates.includes("rendererEvidence"),
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
      error.summary.failedGates.includes("rescanCancellation") &&
      error.summary.failedGates.includes("blockedScenarios"),
  )
})

test("rejects lifecycle gates without matching stable session and operation identities", () => {
  const report = passingReport()
  report.observations.replacementSessionId = report.observations.disposedSessionId
  report.observations.drainedOperationId = "core:another-operation"
  assert.throws(
    () => summarizeOrchestrationReport(report),
    (error) =>
      error instanceof OrchestrationGateError &&
      error.summary.failedGates.includes("disposalIdentityEvidence") &&
      error.summary.failedGates.includes("rescanIdentityEvidence"),
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
