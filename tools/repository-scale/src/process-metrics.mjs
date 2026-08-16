import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { arch, cpus, platform as osPlatform, release, totalmem } from "node:os"
import { promisify } from "node:util"

const execFilePromise = promisify(execFile)
const roles = ["electron", "renderer", "coreWorker", "child"]
const MINIMUM_PLATEAU_TOLERANCE_BYTES = 32 * 1024 * 1024

/** Fixed sampling policy required for promoted M21 ten-switch evidence. */
export const REPOSITORY_SCALE_MEASUREMENT_POLICY = Object.freeze({
  durationMs: 60_000,
  intervalMs: 500,
  plateauWindowMs: 10_000,
  plateauThreshold: 0.05,
})

/** Captures source-safe host facts required to reproduce one promoted measurement. */
export const captureMachineProfile = () => ({
  platform: osPlatform(),
  architecture: arch(),
  operatingSystemRelease: release(),
  logicalCpuCount: cpus().length,
  physicalMemoryBytes: totalmem(),
  nodeVersion: process.version,
})

const isNonEmptyString = (value) =>
  Object.prototype.toString.call(value) === "[object String]" && value.length > 0

const kilobytes = (value) => (value === null ? null : value * 1024)

/** Parses the portable process columns used to discover one process tree. */
export const parseProcessList = (output) =>
  output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
      if (match === null) throw new Error(`Unable to parse process row: ${line}`)
      return {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        rssBytes: Number(match[3]) * 1024,
        command: match[4],
      }
    })

/** Parses Linux process memory fields while keeping unsupported values absent on other platforms. */
export const parseLinuxStatus = (status) => {
  const readKb = (field) => {
    const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, "m").exec(status)
    return match === null ? null : Number(match[1])
  }
  return {
    privateBytes: kilobytes(readKb("RssAnon")),
    rssBytes: kilobytes(readKb("VmRSS")),
    swapBytes: kilobytes(readKb("VmSwap")),
  }
}

/** Parses cumulative Linux process I/O counters. */
export const parseLinuxIo = (input) => {
  const readBytes = (field) => {
    const match = new RegExp(`^${field}:\\s+(\\d+)$`, "m").exec(input)
    return match === null ? null : Number(match[1])
  }
  return {
    readBytes: readBytes("read_bytes"),
    writeBytes: readBytes("write_bytes"),
  }
}

/** Parses exact private and swap ownership from Linux smaps aggregation. */
export const parseLinuxSmaps = (input) => {
  const readKb = (field) => {
    const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, "m").exec(input)
    return match === null ? null : Number(match[1])
  }
  const privateClean = readKb("Private_Clean")
  const privateDirty = readKb("Private_Dirty")
  return {
    privateBytes:
      privateClean === null || privateDirty === null ? null : (privateClean + privateDirty) * 1024,
    swapBytes: kilobytes(readKb("Swap")),
  }
}

/** Assigns process samples to stable ownership categories without retaining command lines. */
export const classifyProcess = (process, rootPid) => {
  if (process.pid === rootPid) return "electron"
  if (process.command.includes("--type=renderer")) return "renderer"
  if (process.command.includes("diffdash-core") || process.command.includes("core-host")) {
    return "coreWorker"
  }
  return "child"
}

const descendantsOf = (processes, rootPid) => {
  const selected = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const process of processes) {
      if (!selected.has(process.pid) && selected.has(process.parentPid)) {
        selected.add(process.pid)
        changed = true
      }
    }
  }
  return processes.filter((process) => selected.has(process.pid))
}

const readLinuxDetails = async (pid) => {
  try {
    const [status, smaps, io] = await Promise.all([
      readFile(`/proc/${pid}/status`, "utf8"),
      readFile(`/proc/${pid}/smaps_rollup`, "utf8"),
      readFile(`/proc/${pid}/io`, "utf8"),
    ])
    return { ...parseLinuxStatus(status), ...parseLinuxSmaps(smaps), ...parseLinuxIo(io) }
  } catch {
    return null
  }
}

const sumNullable = (values) => {
  const present = values.filter((value) => value !== null)
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0)
}

