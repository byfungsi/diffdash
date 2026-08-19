import { NonNegativeInteger } from "@diffdash/domain/domain-scalar"
import { Schema } from "effect"

const LifecycleIdentity = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(200)),
)

/** Packaged-E2E evidence for Core-owned review acquisition and foreground session lifecycles. */
export const E2eReviewLifecycleDiagnostics = Schema.Struct({
  acquisitions: Schema.Struct({
    activeOperationIds: Schema.Array(LifecycleIdentity),
    started: NonNegativeInteger,
    completed: NonNegativeInteger,
    superseded: NonNegativeInteger,
    drained: NonNegativeInteger,
    failed: NonNegativeInteger,
    lastStartedOperationId: Schema.NullOr(LifecycleIdentity),
    lastSupersededOperationId: Schema.NullOr(LifecycleIdentity),
    lastDrainedOperationId: Schema.NullOr(LifecycleIdentity),
  }),
  sessions: Schema.Struct({
    activeSessionId: Schema.NullOr(LifecycleIdentity),
    opened: NonNegativeInteger,
    disposed: NonNegativeInteger,
    lastDisposedSessionId: Schema.NullOr(LifecycleIdentity),
  }),
})

/** Packaged-E2E evidence for Core-owned review acquisition and foreground session lifecycles. */
export type E2eReviewLifecycleDiagnostics = typeof E2eReviewLifecycleDiagnostics.Type

/** Result of arming the deterministic next-acquisition supersession hold. */
export const E2eReviewLifecycleHold = Schema.Struct({ armed: Schema.Boolean })

/** Result of arming the deterministic next-acquisition supersession hold. */
export type E2eReviewLifecycleHold = typeof E2eReviewLifecycleHold.Type
