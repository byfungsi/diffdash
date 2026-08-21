import { app } from "electron"
import { parseCliNavigationCommand } from "./cli-navigation"

/** Acquires the app instance lock and forwards subsequent CLI invocations. */
export const installSingleInstanceHandling = ({
  allowMultipleInstances,
  enqueue,
  registerReadiness,
  revealExistingWindow,
}: {
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
    const command = parseCliNavigationCommand(argv, cwd)
    if (command === null) revealExistingWindow()
    else enqueue(command)
    registerReadiness(argv)
  })
  return true
}
