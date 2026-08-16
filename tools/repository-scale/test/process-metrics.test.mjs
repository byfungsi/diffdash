import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  classifyProcess,
  evaluateSwitchMemoryPlateau,
  measureManagedStorage,
  measureProcessTree,
  parseLinuxIo,
  parseLinuxSmaps,
  parseLinuxStatus,
  parseProcessList,
  REPOSITORY_SCALE_MEASUREMENT_POLICY,
  validateSwitchReports,
} from "../src/process-metrics.mjs"

test("reports database, managed, and free-space bytes without paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "diffdash-scale-storage-"))
  try {
    const managedRoot = join(root, "managed")
    const nested = join(managedRoot, "nested")
    const databasePath = join(root, "diffdash.sqlite")
    await mkdir(nested, { recursive: true })
    await Promise.all([
      writeFile(databasePath, Buffer.alloc(17)),
      writeFile(join(managedRoot, "block"), Buffer.alloc(23)),
      writeFile(join(nested, "spool"), Buffer.alloc(31)),
    ])

    const measured = await measureManagedStorage({ databasePath, managedRoot })
    assert.equal(measured.databaseBytes, 17)
    assert.equal(measured.managedBytes, 54)
    assert.ok(measured.filesystemFreeBytes > 0)
    assert.ok(measured.filesystemTotalBytes >= measured.filesystemFreeBytes)
    assert.equal(JSON.stringify(measured).includes(root), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("parses process lists and classifies DiffDash ownership", () => {
  const processes = parseProcessList(`
  100 1 2048 /Applications/DiffDash
  101 100 1024 /Applications/DiffDash --type=renderer
  102 100 512 diffdash-core
  103 100 256 git diff
  104 100 128 /Applications/DiffDash --type=utility --utility-sub-type=network.mojom.NetworkService
  105 100 768 /opt/diffdash/core/bun core-bun.mjs
  106 100 640 /Applications/DiffDash --type=utility --utility-sub-type=node.mojom.NodeService core.mjs
`)
  assert.equal(processes[0].rssBytes, 2_097_152)
  assert.deepEqual(
    processes.map((process) => classifyProcess(process, 100)),
    ["electron", "renderer", "coreWorker", "child", "child", "coreWorker", "coreWorker"],
  )
})

test("parses Linux memory and I/O counters", () => {
  assert.deepEqual(parseLinuxStatus("VmRSS:\t120 kB\nRssAnon:\t80 kB\nVmSwap:\t20 kB\n"), {
    privateBytes: 81_920,
    rssBytes: 122_880,
    swapBytes: 20_480,
  })
  assert.deepEqual(parseLinuxIo("read_bytes: 120\nwrite_bytes: 45\n"), {
    readBytes: 120,
    writeBytes: 45,
  })
  assert.deepEqual(parseLinuxSmaps("Private_Clean: 30 kB\nPrivate_Dirty: 50 kB\nSwap: 10 kB\n"), {
    privateBytes: 81_920,
    swapBytes: 10_240,
  })
})

test("reports process peaks, I/O deltas, and a complete steady window", async () => {
  const rss = [100, 110, 110, 111]
  let index = 0
  let currentTime = 0
  const report = await measureProcessTree({
    rootPid: 100,
    durationMs: 3,
    intervalMs: 1,
    plateauWindowMs: 2,
    plateauThreshold: 0.02,
    capture: async () => {
      const value = rss[Math.min(index, rss.length - 1)]
      index += 1
      return {
        capturedAt: new Date(index * 1_000).toISOString(),
        byRole: {
          electron: {
            rssBytes: value,
            privateBytes: value - 10,
            swapBytes: 0,
            readBytes: 1,
            writeBytes: 2,
          },
          renderer: {
            rssBytes: 0,
            privateBytes: null,
            swapBytes: null,
            readBytes: null,
            writeBytes: null,
          },
          coreWorker: {
            rssBytes: 0,
            privateBytes: null,
            swapBytes: null,
            readBytes: null,
            writeBytes: null,
          },
          child: {
            rssBytes: 0,
            privateBytes: null,
            swapBytes: null,
            readBytes: null,
            writeBytes: null,
          },
        },
        counters: [
          {
            pid: 100,
            role: "electron",
            readBytes: index * 10,
            writeBytes: index * 5,
          },
        ],
      }
    },
    now: () => currentTime,
    wait: async (milliseconds) => {
      currentTime += milliseconds
    },
  })

  assert.equal(report.peaks.electron.rssBytes, 111)
  assert.equal(report.peaks.electron.readBytes, 30)
  assert.equal(report.peaks.electron.writeBytes, 15)
  assert.equal(report.totalPeakRssBytes, 111)
  assert.equal(report.totalFinalRssBytes, 111)
  assert.deepEqual(
    report.samples.map(({ elapsedMs }) => elapsedMs),
    [0, 1, 2, 3],
  )
  assert.equal(report.steadyWindow.reached, true)
})

test("does not report a steady window before the complete duration is observed", async () => {
  let currentTime = 0
  const report = await measureProcessTree({
    rootPid: 100,
    durationMs: 1,
    intervalMs: 1,
    plateauWindowMs: 2,
    plateauThreshold: 0.05,
    capture: async () => ({
      capturedAt: new Date(currentTime).toISOString(),
      byRole: Object.fromEntries(
        ["electron", "renderer", "coreWorker", "child"].map((role) => [
          role,
          {
            rssBytes: role === "electron" ? 100 : 0,
            privateBytes: null,
            swapBytes: null,
            readBytes: null,
            writeBytes: null,
          },
        ]),
      ),
      counters: [],
    }),
    now: () => currentTime,
    wait: async (milliseconds) => {
      currentTime += milliseconds
    },
  })

  assert.equal(report.steadyWindow.reached, false)
})

test("evaluates ten switches with warm-up, absolute tolerance, and growth detection", () => {
  const mebibyte = 1024 * 1024
  const stable = [500, 600, 550, 520, 522, 519, 521, 520, 523, 521].map((totalFinalRssBytes) => ({
    totalFinalRssBytes: totalFinalRssBytes * mebibyte,
  }))
  const stableEvaluation = evaluateSwitchMemoryPlateau(stable)
  assert.equal(stableEvaluation.toleranceBytes, 32 * mebibyte)
  assert.equal(stableEvaluation.passed, true)

  const growing = [500, 600, 550, 520, 521, 522, 523, 524, 525, 526].map((totalFinalRssBytes) => ({
    totalFinalRssBytes: totalFinalRssBytes * mebibyte,
  }))
  const growingEvaluation = evaluateSwitchMemoryPlateau(growing)
  assert.equal(growingEvaluation.monotonicGrowth, true)
  assert.equal(growingEvaluation.passed, false)
  const growingWithPause = [500, 600, 550, 520, 521, 522, 522, 523, 524, 525].map(
    (totalFinalRssBytes) => ({ totalFinalRssBytes: totalFinalRssBytes * mebibyte }),
  )
  assert.equal(evaluateSwitchMemoryPlateau(growingWithPause).monotonicGrowth, true)
  assert.throws(() => evaluateSwitchMemoryPlateau(stable.slice(1)), /exactly ten switches/)
})

test("rejects stale, incomplete, and mixed switch reports", () => {
  const reports = Array.from({ length: 10 }, (_, index) => ({
    version: 2,
    appVersion: "0.8.1",
    coreHost: "utility",
    diffdashCommit: "c".repeat(40),
    disposalComplete: true,
    fixtureId: "linux-test",
    fixtureManifest: {
      id: "linux-test",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    },
    session: "baseline",
    switchIndex: index + 1,
    platform: "linux",
    packaged: true,
    scenario: index % 2 === 0 ? "pathological" : "small",
    storage: {
      before: {
        databaseBytes: 1_000,
        managedBytes: 2_000,
        filesystemFreeBytes: 10_000,
        filesystemTotalBytes: 20_000,
      },
      after: {
        databaseBytes: 1_010,
        managedBytes: 2_020,
        filesystemFreeBytes: 9_970,
        filesystemTotalBytes: 20_000,
      },
      databaseDeltaBytes: 10,
      managedDeltaBytes: 20,
      freeSpaceDeltaBytes: -30,
    },
    machineProfile: {
      platform: "linux",
      architecture: "x64",
      operatingSystemRelease: "6.8.0-test",
      logicalCpuCount: 8,
      physicalMemoryBytes: 16 * 1024 * 1024 * 1024,
      nodeVersion: "v22.20.0",
    },
    totalFinalRssBytes: 500 * 1024 * 1024,
    durationMs: REPOSITORY_SCALE_MEASUREMENT_POLICY.durationMs,
    intervalMs: REPOSITORY_SCALE_MEASUREMENT_POLICY.intervalMs,
    steadyWindow: {
      reached: true,
      windowMs: REPOSITORY_SCALE_MEASUREMENT_POLICY.plateauWindowMs,
      threshold: REPOSITORY_SCALE_MEASUREMENT_POLICY.plateauThreshold,
    },
  }))
  assert.deepEqual(validateSwitchReports(reports, "baseline"), {
    appVersion: "0.8.1",
    coreHost: "utility",
    diffdashCommit: "c".repeat(40),
    fixtureId: "linux-test",
    machineProfile: reports[0].machineProfile,
    platform: "linux",
  })
  assert.throws(
    () =>
      validateSwitchReports(
        reports.with(5, { ...reports[5], steadyWindow: { reached: false } }),
        "baseline",
      ),
    /Switch 6 did not reach/,
  )
  assert.throws(
    () => validateSwitchReports(reports.with(7, { ...reports[7], switchIndex: 9 }), "baseline"),
    /Switch 8 has mismatched identity/,
  )
  assert.throws(
    () => validateSwitchReports(reports.with(9, { ...reports[9], platform: "darwin" }), "baseline"),
    /same platform/,
  )
  assert.throws(
    () => validateSwitchReports(reports.with(0, { ...reports[0], durationMs: 1 }), "baseline"),
    /approved measurement policy/,
  )
  assert.throws(
    () =>
      validateSwitchReports(
        reports.with(4, { ...reports[4], diffdashCommit: "d".repeat(40) }),
        "baseline",
      ),
    /same DiffDash commit/,
  )
  assert.throws(
    () =>
      validateSwitchReports(
        reports.with(2, {
          ...reports[2],
          machineProfile: { ...reports[2].machineProfile, logicalCpuCount: 16 },
        }),
        "baseline",
      ),
    /same machine profile/,
  )
  assert.throws(
    () =>
      validateSwitchReports(
        reports.with(5, { ...reports[5], scenario: reports[4].scenario }),
        "baseline",
      ),
    /did not alternate/,
  )
  assert.throws(
    () =>
      validateSwitchReports(
        reports.with(9, { ...reports[9], disposalComplete: false }),
        "baseline",
      ),
    /before disposal completed/,
  )
  assert.throws(
    () => validateSwitchReports(reports.with(3, { ...reports[3], storage: null }), "baseline"),
    /incomplete managed storage/,
  )
})
