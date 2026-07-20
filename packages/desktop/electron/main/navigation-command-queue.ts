import type { CliNavigationCommand } from "@diffdash/protocol/cli-navigation"
import { NAVIGATION_COMMAND_DRAIN_LIMIT } from "@diffdash/protocol/cli-navigation"

/** Maximum CLI navigation commands retained before new commands are refused. */
const NAVIGATION_COMMAND_QUEUE_LIMIT = 128

/** Explicit in-memory navigation queue bounds. */
interface NavigationCommandQueueConfig {
  readonly maxPending: number
  readonly maxDrain: number
}

/** Creates the in-memory FIFO used to retain navigation commands until the renderer drains them. */
export const createNavigationCommandQueue = (
  config: NavigationCommandQueueConfig = {
    maxPending: NAVIGATION_COMMAND_QUEUE_LIMIT,
    maxDrain: NAVIGATION_COMMAND_DRAIN_LIMIT,
  },
) => {
  if (
    !Number.isSafeInteger(config.maxPending) ||
    config.maxPending <= 0 ||
    !Number.isSafeInteger(config.maxDrain) ||
    config.maxDrain <= 0 ||
    config.maxDrain > config.maxPending
  ) {
    throw new Error("Navigation queue bounds must be positive safe integers")
  }
  const pending: CliNavigationCommand[] = []

  return {
    acknowledge: (count: number): void => {
      if (!Number.isSafeInteger(count) || count < 0 || count > config.maxDrain) {
        throw new Error("Navigation acknowledgement exceeds the drain bound")
      }
      pending.splice(0, count)
    },
    enqueue: (command: CliNavigationCommand): boolean => {
      if (pending.length >= config.maxPending) return false
      pending.push(command)
      return true
    },
    hasPending: () => pending.length > 0,
    peek: (): readonly CliNavigationCommand[] => pending.slice(0, config.maxDrain),
  }
}
