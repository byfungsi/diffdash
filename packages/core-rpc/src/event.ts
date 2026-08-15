import { PositiveInteger, UtcIsoTimestamp } from "@diffdash/domain/domain-scalar"
import { Schema } from "effect"

import { ApplicationInstanceId, CoreEventId, CoreProcessEpoch } from "./identity"

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
