import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"

import {
  CoreEventGenerationId,
  CoreEventMetadata,
  CoreEventOperationId,
  CoreEventReason,
  CoreEventSchemaVersion,
  CoreEventScopeId,
  CoreEventScopeName,
  CoreEventSequence,
  CoreEventSource,
  CoreEventTopic,
} from "./event"
import { ApplicationInstanceId, CoreEventId, CoreProcessEpoch } from "./identity"

const metadata = CoreEventMetadata.make({
  eventId: CoreEventId.make("event-1"),
  topic: CoreEventTopic.make("walkthrough.operation.progress"),
  schemaVersion: CoreEventSchemaVersion.make(1),
  applicationInstanceId: ApplicationInstanceId.make("app-1"),
  processEpoch: CoreProcessEpoch.make("epoch-1"),
  sequence: CoreEventSequence.make(7),
  timestamp: "2026-08-15T20:00:00.000Z",
  scopes: [
    {
      name: CoreEventScopeName.make("project"),
      id: CoreEventScopeId.make("project-1"),
    },
    {
      name: CoreEventScopeName.make("review"),
      id: CoreEventScopeId.make("github:fungsi/diffdash#218"),
    },
  ],
  source: CoreEventSource.make("walkthrough-operation"),
  reason: CoreEventReason.make("state-transition"),
  subject: {
    kind: "generationOperation",
    generationId: CoreEventGenerationId.make("generation-1"),
    operationId: CoreEventOperationId.make("operation-1"),
  },
})

describe("Core event metadata", () => {
  it("preserves bounded event identity, cursor, scopes, and durable subject correlation", () => {
    expect(Schema.decodeUnknownSync(CoreEventMetadata)(metadata)).toEqual(metadata)
  })

  it("rejects invalid cursors, timestamps, duplicate scopes, and incomplete subjects", () => {
    expect(
      Result.isFailure(Schema.decodeUnknownResult(CoreEventMetadata)({ ...metadata, sequence: 0 })),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(CoreEventMetadata)({ ...metadata, schemaVersion: 0 }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(CoreEventMetadata)({
          ...metadata,
          scopes: Array.from({ length: 9 }, (_, index) => ({
            name: `scope-${index}`,
            id: `scope/${index}#value`,
          })),
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(CoreEventMetadata)({
          ...metadata,
          subject: { kind: "generation", generationId: "g".repeat(513) },
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(CoreEventMetadata)({
          ...metadata,
          scopes: [{ name: "review", id: "github:fungsi/diffdash#218\nprivate" }],
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(CoreEventMetadata)({
          ...metadata,
          source: "s".repeat(101),
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(CoreEventMetadata)({ ...metadata, timestamp: "not-a-date" }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(CoreEventMetadata)({
          ...metadata,
          scopes: [metadata.scopes[0], metadata.scopes[0]],
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(CoreEventMetadata)({
          ...metadata,
          subject: { kind: "generationOperation", generationId: "generation-1" },
        }),
      ),
    ).toBe(true)
  })

  it("accepts each explicit generation and operation correlation state", () => {
    const subjects = [
      { kind: "none" },
      { kind: "generation", generationId: "generation/1#head" },
      { kind: "operation", operationId: "operation/1#attempt" },
      {
        kind: "generationOperation",
        generationId: "generation/1#head",
        operationId: "operation/1#attempt",
      },
    ] as const

    for (const subject of subjects) {
      expect(
        Result.isSuccess(Schema.decodeUnknownResult(CoreEventMetadata)({ ...metadata, subject })),
      ).toBe(true)
    }
  })

  it("roundtrips as native MessagePack data without custom framing", () => {
    const parser = RpcSerialization.makeMsgPack({ maxBufferSize: 4_096 }).makeUnsafe()
    const encoded = Schema.encodeSync(CoreEventMetadata)(metadata)
    const bytes = parser.encode(encoded)

    expect(bytes).toBeInstanceOf(Uint8Array)
    if (bytes === undefined) throw new Error("Expected Core event metadata MessagePack bytes")
    const [decoded] = parser.decode(bytes)
    expect(Schema.decodeUnknownSync(CoreEventMetadata)(decoded)).toEqual(metadata)
  })
})
