import { execFile } from "node:child_process"
import { lstat, readFile, readdir, statfs } from "node:fs/promises"
import { arch, cpus, platform as osPlatform, release, totalmem } from "node:os"
import { dirname } from "node:path"
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

/** Captures path-free disk ownership and capacity for one repository-scale sample. */
export const measureManagedStorage = async ({
  databasePath,
  snapshotBlocksRoot,
  snapshotSpoolsRoot,
  worktreePoolRoot,
  remoteWorktreePoolRoot,
}) => {
  const [
    databaseBytes,
    snapshotTreeBytes,
    snapshotSpoolBytes,
    worktreePoolBytes,
    remoteWorktreePoolBytes,
    filesystem,
  ] = await Promise.all([
    databaseFamilyBytes(databasePath),
    optionalTreeBytes(snapshotBlocksRoot),
    optionalTreeBytes(snapshotSpoolsRoot),
    optionalTreeBytes(worktreePoolRoot),
    optionalTreeBytes(remoteWorktreePoolRoot),
    statfs(dirname(databasePath), { bigint: true }),
  ])
  if (snapshotSpoolBytes > snapshotTreeBytes) {
    throw new Error("Snapshot spool bytes exceed the owning snapshot root")
  }
  const snapshotBlockBytes = snapshotTreeBytes - snapshotSpoolBytes
  return {
    databaseBytes,
    managedBytes: snapshotTreeBytes + worktreePoolBytes + remoteWorktreePoolBytes,
    managedRoots: {
      snapshotBlockBytes,
      snapshotSpoolBytes,
      worktreePoolBytes,
      remoteWorktreePoolBytes,
    },
    filesystemFreeBytes: safeBytes(filesystem.bavail * filesystem.bsize),
    filesystemTotalBytes: safeBytes(filesystem.blocks * filesystem.bsize),
  }
}

const optionalTreeBytes = (path) =>
  treeBytes(path).catch((error) => {
    if (error?.code === "ENOENT") return 0
    throw error
  })

const databaseFamilyBytes = async (databasePath) => {
  const sizes = await Promise.all([
    entryBytes(databasePath),
    optionalEntryBytes(`${databasePath}-wal`),
    optionalEntryBytes(`${databasePath}-shm`),
    optionalEntryBytes(`${databasePath}-journal`),
  ])
  return sizes.reduce((total, size) => total + size, 0)
}

const optionalEntryBytes = (path) =>
  entryBytes(path).catch((error) => {
    if (error?.code === "ENOENT") return 0
    throw error
  })

const entryBytes = async (path) => {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink()) throw new Error("Managed storage path must not be a symlink")
  return metadata.isFile() ? metadata.size : 0
}

const treeBytes = async (root) => {
  const pending = [root]
  let bytes = 0
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    // Sequential traversal avoids an unbounded promise set on repository-scale cache trees.
    // eslint-disable-next-line no-await-in-loop
    const metadata = await lstat(current)
    if (metadata.isSymbolicLink()) throw new Error("Managed storage tree contains a symlink")
    if (metadata.isFile()) {
      bytes += metadata.size
      continue
    }
    if (!metadata.isDirectory()) continue
    // eslint-disable-next-line no-await-in-loop
    const entries = await readdir(current)
    for (const entry of entries) pending.push(`${current}/${entry}`)
  }
  return bytes
}

const safeBytes = (value) => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Filesystem byte count is outside the reportable range")
  }
  return Number(value)
}

const isNonEmptyString = (value) =>
  Object.prototype.toString.call(value) === "[object String]" && value.length > 0

