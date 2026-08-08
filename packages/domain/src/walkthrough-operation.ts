import { Schema } from "effect"

import { ReviewKey, ReviewRevision } from "./review-identity"

/** Stable identity for one durable walkthrough operation. */
export const WalkthroughOperationId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(100)),
  Schema.brand("WalkthroughOperationId"),
)

/** Stable identity for one durable walkthrough operation. */
export type WalkthroughOperationId = typeof WalkthroughOperationId.Type

/** Monotonically increasing optimistic-concurrency version for an operation row. */
export const WalkthroughOperationStateVersion = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("WalkthroughOperationStateVersion"),
)

/** Monotonically increasing optimistic-concurrency version for an operation row. */
export type WalkthroughOperationStateVersion = typeof WalkthroughOperationStateVersion.Type

/** Persisted lifecycle states for durable walkthrough generation. */
export const WalkthroughOperationState = Schema.Literals([
  "accepted",
  "running",
  "completed",
  "failed",
  "cancelled",
  "superseded",
  "interrupted",
])

/** Persisted lifecycle states for durable walkthrough generation. */
export type WalkthroughOperationState = typeof WalkthroughOperationState.Type

/** Bounded prompt contract version included in exact operation identity. */
export const WalkthroughOperationPromptVersion = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(100)),
)

/** Bounded prompt contract version included in exact operation identity. */
export type WalkthroughOperationPromptVersion = typeof WalkthroughOperationPromptVersion.Type

const isUtcTimestamp = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

/** Canonical UTC timestamp used by persisted walkthrough operation state. */
export const WalkthroughOperationTimestamp = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(isUtcTimestamp, { message: "Invalid UTC walkthrough operation timestamp" }),
  ),
)

/** Canonical UTC timestamp used by persisted walkthrough operation state. */
export type WalkthroughOperationTimestamp = typeof WalkthroughOperationTimestamp.Type

/** Exact immutable review generation and prompt identity for one operation. */
export class WalkthroughOperationIdentity extends Schema.Class<WalkthroughOperationIdentity>(
  "WalkthroughOperationIdentity",
)({
  repoId: Schema.NonEmptyString,
  reviewKey: ReviewKey,
  baseRevision: ReviewRevision,
  headRevision: ReviewRevision,
  promptVersion: WalkthroughOperationPromptVersion,
}) {}

/** Composite reference to a walkthrough artifact saved in the shared cache. */
export class WalkthroughArtifactReference extends Schema.Class<WalkthroughArtifactReference>(
  "WalkthroughArtifactReference",
)({
  repoId: Schema.NonEmptyString,
  reviewKey: ReviewKey,
  baseRevision: ReviewRevision,
  headRevision: ReviewRevision,
  promptVersion: WalkthroughOperationPromptVersion,
}) {}

/** Closed expected-failure categories safe to retain in shared persistence. */
export const WalkthroughExpectedFailureCategory = Schema.Literals([
  "review-resolution",
  "prompt-preparation",
  "provider",
  "validation",
  "artifact-persistence",
  "operation-persistence",
])

/** Closed expected-failure categories safe to retain in shared persistence. */
export type WalkthroughExpectedFailureCategory = typeof WalkthroughExpectedFailureCategory.Type

/** Bounded symbolic failure code that cannot contain diagnostics or source material. */
export const WalkthroughOperationFailureCode = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(100)),
  Schema.check(Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u)),
)

/** Bounded symbolic failure code that cannot contain diagnostics or source material. */
export type WalkthroughOperationFailureCode = typeof WalkthroughOperationFailureCode.Type

/** Privacy-safe classification of an expected terminal failure. */
export class WalkthroughExpectedFailure extends Schema.Class<WalkthroughExpectedFailure>(
  "WalkthroughExpectedFailure",
)({
  kind: Schema.Literal("expected"),
  category: WalkthroughExpectedFailureCategory,
  code: WalkthroughOperationFailureCode,
}) {}

/** Privacy-safe fixed classification of an unexpected internal failure. */
export class WalkthroughInternalFailure extends Schema.Class<WalkthroughInternalFailure>(
  "WalkthroughInternalFailure",
)({
  kind: Schema.Literal("internal"),
  category: Schema.Literal("internal"),
  code: Schema.Literal("unexpected-defect"),
}) {}

/** Persistable terminal failure data with no arbitrary diagnostic fields. */
export const WalkthroughOperationFailure = Schema.Union([
  WalkthroughExpectedFailure,
  WalkthroughInternalFailure,
])

