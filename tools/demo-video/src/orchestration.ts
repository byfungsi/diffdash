import { combineDemo } from "./combine"
import { startDashboard } from "./dashboard"
import { recordDemo } from "./record"
import { assertDemoSlug } from "./paths"
import { verifyDemo } from "./verify"

/** Callable operations behind the demo command-line entry point. */
export interface DemoCliOperations {
  readonly record: (storyId: string) => Promise<void>
  readonly combine: (storyId: string) => Promise<void>
  readonly verify: (storyId: string) => Promise<void>
  readonly dashboard: () => Promise<void>
}

const operations: DemoCliOperations = {
  record: recordDemo,
  combine: combineDemo,
  verify: verifyDemo,
  dashboard: startDashboard,
}

/** Dispatches one demo command and forwards one validated story ID through orchestration. */
export const runDemoCli = async (arguments_: readonly string[], handlers = operations) => {
  const [command, ...forwarded] = arguments_
  const rest = forwarded[0] === "--" ? forwarded.slice(1) : forwarded
  if (command === "dashboard") {
    if (rest.length !== 0) throw new Error("demo dashboard does not accept a story ID")
    await handlers.dashboard()
    return
  }
  if (
    command !== "record" &&
    command !== "combine" &&
    command !== "video" &&
    command !== "verify"
  ) {
    throw new Error(`Unknown demo command: ${command ?? "<missing>"}`)
  }
  if (rest.length !== 1 || rest[0] === undefined) {
    throw new Error(`demo ${command} requires exactly one story ID`)
  }
  const storyId = assertDemoSlug(rest[0], "story ID")
  if (command === "record") await handlers.record(storyId)
  if (command === "combine") await handlers.combine(storyId)
  if (command === "verify") await handlers.verify(storyId)
  if (command === "video") {
    await handlers.record(storyId)
    await handlers.combine(storyId)
  }
}
