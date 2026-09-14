import type { HostRequestContext } from "@diffdash/core-rpc/identity"
import { Effect, Schedule } from "effect"

import type { CoreRpcClient } from "./core-rpc-client"
import { CoreStartupReadinessError } from "./desktop-startup-error"

// Recovery includes catalog and filesystem reconciliation on populated profiles, not just a handshake.
const CORE_RECOVERY_TIMEOUT = "60 seconds"

/** Waits for authenticated Core recovery under one deadline, including stalled health RPCs. */
export const waitForCoreReadiness = Effect.fn("waitForCoreReadiness")(
  function* (
    client: Pick<CoreRpcClient["Service"], "health">,
    requestContext: () => HostRequestContext,
  ) {
    const health = yield* client.health(requestContext())
    if (health.lifecycle === "failed" || health.lifecycle === "draining") {
      return yield* CoreStartupReadinessError.make({ reason: health.lifecycle })
    }
    return health.lifecycle === "ready"
  },
  (poll) =>
    poll.pipe(
      Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: (ready) => ready }),
      Effect.timeoutOrElse({
        duration: CORE_RECOVERY_TIMEOUT,
        orElse: () => Effect.fail(CoreStartupReadinessError.make({ reason: "timeout" })),
      }),
      Effect.asVoid,
    ),
)
