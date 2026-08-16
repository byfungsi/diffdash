import { execFileSync } from "node:child_process"
import { dirname, join, resolve } from "node:path"

/** Supported standalone Core hosts for packaged repository-scale runs. */
export type RepositoryScaleCoreHost = "bun" | "utility"

/** Resolves the unpacked executable emitted by the existing packaged E2E build. */
export const packagedE2eExecutable = (): string => {
  const dist = join(process.cwd(), "../desktop/dist")
  if (process.platform === "darwin") {
    const output = process.arch === "arm64" ? "mac-arm64" : "mac"
    return join(dist, output, "DiffDash.app", "Contents", "MacOS", "DiffDash")
  }
  if (process.platform === "linux") {
    const output = process.arch === "arm64" ? "linux-arm64-unpacked" : "linux-unpacked"
    return join(dist, output, "diffdash-desktop")
  }
  if (process.platform === "win32") {
    const output = process.arch === "arm64" ? "win-arm64-unpacked" : "win-unpacked"
    return join(dist, output, "DiffDash.exe")
  }
  throw new Error(`Unsupported packaged E2E platform: ${process.platform}`)
}

/** Resolves the immutable ASAR payload used to identify one packaged evidence run. */
export const packagedE2eArtifact = (): string => {
  const executable = packagedE2eExecutable()
  if (process.platform === "darwin") {
    return join(resolve(dirname(executable), ".."), "Resources", "app.asar")
  }
  return join(dirname(executable), "resources", "app.asar")
}

type ProcessRow = {
  readonly pid: number
  readonly parentPid: number
  readonly command: string
}

const processRows = (): readonly ProcessRow[] => {
  if (process.platform === "win32") {
    throw new Error("Repository-scale Core host verification is not implemented on Windows")
  }
  return execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line)
      return match === null
        ? []
        : [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] ?? "" }]
    })
}

/** Finds only Core host processes descended from one packaged Electron process. */
export const coreHostProcessIds = (
  rootPid: number,
  host: RepositoryScaleCoreHost,
): readonly number[] => {
  const rows = processRows()
  const descendants = new Set([rootPid])
  let discovered = true
  while (discovered) {
    discovered = false
    for (const row of rows) {
      if (descendants.has(row.parentPid) && !descendants.has(row.pid)) {
        descendants.add(row.pid)
        discovered = true
      }
    }
  }
  return rows.flatMap((row) => {
    if (!descendants.has(row.pid) || row.pid === rootPid) return []
    const selected =
      host === "bun"
        ? row.command.includes("core-bun.mjs") && /(?:^|[\\/\s])bun(?:\s|$)/u.test(row.command)
        : row.command.includes("--type=utility") && row.command.includes("node.mojom.NodeService")
    return selected ? [row.pid] : []
  })
}

/** Checks process liveness without exposing its command line. */
export const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}
