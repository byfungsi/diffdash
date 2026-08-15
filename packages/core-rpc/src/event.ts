import { PositiveInteger, UtcIsoTimestamp } from "@diffdash/domain/domain-scalar"
import { Schema } from "effect"

import {
  ApplicationInstanceId,
  CoreCommandId,
  CoreEventId,
  CoreProcessEpoch,
  HostRequestContext,
} from "./identity"

const BoundedEventToken = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(100)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)),
)

const BoundedEventReference = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(512)),
  Schema.check(
    Schema.makeFilter(
      (value) =>
        Array.from(value).every((character) => {
          const codePoint = character.codePointAt(0)
          return codePoint !== undefined && codePoint >= 0x20 && codePoint !== 0x7f
        }),
      { message: "Expected a Core event reference without control characters" },
    ),
  ),
)

/** Typed event family name refined to literals by concrete event contracts. */
export const CoreEventTopic = BoundedEventToken.pipe(Schema.brand("CoreEventTopic"))

/** Typed event family name refined to literals by concrete event contracts. */
export type CoreEventTopic = typeof CoreEventTopic.Type

/** Positive schema revision for one event topic. */
export const CoreEventSchemaVersion = PositiveInteger.pipe(Schema.brand("CoreEventSchemaVersion"))

/** Positive schema revision for one event topic. */
export type CoreEventSchemaVersion = typeof CoreEventSchemaVersion.Type

/** Monotonic event cursor within one Core process epoch. */
export const CoreEventSequence = PositiveInteger.pipe(Schema.brand("CoreEventSequence"))

/** Monotonic event cursor within one Core process epoch. */
export type CoreEventSequence = typeof CoreEventSequence.Type

/** Name of one bounded event scope dimension. */
export const CoreEventScopeName = BoundedEventToken.pipe(Schema.brand("CoreEventScopeName"))

/** Name of one bounded event scope dimension. */
export type CoreEventScopeName = typeof CoreEventScopeName.Type

/** Identity selected by one bounded event scope dimension. */
export const CoreEventScopeId = BoundedEventReference.pipe(Schema.brand("CoreEventScopeId"))

/** Identity selected by one bounded event scope dimension. */
export type CoreEventScopeId = typeof CoreEventScopeId.Type

/** One typed scope key carried by an event hint. */
export const CoreEventScope = Schema.Struct({
  name: CoreEventScopeName,
  id: CoreEventScopeId,
}).annotate({ identifier: "CoreEventScope" })

/** One typed scope key carried by an event hint. */
export type CoreEventScope = typeof CoreEventScope.Type

/** Bounded event scopes with at most one identity per scope dimension. */
export const CoreEventScopes = Schema.Array(CoreEventScope).pipe(
  Schema.check(Schema.isMaxLength(8)),
  Schema.check(
    Schema.makeFilter(
      (scopes) => new Set(scopes.map((scope) => scope.name)).size === scopes.length,
      { message: "Expected unique Core event scope names" },
    ),
  ),
)

/** Bounded event scopes with at most one identity per scope dimension. */
export type CoreEventScopes = typeof CoreEventScopes.Type

/** Machine-safe component that originated an event. */
export const CoreEventSource = BoundedEventToken.pipe(Schema.brand("CoreEventSource"))

/** Machine-safe component that originated an event. */
export type CoreEventSource = typeof CoreEventSource.Type

/** Machine-safe reason for publishing an event. */
export const CoreEventReason = BoundedEventToken.pipe(Schema.brand("CoreEventReason"))

/** Machine-safe reason for publishing an event. */
export type CoreEventReason = typeof CoreEventReason.Type

/** Cross-family generation identity retained as an opaque bounded event reference. */
export const CoreEventGenerationId = BoundedEventReference.pipe(
  Schema.brand("CoreEventGenerationId"),
)

/** Cross-family generation identity retained as an opaque bounded event reference. */
export type CoreEventGenerationId = typeof CoreEventGenerationId.Type

/** Cross-family durable operation identity retained as an opaque bounded event reference. */
export const CoreEventOperationId = BoundedEventReference.pipe(Schema.brand("CoreEventOperationId"))

/** Cross-family durable operation identity retained as an opaque bounded event reference. */
export type CoreEventOperationId = typeof CoreEventOperationId.Type