/** Persistable terminal failure data with no arbitrary diagnostic fields. */
export type WalkthroughOperationFailure = typeof WalkthroughOperationFailure.Type

const commonOperationFields = {
  id: WalkthroughOperationId,
  identity: WalkthroughOperationIdentity,
  stateVersion: WalkthroughOperationStateVersion,
  regenerationOfOperationId: Schema.NullOr(WalkthroughOperationId),
  acceptedAt: WalkthroughOperationTimestamp,
  updatedAt: WalkthroughOperationTimestamp,
}

const AcceptedWalkthroughOperation = Schema.Struct({
  ...commonOperationFields,
  state: Schema.Literal("accepted"),
  startedAt: Schema.Null,
  cancellationRequestedAt: Schema.Null,
  terminalAt: Schema.Null,
  supersededByOperationId: Schema.Null,
  artifact: Schema.Null,
  failure: Schema.Null,
})

const RunningWalkthroughOperation = Schema.Struct({
  ...commonOperationFields,
  state: Schema.Literal("running"),
  startedAt: WalkthroughOperationTimestamp,
  cancellationRequestedAt: Schema.Null,
  terminalAt: Schema.Null,
  supersededByOperationId: Schema.Null,
  artifact: Schema.Null,
  failure: Schema.Null,
})

const CompletedWalkthroughOperation = Schema.Struct({
  ...commonOperationFields,
  state: Schema.Literal("completed"),
  startedAt: WalkthroughOperationTimestamp,
  cancellationRequestedAt: Schema.Null,
  terminalAt: WalkthroughOperationTimestamp,
  supersededByOperationId: Schema.Null,
  artifact: WalkthroughArtifactReference,
  failure: Schema.Null,
})

const FailedWalkthroughOperation = Schema.Struct({
  ...commonOperationFields,
  state: Schema.Literal("failed"),
  startedAt: Schema.NullOr(WalkthroughOperationTimestamp),
  cancellationRequestedAt: Schema.Null,
  terminalAt: WalkthroughOperationTimestamp,
  supersededByOperationId: Schema.Null,
  artifact: Schema.Null,
  failure: WalkthroughOperationFailure,
})

const CancelledWalkthroughOperation = Schema.Struct({
  ...commonOperationFields,
  state: Schema.Literal("cancelled"),
  startedAt: Schema.NullOr(WalkthroughOperationTimestamp),
  cancellationRequestedAt: WalkthroughOperationTimestamp,
  terminalAt: WalkthroughOperationTimestamp,
  supersededByOperationId: Schema.Null,
  artifact: Schema.Null,
  failure: Schema.Null,
})

const SupersededWalkthroughOperation = Schema.Struct({
  ...commonOperationFields,
  state: Schema.Literal("superseded"),
  startedAt: Schema.NullOr(WalkthroughOperationTimestamp),
  cancellationRequestedAt: Schema.Null,
  terminalAt: WalkthroughOperationTimestamp,
  supersededByOperationId: WalkthroughOperationId,
  artifact: Schema.Null,
  failure: Schema.Null,
})

const InterruptedWalkthroughOperation = Schema.Struct({
  ...commonOperationFields,
  state: Schema.Literal("interrupted"),
  startedAt: Schema.NullOr(WalkthroughOperationTimestamp),
  cancellationRequestedAt: Schema.Null,
  terminalAt: WalkthroughOperationTimestamp,
  supersededByOperationId: Schema.Null,
  artifact: Schema.Null,
  failure: Schema.Null,
})

/** Authoritative durable walkthrough operation with state-specific lifecycle fields. */
export const WalkthroughOperation = Schema.Union([
  AcceptedWalkthroughOperation,
  RunningWalkthroughOperation,
  CompletedWalkthroughOperation,
  FailedWalkthroughOperation,
  CancelledWalkthroughOperation,
  SupersededWalkthroughOperation,
  InterruptedWalkthroughOperation,
])

/** Authoritative durable walkthrough operation with state-specific lifecycle fields. */
export type WalkthroughOperation = typeof WalkthroughOperation.Type

/** Result of accepting new work or finding the existing exact operation. */
export class WalkthroughOperationAcceptance extends Schema.Class<WalkthroughOperationAcceptance>(
  "WalkthroughOperationAcceptance",
)({
  created: Schema.Boolean,
  operation: WalkthroughOperation,
}) {}

/** Authoritative result of a guarded lifecycle transition. */
export class WalkthroughOperationTransition extends Schema.Class<WalkthroughOperationTransition>(
  "WalkthroughOperationTransition",
)({
  won: Schema.Boolean,
  operation: WalkthroughOperation,
}) {}
