import { lstatSync, type Stats, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute } from "node:path"

const CLI_READY_ARGUMENT_PREFIX = "--diffdash-cli-ready-v1="
const CLI_READY_DIRECTORY_PATTERN = /^diffdash-cli\.[A-Za-z0-9]+$/

const parseCliReadyPath = (argv: readonly string[]): string | null => {
  const argument = argv.find((value) => value.startsWith(CLI_READY_ARGUMENT_PREFIX))
  if (argument === undefined) return null

  const path = argument.slice(CLI_READY_ARGUMENT_PREFIX.length)
  const directory = dirname(path)
  let directoryStat: Stats
  try {
    directoryStat = lstatSync(directory)
  } catch {
    return null
  }
  const currentUserId = process.getuid?.()
  if (
    !isAbsolute(path) ||
    basename(path) !== "ready" ||
    !CLI_READY_DIRECTORY_PATTERN.test(basename(directory)) ||
    !directoryStat.isDirectory() ||
    (directoryStat.mode & 0o077) !== 0 ||
    (currentUserId !== undefined && directoryStat.uid !== currentUserId)
  ) {
    return null
  }
  return path
}

const signalReady = (path: string) => {
  try {
    writeFileSync(path, "ready\n", { encoding: "utf8", flag: "wx", mode: 0o600 })
  } catch (error) {
    console.warn(`[cli:readiness] Could not acknowledge ${path}`, error)
  }
}

/** Coordinates private CLI launch acknowledgements with renderer readiness. */
export const createCliReadiness = () => {
  let rendererReady = false
  const pending = new Set<string>()

  return {
    register: (argv: readonly string[]) => {
      const path = parseCliReadyPath(argv)
      if (path === null) return
      if (rendererReady) signalReady(path)
      else pending.add(path)
    },
    rendererLoading: () => {
      rendererReady = false
    },
    rendererLoaded: () => {
      rendererReady = true
      for (const path of pending) signalReady(path)
      pending.clear()
    },
  }
}
