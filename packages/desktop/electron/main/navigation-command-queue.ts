import type { CliNavigationCommand } from "../../src/shared/cli-navigation"

/** Creates the in-memory FIFO used to retain navigation commands until the renderer drains them. */
export const createNavigationCommandQueue = () => {
  let pending: CliNavigationCommand[] = []

  return {
    drain: (): readonly CliNavigationCommand[] => {
      const commands = pending
      pending = []
      return commands
    },
    enqueue: (command: CliNavigationCommand) => {
      pending.push(command)
    },
    hasPending: () => pending.length > 0,
  }
}
