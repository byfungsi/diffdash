import { UtcIsoTimestamp } from "@diffdash/domain/domain-scalar"
import {
  type CoreEventHint,
  CoreEventGenerationId,
  CoreEventId,
  CoreEventOperationId,
  CoreEventReason,
  type CoreEventReplayResult,
  CoreEventSchemaVersion,
  CoreEventScopeId,
  CoreEventScopeName,
  CoreEventSequence,
  CoreEventSource,
  CoreEventTopic,
  CoreStateVersion,
  type ApplicationInstanceId,
  type CoreProcessEpoch,
} from "@diffdash/core-rpc"
import { Clock, Context, Effect, Layer, PubSub, Ref, Stream } from "effect"

/** Bounded metadata required to publish one hint after authoritative state commits. */
export interface CoreEventDraft {
  readonly topic: string
  readonly schemaVersion: number
  readonly scopes: ReadonlyArray<{ readonly name: string; readonly id: string }>
  readonly source: string
  readonly reason: string
  readonly subject:
    | { readonly kind: "none" }
    | { readonly kind: "generation"; readonly generationId: string }
    | { readonly kind: "operation"; readonly operationId: string }
    | {
        readonly kind: "generationOperation"
        readonly generationId: string
        readonly operationId: string
      }
  readonly kind: CoreEventHint["kind"]
  readonly stateVersion: number
}

/** Core-owned hint publication and bounded reconnect replay. */
export class CoreEventHub extends Context.Service<
  CoreEventHub,
  {
    readonly publish: (draft: CoreEventDraft) => Effect.Effect<CoreEventHint>
    readonly replay: (
      processEpoch: CoreProcessEpoch,
      afterSequence: CoreEventSequence | null,
    ) => Effect.Effect<CoreEventReplayResult>
    readonly events: Stream.Stream<CoreEventHint>
  }
>()("@diffdash/core/CoreEventHub") {}

/** Builds one process-epoch event hub with hint-only sliding publication and bounded replay. */
export const makeCoreEventHubLayer = (options: {
  readonly applicationInstanceId: ApplicationInstanceId
  readonly processEpoch: CoreProcessEpoch
  readonly replayCapacity?: number
}) =>
  Layer.effect(
    CoreEventHub,
    Effect.gen(function* () {
      const replayCapacity = options.replayCapacity ?? 256
      const sequence = yield* Ref.make(0)
      const retained = yield* Ref.make<readonly CoreEventHint[]>([])
      const pubsub = yield* PubSub.sliding<CoreEventHint>(replayCapacity)

      const publish = Effect.fn("CoreEventHub.publish")(function* (draft: CoreEventDraft) {
        const nextSequence = yield* Ref.updateAndGet(sequence, (value) => value + 1)
        const now = yield* Clock.currentTimeMillis
        const hint: CoreEventHint = {
          metadata: {
            eventId: CoreEventId.make(`${options.processEpoch}:${nextSequence}`),
            topic: CoreEventTopic.make(draft.topic),
            schemaVersion: CoreEventSchemaVersion.make(draft.schemaVersion),
            applicationInstanceId: options.applicationInstanceId,
            processEpoch: options.processEpoch,
            sequence: CoreEventSequence.make(nextSequence),
            timestamp: UtcIsoTimestamp.make(new Date(now).toISOString()),
            scopes: draft.scopes.map(({ name, id }) => ({
              name: CoreEventScopeName.make(name),
              id: CoreEventScopeId.make(id),
            })),
            source: CoreEventSource.make(draft.source),
            reason: CoreEventReason.make(draft.reason),
            subject:
              draft.subject.kind === "generation"
                ? {
                    kind: "generation",
                    generationId: CoreEventGenerationId.make(draft.subject.generationId),
                  }
                : draft.subject.kind === "operation"
                  ? {
                      kind: "operation",
                      operationId: CoreEventOperationId.make(draft.subject.operationId),
                    }
                  : draft.subject.kind === "generationOperation"
                    ? {
                        kind: "generationOperation",
                        generationId: CoreEventGenerationId.make(draft.subject.generationId),
                        operationId: CoreEventOperationId.make(draft.subject.operationId),
                      }
                    : { kind: "none" },
          },
          kind: draft.kind,
          stateVersion: CoreStateVersion.make(draft.stateVersion),
        }
        yield* Ref.update(retained, (events) => [...events, hint].slice(-replayCapacity))
        yield* PubSub.publish(pubsub, hint)
        return hint
      })

      const replay = (processEpoch: CoreProcessEpoch, afterSequence: CoreEventSequence | null) =>
        Ref.get(retained).pipe(
          Effect.map((events): CoreEventReplayResult => {
            if (processEpoch !== options.processEpoch) {
              return {
                kind: "resyncRequired",
                processEpoch: options.processEpoch,
                reason: "epochChanged",
              }
            }
            if (afterSequence === null) {
              return {
                kind: "resyncRequired",
                processEpoch: options.processEpoch,
                reason: "firstConnection",
              }
            }
            const oldest = events[0]?.metadata.sequence
            if (oldest !== undefined && afterSequence < oldest - 1) {
              return {
                kind: "resyncRequired",
                processEpoch: options.processEpoch,
                reason: "cursorExpired",
              }
            }
            return {
              kind: "replay",
              processEpoch: options.processEpoch,
              events: events.filter((event) => event.metadata.sequence > afterSequence),
            }
          }),
        )

      return CoreEventHub.of({ publish, replay, events: Stream.fromPubSub(pubsub) })
    }),
  )