/** Captures one privacy-safe process-tree memory and I/O sample. */
export const captureProcessTree = async (rootPid) => {
  const { stdout } = await execFilePromise("ps", ["-axo", "pid=,ppid=,rss=,command="])
  const processes = descendantsOf(parseProcessList(stdout), rootPid)
  if (processes.length === 0) throw new Error(`Process ${rootPid} is not running`)
  const detailed = await Promise.all(
    processes.map(async (observedProcess) => ({
      process: observedProcess,
      details: process.platform === "linux" ? await readLinuxDetails(observedProcess.pid) : null,
    })),
  )
  const byRole = Object.fromEntries(
    roles.map((role) => {
      const matching = detailed.filter(({ process }) => classifyProcess(process, rootPid) === role)
      return [
        role,
        {
          processCount: matching.length,
          rssBytes: matching.reduce(
            (total, { process, details }) => total + (details?.rssBytes ?? process.rssBytes),
            0,
          ),
          privateBytes: sumNullable(matching.map(({ details }) => details?.privateBytes ?? null)),
          swapBytes: sumNullable(matching.map(({ details }) => details?.swapBytes ?? null)),
          readBytes: sumNullable(matching.map(({ details }) => details?.readBytes ?? null)),
          writeBytes: sumNullable(matching.map(({ details }) => details?.writeBytes ?? null)),
        },
      ]
    }),
  )
  const counters = detailed.map(({ process: observedProcess, details }) => ({
    pid: observedProcess.pid,
    role: classifyProcess(observedProcess, rootPid),
    readBytes: details?.readBytes ?? null,
    writeBytes: details?.writeBytes ?? null,
  }))
  return { capturedAt: new Date().toISOString(), byRole, counters }
}

const sleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))

const totalRss = (sample) =>
  Object.values(sample.byRole).reduce((total, role) => total + role.rssBytes, 0)

const peakByRole = (samples, role, field) => {
  const values = samples
    .map((sample) => sample.byRole[role][field])
    .filter((value) => value !== null)
  return values.length === 0 ? null : Math.max(...values)
}

const ioDeltaByRole = (samples, role, field) => {
  const observed = new Map()
  for (const sample of samples) {
    for (const counter of sample.counters ?? []) {
      if (counter.role !== role || counter[field] === null) continue
      const existing = observed.get(counter.pid)
      if (existing === undefined) {
        observed.set(counter.pid, { first: counter[field], maximum: counter[field] })
      } else {
        existing.maximum = Math.max(existing.maximum, counter[field])
      }
    }
  }
  if (observed.size === 0) return null
  return [...observed.values()].reduce(
    (total, counter) => total + Math.max(0, counter.maximum - counter.first),
    0,
  )
}

/** Evaluates the specification's three-warm-up/seven-post-disposal memory gate. */
export const evaluateSwitchMemoryPlateau = (reports) => {
  if (reports.length !== 10)
    throw new Error("Memory plateau evaluation requires exactly ten switches")
  const postDisposal = reports.slice(3).map((report) => report.totalFinalRssBytes)
  const first = postDisposal[0]
  const final = postDisposal.at(-1)
  const toleranceBytes = Math.max(first * 0.05, MINIMUM_PLATEAU_TOLERANCE_BYTES)
  const rangeBytes = Math.max(...postDisposal) - Math.min(...postDisposal)
  const laterSamples = postDisposal.slice(1)
  const monotonicGrowth =
    laterSamples.every((value, index) => value >= postDisposal[index]) &&
    laterSamples.some((value, index) => value > postDisposal[index])
  const rangeWithinTolerance = rangeBytes <= toleranceBytes
  const finalWithinTolerance = final <= first + toleranceBytes
  return {
    version: 1,
    warmupSwitches: 3,
    evaluatedSwitches: 7,
    toleranceBytes,
    rangeBytes,
    firstPostDisposalRssBytes: first,
    finalPostDisposalRssBytes: final,
    rangeWithinTolerance,
    finalWithinTolerance,
    monotonicGrowth,
    passed: rangeWithinTolerance && finalWithinTolerance && !monotonicGrowth,
  }
}

