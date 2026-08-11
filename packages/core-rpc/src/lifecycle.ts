import { Schema } from "effect"

import { ApplicationInstanceId, CoreProcessEpoch } from "./identity"

/** Observable lifecycle state of one Core process epoch. */
export const CoreLifecycleState = Schema.Literals([
  "starting",
  "awaitingOwnership",
  "recovering",
  "ready",
  "draining",
  "stopped",
  "failed",
])

/** Observable lifecycle state of one Core process epoch. */
export type CoreLifecycleState = typeof CoreLifecycleState.Type

/** Health value used by Electron to verify the launched Core process identity and state. */
export const CoreHealth = Schema.Struct({
  applicationInstanceId: ApplicationInstanceId,
  processEpoch: CoreProcessEpoch,
  lifecycle: CoreLifecycleState,
}).annotate({ identifier: "CoreHealth" })

/** Health value used by Electron to verify the launched Core process identity and state. */
export type CoreHealth = typeof CoreHealth.Type
