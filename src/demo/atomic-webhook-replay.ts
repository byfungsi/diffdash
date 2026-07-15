import { Effect } from "effect"

import initialDiff from "../../demo/scenarios/atomic-webhook-replay/revisions/01-initial/unified.diff?raw"
import initialWalkthrough from "../../demo/scenarios/atomic-webhook-replay/revisions/01-initial/walkthrough.json?raw"
import databaseClockDiff from "../../demo/scenarios/atomic-webhook-replay/revisions/02-database-clock/unified.diff?raw"
import databaseClockWalkthrough from "../../demo/scenarios/atomic-webhook-replay/revisions/02-database-clock/walkthrough.json?raw"
import manifestSource from "../../demo/scenarios/atomic-webhook-replay/scenario.json?raw"
import {
  decodeDemoJson,
  DemoScenarioManifest,
  DemoWalkthroughSource,
  materializeDemoScenario,
} from "./demo-scenario"

/** Loads and validates the flagship atomic webhook replay demo scenario. */
export const loadAtomicWebhookReplayScenario = Effect.gen(function* () {
  const manifest = yield* decodeDemoJson(
    "atomic-webhook-replay",
    "scenario.json",
    DemoScenarioManifest,
    manifestSource,
  )
  const firstWalkthrough = yield* decodeDemoJson(
    manifest.id,
    "revisions/01-initial/walkthrough.json",
    DemoWalkthroughSource,
    initialWalkthrough,
  )
  const secondWalkthrough = yield* decodeDemoJson(
    manifest.id,
    "revisions/02-database-clock/walkthrough.json",
    DemoWalkthroughSource,
    databaseClockWalkthrough,
  )

  return yield* materializeDemoScenario(manifest, {
    diffs: {
      "revisions/01-initial/unified.diff": initialDiff,
      "revisions/02-database-clock/unified.diff": databaseClockDiff,
    },
    walkthroughs: {
      "revisions/01-initial/walkthrough.json": firstWalkthrough,
      "revisions/02-database-clock/walkthrough.json": secondWalkthrough,
    },
  })
})
