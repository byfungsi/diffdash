import { execFileSync } from "node:child_process"

/** Quotes one argument for readable command logs, not for execution by a POSIX shell. */
export const quoteArgumentForDisplay = (value) =>
  /[^A-Za-z0-9_./:=@-]/u.test(value) ? JSON.stringify(value) : value

/** Formats an argv command for display without including its environment. */
export const formatCommandForDisplay = (command, args) =>
  `$ ${command}${args.length === 0 ? "" : ` ${args.map(quoteArgumentForDisplay).join(" ")}`}`

/** Executes a synchronous command while logging only its executable and arguments. */
export const runSyncCommand = (
  command,
  args,
  { cwd, env = process.env, log = console.log } = {},
) => {
  log(formatCommandForDisplay(command, args))
  return execFileSync(command, args, { cwd, env, stdio: "inherit" })
}

/** Verifies that a required synchronous command can be executed. */
export const assertCommandAvailable = (command, args, { env = process.env } = {}) => {
  try {
    execFileSync(command, args, { env, stdio: "ignore" })
  } catch {
    throw new Error(`Required command is not available or failed: ${command}`)
  }
}

/** Returns whether a synchronous command exits successfully. */
export const commandSucceeds = (command, args, { env = process.env } = {}) => {
  try {
    execFileSync(command, args, { env, stdio: "ignore" })
    return true
  } catch {
    return false
  }
}
