import { access, constants } from "node:fs/promises"
import { delimiter, extname, resolve } from "node:path"
import { Effect, Option, Schema } from "effect"

import { executablePath } from "./subprocess"

/** Absolute path to one executable discovered through an explicit search path. */
export const ExecutablePath = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("ExecutablePath"),
)

/** Absolute path to one executable discovered through an explicit search path. */
export type ExecutablePath = typeof ExecutablePath.Type

/** Options controlling cross-platform executable discovery. */
export interface FindExecutableOptions {
  readonly envPath?: string
  readonly pathExt?: string
  readonly platform?: NodeJS.Platform
}

/** Returns the GUI-safe executable path used by spawned desktop commands. */
export const defaultExecutablePath = executablePath

/** Finds an executable through Effect, returning `None` when no executable candidate is accessible. */
export const findExecutableInPath = Effect.fn("findExecutableInPath")(function* (
  command: string,
  options: FindExecutableOptions = {},
) {
  const envPath = options.envPath ?? executablePath(process.env.PATH ?? "")
  const platform = options.platform ?? process.platform
  const extensions = executableExtensions(command, platform, options.pathExt ?? process.env.PATHEXT)
  const candidates = envPath
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .flatMap((directory) =>
      extensions.map((extension) => resolve(directory, `${command}${extension}`)),
    )

  for (const candidate of candidates) {
    const available = yield* Effect.tryPromise({
      try: () => access(candidate, constants.X_OK),
      catch: () => null,
    }).pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)),
    )
    if (available) return Option.some(ExecutablePath.make(candidate))
  }
  return Option.none<ExecutablePath>()
})

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
