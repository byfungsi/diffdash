import { Effect } from "effect"

import { CoreMethod } from "../core-contract"
import { Analytics } from "../services/analytics"
import type { OperationHandlersFor } from "./operation-handlers"

type AnalyticsMethod = typeof CoreMethod.analyticsCapture | typeof CoreMethod.analyticsStart

/** Acquires analytics handlers for the closed Core operation map. */
export const makeAnalyticsOperationHandlers: Effect.Effect<
  OperationHandlersFor<AnalyticsMethod>,
  never,
  Analytics
> = Effect.gen(function* () {
  const analytics = yield* Analytics

  return {
    [CoreMethod.analyticsCapture]: ({ event }) => analytics.capture(event),
    [CoreMethod.analyticsStart]: () => analytics.start,
  } satisfies OperationHandlersFor<AnalyticsMethod>
})