/** Validates that ten ignored switch reports belong to one complete benchmark session. */
export const validateSwitchReports = (reports, session) => {
  if (reports.length !== 10)
    throw new Error("Switch report validation requires exactly ten reports")
  const fixtureId = reports[0]?.fixtureId
  const platform = reports[0]?.platform
  const diffdashCommit = reports[0]?.diffdashCommit
  const machineProfile = reports[0]?.machineProfile
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(fixtureId))) {
    throw new Error("Switch reports must contain a valid fixture identity")
  }
  if (String(platform).length === 0 || platform === undefined) {
    throw new Error("Switch reports must contain a platform")
  }
  if (platform !== "linux") throw new Error("Promoted switch reports must be captured on Linux")
  if (!/^[a-f0-9]{40}$/u.test(String(diffdashCommit))) {
    throw new Error("Switch reports must contain an exact DiffDash commit")
  }
  if (
    machineProfile?.platform !== "linux" ||
    !isNonEmptyString(machineProfile.architecture) ||
    !isNonEmptyString(machineProfile.operatingSystemRelease) ||
    !Number.isSafeInteger(machineProfile.logicalCpuCount) ||
    machineProfile.logicalCpuCount <= 0 ||
    !Number.isSafeInteger(machineProfile.physicalMemoryBytes) ||
    machineProfile.physicalMemoryBytes <= 0 ||
    !/^v\d+/u.test(String(machineProfile.nodeVersion))
  ) {
    throw new Error("Switch reports must contain a complete Linux machine profile")
  }
  const encodedMachineProfile = JSON.stringify(machineProfile)
  reports.forEach((report, index) => {
    if (report.version !== 2)
      throw new Error(`Switch ${index + 1} has an unsupported report version`)
    if (report.fixtureId !== fixtureId)
      throw new Error("All switch reports must use the same fixture")
    if (report.session !== session)
      throw new Error(`Switch ${index + 1} belongs to another session`)
    if (report.switchIndex !== index + 1)
      throw new Error(`Switch ${index + 1} has mismatched identity`)
    if (report.platform !== platform)
      throw new Error("All switch reports must use the same platform")
    if (report.diffdashCommit !== diffdashCommit)
      throw new Error("All switch reports must use the same DiffDash commit")
    if (JSON.stringify(report.machineProfile) !== encodedMachineProfile) {
      throw new Error("All switch reports must use the same machine profile")
    }
    if (
      report.fixtureManifest?.id !== fixtureId ||
      !/^[a-f0-9]{40}$/u.test(String(report.fixtureManifest?.baseSha)) ||
      !/^[a-f0-9]{40}$/u.test(String(report.fixtureManifest?.headSha))
    ) {
      throw new Error(`Switch ${index + 1} is not pinned to its fixture manifest`)
    }
    if (report.steadyWindow?.reached !== true) {
      throw new Error(`Switch ${index + 1} did not reach its complete steady window`)
    }
    if (
      report.durationMs !== REPOSITORY_SCALE_MEASUREMENT_POLICY.durationMs ||
      report.intervalMs !== REPOSITORY_SCALE_MEASUREMENT_POLICY.intervalMs ||
      report.steadyWindow?.windowMs !== REPOSITORY_SCALE_MEASUREMENT_POLICY.plateauWindowMs ||
      report.steadyWindow?.threshold !== REPOSITORY_SCALE_MEASUREMENT_POLICY.plateauThreshold
    ) {
      throw new Error(`Switch ${index + 1} did not use the approved measurement policy`)
    }
    if (!Number.isFinite(report.totalFinalRssBytes) || report.totalFinalRssBytes <= 0) {
      throw new Error(`Switch ${index + 1} has invalid final memory`)
    }
  })
  return { diffdashCommit, fixtureId, machineProfile, platform }
}

/** Samples one process tree and evaluates its final-window memory plateau. */
export const measureProcessTree = async ({
  rootPid,
  durationMs,
  intervalMs,
  plateauWindowMs,
  plateauThreshold,
  capture = captureProcessTree,
  now = Date.now,
  wait = sleep,
}) => {
  const startedAt = now()
  const entries = []
  const collect = async () => {
    const sample = await capture(rootPid)
    entries.push({ sample, elapsedMs: now() - startedAt })
    if (entries.at(-1).elapsedMs >= durationMs) return
    await wait(intervalMs)
    await collect()
  }
  await collect()
  const samples = entries.map(({ sample }) => sample)
  const totalElapsedMs = entries.at(-1).elapsedMs
  const steadyWindowStart = totalElapsedMs - plateauWindowMs
  const steadySamples = entries
    .filter(({ elapsedMs }) => elapsedMs >= steadyWindowStart)
    .map(({ sample }) => sample)
  const totals = steadySamples.map(totalRss)
  const plateauMinimum = Math.min(...totals)
  const plateauMaximum = Math.max(...totals)
  const plateauMean = totals.reduce((total, value) => total + value, 0) / totals.length
  const plateauVariation = plateauMean === 0 ? 0 : (plateauMaximum - plateauMinimum) / plateauMean
  const finalSample = samples.at(-1)
  return {
    version: 2,
    platform: process.platform,
    rootPid,
    startedAt: samples[0].capturedAt,
    completedAt: samples.at(-1).capturedAt,
    sampleCount: samples.length,
    intervalMs,
    durationMs,
    peaks: Object.fromEntries(
      roles.map((role) => [
        role,
        {
          rssBytes: peakByRole(samples, role, "rssBytes"),
          privateBytes: peakByRole(samples, role, "privateBytes"),
          swapBytes: peakByRole(samples, role, "swapBytes"),
          readBytes: ioDeltaByRole(samples, role, "readBytes"),
          writeBytes: ioDeltaByRole(samples, role, "writeBytes"),
        },
      ]),
    ),
    final: Object.fromEntries(
      roles.map((role) => [
        role,
        {
          rssBytes: finalSample.byRole[role].rssBytes,
          privateBytes: finalSample.byRole[role].privateBytes,
          swapBytes: finalSample.byRole[role].swapBytes,
        },
      ]),
    ),
    totalPeakRssBytes: Math.max(...samples.map(totalRss)),
    totalFinalRssBytes: totalRss(finalSample),
    steadyWindow: {
      windowMs: plateauWindowMs,
      threshold: plateauThreshold,
      variation: plateauVariation,
      reached:
        totalElapsedMs >= plateauWindowMs &&
        steadySamples.length >= 2 &&
        plateauVariation <= plateauThreshold,
    },
  }
}