const isLifecycleIdentity = (value) => isNonEmptyString(value) && value.length <= 200

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
  if (
    process.command.includes("diffdash-core") ||
    process.command.includes("core-host") ||
    process.command.includes("core-bun.mjs") ||
    (process.command.includes("--type=utility") &&
      process.command.includes("node.mojom.NodeService"))
  ) {
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
  const appVersion = reports[0]?.appVersion
  const coreHost = reports[0]?.coreHost
  const fixtureManifest = reports[0]?.fixtureManifest
  const packagedArtifactDigest = reports[0]?.packagedArtifactDigest
  const bunVersion = reports[0]?.bunVersion
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
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(String(appVersion))) {
    throw new Error("Switch reports must contain the packaged app version")
  }
  if (coreHost !== "bun" && coreHost !== "utility") {
    throw new Error("Switch reports must identify the selected Core host")
  }
  if (!/^[a-f0-9]{64}$/u.test(String(packagedArtifactDigest))) {
    throw new Error("Switch reports must identify the packaged artifact digest")
  }
  if (coreHost === "bun" && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(String(bunVersion))) {
    throw new Error("Bun switch reports must contain the selected runtime version")
  }
  if (coreHost === "utility" && bunVersion !== null) {
    throw new Error("Utility switch reports must not claim a Bun runtime version")
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
  const encodedFixtureManifest = JSON.stringify(fixtureManifest)
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
    if (report.appVersion !== appVersion)
      throw new Error("All switch reports must use the same app version")
    if (report.coreHost !== coreHost)
      throw new Error("All switch reports must use the same Core host")
    if (report.packagedArtifactDigest !== packagedArtifactDigest)
      throw new Error("All switch reports must use the same packaged artifact")
    if (report.bunVersion !== bunVersion)
      throw new Error("All switch reports must use the same runtime version")
    if (report.packaged !== true)
      throw new Error(`Switch ${index + 1} did not use a packaged application`)
    if (report.disposalComplete !== true)
      throw new Error(`Switch ${index + 1} was captured before disposal completed`)
    if (!validStorageMeasurement(report.storage))
      throw new Error(`Switch ${index + 1} has incomplete managed storage measurements`)
    if (report.scenario !== "pathological" && report.scenario !== "small")
      throw new Error(`Switch ${index + 1} has no recognized scenario`)
    if (index > 0 && report.scenario === reports[index - 1]?.scenario)
      throw new Error(`Switch ${index + 1} did not alternate review scenarios`)
    if (JSON.stringify(report.machineProfile) !== encodedMachineProfile) {
      throw new Error("All switch reports must use the same machine profile")
    }
    if (JSON.stringify(report.fixtureManifest) !== encodedFixtureManifest) {
      throw new Error("All switch reports must use the same fixture manifest")
    }
    if (
      report.fixtureManifest?.id !== fixtureId ||
      !/^[a-f0-9]{40}$/u.test(String(report.fixtureManifest?.baseSha)) ||
      !/^[a-f0-9]{40}$/u.test(String(report.fixtureManifest?.headSha)) ||
      !/^[a-f0-9]{40}$/u.test(String(report.fixtureManifest?.revisionSha)) ||
      report.fixtureManifest?.version !== 2 ||
      report.fixtureManifest?.kind !== "synthetic-repository-scale"
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
    if (
      report.coreIdentity?.host !== coreHost ||
      report.coreIdentity?.session !== session ||
      report.coreIdentity?.switchIndex !== index + 1 ||
      !isLifecycleIdentity(report.coreIdentity?.reviewSessionId)
    ) {
      throw new Error(`Switch ${index + 1} has incomplete Core host/session/switch identity`)
    }
    for (const role of ["electron", "renderer", "coreWorker"]) {
      const sample = report.final?.[role]
      const peak = report.peaks?.[role]
      if (
        !Number.isSafeInteger(sample?.processCount) ||
        sample.processCount < 1 ||
        !Number.isSafeInteger(sample.rssBytes) ||
        sample.rssBytes <= 0 ||
        !Number.isSafeInteger(sample.privateBytes) ||
        sample.privateBytes < 0 ||
        !Number.isSafeInteger(sample.swapBytes) ||
        sample.swapBytes < 0 ||
        !Number.isSafeInteger(peak?.readBytes) ||
        peak.readBytes < 0 ||
        !Number.isSafeInteger(peak?.writeBytes) ||
        peak.writeBytes < 0
      ) {
        throw new Error(`Switch ${index + 1} has incomplete Linux ${role} process evidence`)
      }
    }
  })
  return {
    appVersion,
    bunVersion,
    coreHost,
    diffdashCommit,
    fixtureId,
    fixtureManifest,
    machineProfile,
    packagedArtifactDigest,
    platform,
  }
}

const validStorageMeasurement = (storage) => {
  const snapshots = [storage?.before, storage?.after]
  return (
    snapshots.every(
      (snapshot) =>
        Number.isSafeInteger(snapshot?.databaseBytes) &&
        snapshot.databaseBytes >= 0 &&
        Number.isSafeInteger(snapshot.managedBytes) &&
        snapshot.managedBytes >= 0 &&
        [
          snapshot?.managedRoots?.snapshotBlockBytes,
          snapshot?.managedRoots?.snapshotSpoolBytes,
          snapshot?.managedRoots?.worktreePoolBytes,
          snapshot?.managedRoots?.remoteWorktreePoolBytes,
        ].every((value) => Number.isSafeInteger(value) && value >= 0) &&
        snapshot.managedBytes ===
          snapshot.managedRoots.snapshotBlockBytes +
            snapshot.managedRoots.snapshotSpoolBytes +
            snapshot.managedRoots.worktreePoolBytes +
            snapshot.managedRoots.remoteWorktreePoolBytes &&
        Number.isSafeInteger(snapshot.filesystemFreeBytes) &&
        snapshot.filesystemFreeBytes >= 0 &&
        Number.isSafeInteger(snapshot.filesystemTotalBytes) &&
        snapshot.filesystemTotalBytes >= snapshot.filesystemFreeBytes,
    ) &&
    Number.isSafeInteger(storage?.databaseDeltaBytes) &&
    Number.isSafeInteger(storage?.managedDeltaBytes) &&
    Number.isSafeInteger(storage?.freeSpaceDeltaBytes)
  )
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
    samples: entries.map(({ elapsedMs, sample }) => ({
      elapsedMs,
      capturedAt: sample.capturedAt,
      byRole: sample.byRole,
    })),
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
          processCount: finalSample.byRole[role].processCount,
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
