import { accessSync, constants } from "node:fs"
import { delimiter, extname, resolve } from "node:path"

import { defaultExecutablePath } from "./cli"

/** Returns the absolute path to an executable in PATH, or null if it cannot be found. */
export const resolveExecutableInPath = (
  command: string,
  options: {
    readonly envPath?: string
    readonly pathExt?: string
    readonly platform?: NodeJS.Platform
  } = {},
) => {
  const envPath = options.envPath ?? defaultExecutablePath(process.env.PATH ?? "")
  const platform = options.platform ?? process.platform
  const extensions = executableExtensions(command, platform, options.pathExt ?? process.env.PATHEXT)

  for (const directory of envPath.split(delimiter).filter((entry) => entry.length > 0)) {
    for (const extension of extensions) {
      const candidate = resolve(directory, `${command}${extension}`)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Continue searching PATH.
      }
    }
  }

  return null
}

const executableExtensions = (
  command: string,
  platform: NodeJS.Platform,
  pathExt: string | undefined,
) => {
  if (platform !== "win32" || extname(command).length > 0) return [""]
  return [
    "",
    ...(pathExt ?? ".EXE;.CMD;.BAT;.COM").split(";").filter((extension) => extension.length > 0),
  ]
}
