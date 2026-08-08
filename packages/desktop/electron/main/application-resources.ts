import type { DesktopUpdater } from "../../src/main/services/app-updater"
import type { ApplicationRuntime } from "./application-runtime"
import { Effect } from "effect"

/** Releases Electron-owned and Core-owned resources even when either cleanup fails. */
export const disposeApplicationResources = async (
  updater: Pick<DesktopUpdater, "dispose">,
  runtime: Pick<ApplicationRuntime, "dispose">,
): Promise<void> => {
  const results = await Promise.allSettled([
    Effect.runPromise(updater.dispose()),
    runtime.dispose(),
  ])
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  )
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(failures, "DiffDash could not release application resources.")
  }
}
