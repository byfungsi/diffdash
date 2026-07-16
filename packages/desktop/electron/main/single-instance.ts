import { app } from "electron"
import { parseCliNavigationCommand } from "./cli-navigation"

/** Acquires the app instance lock and forwards subsequent CLI invocations. */
export const installSingleInstanceHandling = ({
  enqueue,
  revealExistingWindow,
}: {
  readonly enqueue: (command: NonNullable<ReturnType<typeof parseCliNavigationCommand>>) => void
  readonly revealExistingWindow: () => void
}) => {
  const acquired =
    process.env.DIFFDASH_ALLOW_MULTIPLE_INSTANCES === "1" || app.requestSingleInstanceLock()
  if (!acquired) return false

  const initialCommand = parseCliNavigationCommand(process.argv, process.cwd())
  if (initialCommand !== null) enqueue(initialCommand)

  app.on("second-instance", (_event, argv, cwd) => {
    const command = parseCliNavigationCommand(argv, cwd)
    if (command === null) revealExistingWindow()
    else enqueue(command)
  })
  return true
}
