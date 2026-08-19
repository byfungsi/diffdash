import type { E2eReviewLifecycleDiagnostics } from "@diffdash/protocol/e2e-review-lifecycle"
import { Context, Deferred, Effect, Layer, Option, Ref } from "effect"

interface HeldAcquisition {
  readonly generation: string
  readonly release: Deferred.Deferred<void>
}

interface LifecycleState extends E2eReviewLifecycleDiagnostics {
  readonly supersededGenerations: ReadonlySet<string>
  readonly holdNext: boolean
  readonly held: HeldAcquisition | null
}

const initialState: LifecycleState = {
  acquisitions: {
    activeOperationIds: [],
    started: 0,
    completed: 0,
    superseded: 0,
    drained: 0,
    failed: 0,
    lastStartedOperationId: null,
    lastSupersededOperationId: null,
    lastDrainedOperationId: null,
  },
  sessions: {
    activeSessionId: null,
    opened: 0,
    disposed: 0,
    lastDisposedSessionId: null,
  },
  supersededGenerations: new Set(),
  holdNext: false,
  held: null,
}

/** Core-owned lifecycle counters exposed only through the packaged-E2E bridge. */
export class ReviewLifecycleDiagnostics extends Context.Service<
  ReviewLifecycleDiagnostics,
  {
    readonly snapshot: Effect.Effect<E2eReviewLifecycleDiagnostics>
    readonly holdNextAcquisition: Effect.Effect<boolean>
    readonly acquisitionStarted: (generation: string) => Effect.Effect<void>
    readonly acquisitionSuperseded: (generation: string) => Effect.Effect<void>
    readonly acquisitionFinished: (generation: string, succeeded: boolean) => Effect.Effect<void>
    readonly sessionOpened: (sessionId: string) => Effect.Effect<void>
    readonly sessionDisposed: (sessionId: string) => Effect.Effect<void>
  }
>()("@diffdash/core/ReviewLifecycleDiagnostics") {}

/** Creates one review lifecycle ledger shared by acquisition workers and foreground sessions. */
export const reviewLifecycleDiagnosticsLayer = Layer.effect(
  ReviewLifecycleDiagnostics,
  Effect.gen(function* () {
    const state = yield* Ref.make(initialState)
    return ReviewLifecycleDiagnostics.of({
      snapshot: Ref.get(state).pipe(
        Effect.map(({ acquisitions, sessions }) => ({ acquisitions, sessions })),
      ),
      holdNextAcquisition: Ref.modify(state, (current) => [
        !current.holdNext && current.held === null,
        current.holdNext || current.held !== null ? current : { ...current, holdNext: true },
      ]),
      acquisitionStarted: (generation) =>
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>()
          const held = yield* Ref.modify(state, (current) => {
            const shouldHold = current.holdNext
            return [
              shouldHold,
              {
                ...current,
                holdNext: false,
                held: shouldHold ? { generation, release } : current.held,
                acquisitions: {
                  ...current.acquisitions,
                  activeOperationIds: [...current.acquisitions.activeOperationIds, generation],
                  started: current.acquisitions.started + 1,
                  lastStartedOperationId: generation,
                },
              },
            ]
          })
          if (held) yield* Deferred.await(release)
        }),
      acquisitionSuperseded: (generation) =>
        Ref.modify(state, (current) => {
          if (current.supersededGenerations.has(generation)) return [Option.none(), current]
          const supersededGenerations = new Set(current.supersededGenerations).add(generation)
          return [
            current.held?.generation === generation
              ? Option.some(current.held.release)
              : Option.none(),
            {
              ...current,
              held: current.held?.generation === generation ? null : current.held,
              supersededGenerations,
              acquisitions: {
                ...current.acquisitions,
                superseded: current.acquisitions.superseded + 1,
                lastSupersededOperationId: generation,
              },
            },
          ]
        }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (release) => Deferred.succeed(release, undefined),
            }),
          ),
          Effect.asVoid,
        ),
      acquisitionFinished: (generation, succeeded) =>
        Ref.update(state, (current) => {
          const superseded = current.supersededGenerations.has(generation)
          const supersededGenerations = new Set(current.supersededGenerations)
          supersededGenerations.delete(generation)
          return {
            ...current,
            supersededGenerations,
            held: current.held?.generation === generation ? null : current.held,
            acquisitions: {
              ...current.acquisitions,
              activeOperationIds: current.acquisitions.activeOperationIds.filter(
                (active) => active !== generation,
              ),
              completed:
                succeeded && !superseded
                  ? current.acquisitions.completed + 1
                  : current.acquisitions.completed,
              failed:
                !succeeded && !superseded
                  ? current.acquisitions.failed + 1
                  : current.acquisitions.failed,
              drained: superseded ? current.acquisitions.drained + 1 : current.acquisitions.drained,
              lastDrainedOperationId: superseded
                ? generation
                : current.acquisitions.lastDrainedOperationId,
            },
          }
        }),
      sessionOpened: (sessionId) =>
        Ref.update(state, (current) => ({
          ...current,
          sessions: {
            ...current.sessions,
            activeSessionId: sessionId,
            opened: current.sessions.opened + 1,
          },
        })),
      sessionDisposed: (sessionId) =>
        Ref.update(state, (current) => ({
          ...current,
          sessions: {
            ...current.sessions,
            activeSessionId:
              current.sessions.activeSessionId === sessionId
                ? null
                : current.sessions.activeSessionId,
            disposed: current.sessions.disposed + 1,
            lastDisposedSessionId: sessionId,
          },
        })),
    })
  }),
)
