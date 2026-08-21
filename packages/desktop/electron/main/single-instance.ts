import { app } from "electron"
import { parseCliNavigationCommand } from "./cli-navigation"

/** Internal argument used by the development launcher to replace a running dev instance. */
export const CLOSE_DEV_INSTANCE_ARGUMENT = "--diffdash-close-dev-instance"

/** Acquires the app instance lock and forwards subsequent CLI invocations. */
export const installSingleInstanceHandling = ({
  allowDevRestart,
  allowMultipleInstances,
  enqueue,
  registerReadiness,
  revealExistingWindow,
}: {
  readonly allowDevRestart: boolean
  readonly allowMultipleInstances: boolean
  readonly enqueue: (command: NonNullable<ReturnType<typeof parseCliNavigationCommand>>) => void
  readonly registerReadiness: (argv: readonly string[]) => void
  readonly revealExistingWindow: () => void
}) => {
  const acquired = allowMultipleInstances || app.requestSingleInstanceLock()
  if (!acquired) return false

  const initialCommand = parseCliNavigationCommand(process.argv, process.cwd())
  if (initialCommand !== null) enqueue(initialCommand)
  registerReadiness(process.argv)

  app.on("second-instance", (_event, argv, cwd) => {
    if (allowDevRestart && argv.includes(CLOSE_DEV_INSTANCE_ARGUMENT)) {
      app.quit()
      return
    }
    const command = parseCliNavigationCommand(argv, cwd)
    if (command === null) revealExistingWindow()
    else enqueue(command)
    registerReadiness(argv)
  })
  return true
}