/** Explicit generation and operation correlation carried by an event. */
export const CoreEventSubject = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("generation"),
    generationId: CoreEventGenerationId,
  }),
  Schema.Struct({
    kind: Schema.Literal("operation"),
    operationId: CoreEventOperationId,
  }),
  Schema.Struct({
    kind: Schema.Literal("generationOperation"),
    generationId: CoreEventGenerationId,
    operationId: CoreEventOperationId,
  }),
]).annotate({ identifier: "CoreEventSubject" })

/** Explicit generation and operation correlation carried by an event. */
export type CoreEventSubject = typeof CoreEventSubject.Type

/** Shared metadata for bounded Core event hints and state notifications. */
export const CoreEventMetadata = Schema.Struct({
  eventId: CoreEventId,
  topic: CoreEventTopic,
  schemaVersion: CoreEventSchemaVersion,
  applicationInstanceId: ApplicationInstanceId,
  processEpoch: CoreProcessEpoch,
  sequence: CoreEventSequence,
  timestamp: UtcIsoTimestamp,
  scopes: CoreEventScopes,
  source: CoreEventSource,
  reason: CoreEventReason,
  subject: CoreEventSubject,
}).annotate({ identifier: "CoreEventMetadata" })

/** Shared metadata for bounded Core event hints and state notifications. */
export type CoreEventMetadata = typeof CoreEventMetadata.Type

/** Monotonic committed state version referenced by hints without embedding authoritative state. */
export const CoreStateVersion = PositiveInteger.pipe(Schema.brand("CoreStateVersion"))

/** Monotonic committed state version referenced by hints without embedding authoritative state. */
export type CoreStateVersion = typeof CoreStateVersion.Type

/** Hint-only event envelope. Authoritative state and terminal artifacts are always queried. */
export const CoreEventHint = Schema.Struct({
  metadata: CoreEventMetadata,
  kind: Schema.Literals([
    "stateChanged",
    "operationProgress",
    "operationTerminal",
    "commandCommitted",
  ]),
  stateVersion: CoreStateVersion,
}).annotate({ identifier: "CoreEventHint" })

/** Hint-only event envelope. Authoritative state and terminal artifacts are always queried. */
export type CoreEventHint = typeof CoreEventHint.Type

/** Last event observed by a reconnecting host, or null when this is its first connection. */
export const CoreEventReplayRequest = Schema.Struct({
  context: HostRequestContext,
  afterSequence: Schema.NullOr(CoreEventSequence),
}).annotate({ identifier: "CoreEventReplayRequest" })

/** Last event observed by a reconnecting host, or null when this is its first connection. */
export type CoreEventReplayRequest = typeof CoreEventReplayRequest.Type

/** Bounded replay when retained, otherwise an explicit instruction to query authoritative state. */
export const CoreEventReplayResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("replay"),
    processEpoch: CoreProcessEpoch,
    events: Schema.Array(CoreEventHint).pipe(Schema.check(Schema.isMaxLength(256))),
  }),
  Schema.Struct({
    kind: Schema.Literal("resyncRequired"),
    processEpoch: CoreProcessEpoch,
    reason: Schema.Literals(["firstConnection", "epochChanged", "cursorExpired", "sequenceGap"]),
  }),
]).annotate({ identifier: "CoreEventReplayResult" })

/** Bounded replay when retained, otherwise an explicit instruction to query authoritative state. */
export type CoreEventReplayResult = typeof CoreEventReplayResult.Type

/** Durable command lifecycle persisted before any corresponding event hint is published. */
export const CoreCommandState = Schema.Literals(["accepted", "committed", "failed", "acknowledged"])

/** Durable command lifecycle persisted before any corresponding event hint is published. */
export type CoreCommandState = typeof CoreCommandState.Type

/** Plain durable command receipt returned after the acceptance row commits. */
export const CoreCommandReceipt = Schema.Struct({
  commandId: CoreCommandId,
  processEpoch: CoreProcessEpoch,
  state: CoreCommandState,
  stateVersion: CoreStateVersion,
  acceptedAt: UtcIsoTimestamp,
}).annotate({ identifier: "CoreCommandReceipt" })

/** Plain durable command receipt returned after the acceptance row commits. */
export type CoreCommandReceipt = typeof CoreCommandReceipt.Type

/** Host acknowledgement for a committed terminal command version. */
export const CoreCommandAcknowledgement = Schema.Struct({
  context: HostRequestContext,
  commandId: CoreCommandId,
  stateVersion: CoreStateVersion,
}).annotate({ identifier: "CoreCommandAcknowledgement" })

/** Host acknowledgement for a committed terminal command version. */
export type CoreCommandAcknowledgement = typeof CoreCommandAcknowledgement.Type

