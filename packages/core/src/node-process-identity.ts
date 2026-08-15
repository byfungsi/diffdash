import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { Effect, Schema } from "effect"

import type {
  DatabaseOwner,
  DatabaseOwnerInspector,
} from "@diffdash/persistence/database-ownership"

/** Failure to derive an operating-system process-start identity safely. */
export class ProcessStartIdentityError extends Schema.TaggedError<ProcessStartIdentityError>()(
  "ProcessStartIdentityError",
  { safeMessage: Schema.Literal("DiffDash could not verify a process identity.") },
) {}

const identityFailure = () =>
  ProcessStartIdentityError.make({ safeMessage: "DiffDash could not verify a process identity." })

/** Reads the stable start identity exposed by macOS or Linux for one live PID. */
export const readProcessStartIdentity = (
  pid: number,
): Effect.Effect<string, ProcessStartIdentityError> =>
  Effect.try({
    try: () => {
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid PID")
      if (process.platform === "linux") {
        const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8")
        const commandEnd = stat.lastIndexOf(") ")
        if (commandEnd < 0) throw new Error("Malformed proc stat")
        const fields = stat
          .slice(commandEnd + 2)
          .trim()
          .split(/\s+/u)
        const startTicks = fields[19]
        if (startTicks === undefined || !/^\d+$/u.test(startTicks)) {
          throw new Error("Missing proc start time")
        }
        return `linux:${startTicks}`
      }
      if (process.platform === "darwin") {
        const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 1_000,
        })
        const startedAt = result.status === 0 ? result.stdout.trim().replace(/\s+/gu, " ") : ""
        if (startedAt.length === 0) throw new Error("Missing process start time")
        return `darwin:${startedAt}`
      }
      throw new Error("Unsupported process platform")
    },
    catch: identityFailure,
  })

/** Inspects a recorded owner without treating uncertainty as proof of death. */
export const nodeDatabaseOwnerInspector: DatabaseOwnerInspector = {
  inspect: (owner: DatabaseOwner) =>
    readProcessStartIdentity(owner.pid).pipe(
      Effect.map((identity) =>
        identity === owner.processStartIdentity ? ("alive" as const) : ("dead" as const),
      ),
      Effect.catch(() =>
        processExists(owner.pid)
          ? Effect.succeed("uncertain" as const)
          : Effect.succeed("dead" as const),
      ),
    ),
}

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return Schema.is(Schema.Struct({ code: Schema.String }))(cause) && cause.code === "EPERM"
  }
}