/** Bounded privacy-safe metadata retained with an authoritative durable command. */
export const CoreCommandMetadata = Schema.Struct({
  name: BoundedEventToken,
  scope: Schema.NullOr(
    Schema.Struct({
      name: BoundedEventToken,
      id: BoundedEventReference,
    }),
  ),
}).annotate({ identifier: "CoreCommandMetadata" })

/** Bounded privacy-safe metadata retained with an authoritative durable command. */
export type CoreCommandMetadata = typeof CoreCommandMetadata.Type

/** Authoritative durable command state returned by query and acknowledgement RPCs. */
export const CoreCommandSnapshot = Schema.Struct({
  commandId: CoreCommandId,
  processEpoch: CoreProcessEpoch,
  metadata: CoreCommandMetadata,
  state: CoreCommandState,
  stateVersion: CoreStateVersion,
  acceptedAt: UtcIsoTimestamp,
  terminalAt: Schema.NullOr(UtcIsoTimestamp),
  acknowledgedAt: Schema.NullOr(UtcIsoTimestamp),
}).annotate({ identifier: "CoreCommandSnapshot" })

/** Authoritative durable command state returned by query and acknowledgement RPCs. */
export type CoreCommandSnapshot = typeof CoreCommandSnapshot.Type

/** Query for one durable command by stable command identity. */
export const CoreCommandQueryRequest = Schema.Struct({
  context: HostRequestContext,
  commandId: CoreCommandId,
}).annotate({ identifier: "CoreCommandQueryRequest" })

/** Query for one durable command by stable command identity. */
export type CoreCommandQueryRequest = typeof CoreCommandQueryRequest.Type

/** Authoritative command lookup result without treating absence as transport failure. */
export const CoreCommandQueryResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("found"), command: CoreCommandSnapshot }),
  Schema.Struct({ kind: Schema.Literal("notFound"), commandId: CoreCommandId }),
]).annotate({ identifier: "CoreCommandQueryResult" })

/** Authoritative command lookup result without treating absence as transport failure. */
export type CoreCommandQueryResult = typeof CoreCommandQueryResult.Type

/** Bounded query for terminal commands that still require host acknowledgement. */
export const CoreCommandListRequest = Schema.Struct({
  context: HostRequestContext,
  limit: PositiveInteger.pipe(Schema.check(Schema.isLessThanOrEqualTo(256))),
}).annotate({ identifier: "CoreCommandListRequest" })

/** Bounded query for terminal commands that still require host acknowledgement. */
export type CoreCommandListRequest = typeof CoreCommandListRequest.Type

/** Bounded authoritative terminal command page used after reconnect or renderer reload. */
export const CoreCommandListResult = Schema.Array(CoreCommandSnapshot).pipe(
  Schema.check(Schema.isMaxLength(256)),
)

/** Bounded authoritative terminal command page used after reconnect or renderer reload. */
export type CoreCommandListResult = typeof CoreCommandListResult.Type

/** Stable source-safe failure returned by event replay and durable command RPCs. */
export const CoreStateDeliveryFailure = Schema.TaggedStruct("CoreStateDeliveryFailure", {
  method: Schema.Literals([
    "CoreEvents.replay",
    "CoreCommands.get",
    "CoreCommands.listUnacknowledged",
    "CoreCommands.acknowledge",
  ]),
  applicationInstanceId: ApplicationInstanceId,
  processEpoch: CoreProcessEpoch,
  requestId: HostRequestContext.fields.requestId,
  commandId: Schema.NullOr(CoreCommandId),
  code: Schema.Literals([
    "CORE_REQUEST_IDENTITY_MISMATCH",
    "CORE_LIFECYCLE_REJECTED",
    "CORE_RPC_CAPACITY_EXCEEDED",
    "REQUEST_TOO_LARGE",
    "RESPONSE_TOO_LARGE",
    "REQUEST_DEADLINE_EXCEEDED",
    "CORE_COMMAND_ACKNOWLEDGEMENT_REJECTED",
    "CORE_STATE_DELIVERY_FAILED",
  ]),
  retryClass: Schema.Literals(["automatic", "userAction", "notRetryable"]),
  safeMessage: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(240)),
  ),
}).annotate({ identifier: "CoreStateDeliveryFailure" })

/** Stable source-safe failure returned by event replay and durable command RPCs. */
export type CoreStateDeliveryFailure = typeof CoreStateDeliveryFailure.Type
