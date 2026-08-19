import { existsSync, watch, type FSWatcher } from "node:fs"
import { join } from "node:path"

import { Cause, Effect, Fiber, Queue, Ref, Result, Scope } from "effect"

import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import {
  type CanonicalGitDirectories,
  type CanonicalGitState,
  RepositoryReconciler,
} from "./repository-reconciliation"

/** Reasons that bypass hint debounce and force an authoritative reconciliation. */
export type RepositoryForceReason = "focus" | "overflow" | "resume" | "timer"

/** Selected timing limits for one active repository watcher. */
export type RepositoryWatcherLimits = {
  readonly debounce: number
  readonly maxWait: number
  readonly pollingInterval: number
}

/** A generation-keyed notice that authoritative local Git state changed semantically. */
export type RepositoryInvalidation = {
  readonly projectId: ReviewProjectId
  readonly generation: number
  readonly checkoutPath: RepositoryCheckoutPath
  readonly state: CanonicalGitState
}

/** Lossy native watch adapter. Polling and lifecycle triggers remain authoritative fallbacks. */
export interface RepositoryWatchSource {
  readonly start: (
    directories: CanonicalGitDirectories,
    onSignal: (signal: "hint" | "overflow") => void,
  ) => Effect.Effect<Effect.Effect<void>>
}

/** Dependencies supplied by the Core composition boundary. */
export type RepositoryWatcherOptions = {
  readonly watchSource: RepositoryWatchSource
  readonly publish: (invalidation: RepositoryInvalidation) => Effect.Effect<void>
  readonly limits?: Partial<RepositoryWatcherLimits>
}

/** Lifecycle API for the one currently active project repository. */
export interface RepositoryWatcher {
  readonly activate: (
    projectId: ReviewProjectId,
    checkoutPath: RepositoryCheckoutPath,
  ) => Effect.Effect<number>
  readonly deactivate: (projectId: ReviewProjectId) => Effect.Effect<void>
  readonly hint: (projectId: ReviewProjectId) => Effect.Effect<void>
  readonly force: (projectId: ReviewProjectId, reason: RepositoryForceReason) => Effect.Effect<void>
}

const DEFAULT_LIMITS: RepositoryWatcherLimits = {
  debounce: 75,
  maxWait: 500,
  pollingInterval: 30_000,
}

type Selection = {
  readonly projectId: ReviewProjectId
  readonly generation: number
} | null

type Event =
  | {
      readonly _tag: "Activate"
      readonly projectId: ReviewProjectId
      readonly generation: number
      readonly checkoutPath: RepositoryCheckoutPath
    }
  | { readonly _tag: "Deactivate"; readonly projectId: ReviewProjectId }
  | { readonly _tag: "Hint"; readonly projectId: ReviewProjectId }
  | { readonly _tag: "Force"; readonly projectId: ReviewProjectId }
  | { readonly _tag: "Debounce"; readonly generation: number; readonly token: number }
  | { readonly _tag: "MaxWait"; readonly generation: number; readonly token: number }
  | {
      readonly _tag: "Directories"
      readonly projectId: ReviewProjectId
      readonly generation: number
      readonly result: Result.Result<CanonicalGitDirectories, unknown>
    }
  | {
      readonly _tag: "WatchReady"
      readonly projectId: ReviewProjectId
      readonly generation: number
      readonly stop: Effect.Effect<void>
    }
  | {
      readonly _tag: "Reconciled"
      readonly projectId: ReviewProjectId
      readonly generation: number
      readonly result: Result.Result<CanonicalGitState, unknown>
    }

type Active = {
  readonly projectId: ReviewProjectId
  readonly checkoutPath: RepositoryCheckoutPath
  readonly generation: number
  directories: CanonicalGitDirectories | null
  stopWatch: Effect.Effect<void>
  fingerprint: string | null
  resolving: boolean
  inFlight: boolean
  reconcileFiber: Fiber.Fiber<void> | null
  followUp: boolean
  debounceToken: number
  maxWaitToken: number
  batchOpen: boolean
}

/** Builds a scoped watcher coordinator; closing the scope stops native watchers and timers. */
export const makeRepositoryWatcher = Effect.fn("RepositoryWatcher.make")(function* (
  options: RepositoryWatcherOptions,
): Effect.fn.Return<RepositoryWatcher, never, RepositoryReconciler | Scope.Scope> {
  const reconciler = yield* RepositoryReconciler
  const scope = yield* Effect.scope
  const events = yield* Queue.unbounded<Event>()
  const selection = yield* Ref.make<Selection>(null)
  const nextGeneration = yield* Ref.make(0)
  const limits = { ...DEFAULT_LIMITS, ...options.limits }

  const offerUnsafe = (event: Event): void => {
    Queue.offerUnsafe(events, event)
  }

  const forkEvent = (effect: Effect.Effect<Event>): Effect.Effect<void> =>
    effect.pipe(
      Effect.flatMap((event) => Queue.offer(events, event)),
      Effect.asVoid,
      Effect.forkIn(scope),
      Effect.asVoid,
    )

  let active: Active | null = null

  const resolveDirectories = (current: Active): Effect.Effect<void> => {
    if (current.resolving) return Effect.void
    current.resolving = true
    return reconciler.resolveDirectories(current.checkoutPath).pipe(
      Effect.result,
      Effect.map(
        (result): Event => ({
          _tag: "Directories",
          projectId: current.projectId,
          generation: current.generation,
          result,
        }),
      ),
      forkEvent,
    )
  }

  const reconcile = (current: Active): Effect.Effect<void> => {
    if (current.directories === null) return resolveDirectories(current)
    if (current.inFlight) {
      current.followUp = true
      return Effect.void
    }
    current.inFlight = true
    current.batchOpen = false
    current.debounceToken += 1
    current.maxWaitToken += 1
    return reconciler.readState(current.checkoutPath).pipe(
      Effect.result,
      Effect.map(
        (result): Event => ({
          _tag: "Reconciled",
          projectId: current.projectId,
          generation: current.generation,
          result,
        }),
      ),
      Effect.flatMap((event) => Queue.offer(events, event)),
      Effect.asVoid,
      Effect.forkIn(scope),
      Effect.tap((fiber) =>
        Effect.sync(() => {
          current.reconcileFiber = fiber
        }),
      ),
      Effect.asVoid,
    )
  }

  const scheduleHint = (current: Active): Effect.Effect<void> => {
    if (current.inFlight) {
      current.followUp = true
      return Effect.void
    }
    current.debounceToken += 1
    const debounceToken = current.debounceToken
    const effects = [
      Effect.sleep(limits.debounce).pipe(
        Effect.as<Event>({
          _tag: "Debounce",
          generation: current.generation,
          token: debounceToken,
        }),
        forkEvent,
      ),
    ]
    if (!current.batchOpen) {
      current.batchOpen = true
      current.maxWaitToken += 1
      const maxWaitToken = current.maxWaitToken
      effects.push(
        Effect.sleep(limits.maxWait).pipe(
          Effect.as<Event>({
            _tag: "MaxWait",
            generation: current.generation,
            token: maxWaitToken,
          }),
          forkEvent,
        ),
      )
    }
    return Effect.all(effects, { discard: true })
  }

  const stopActive = (): Effect.Effect<void> => {
    const stop =
      active === null
        ? Effect.void
        : Effect.all(
            [
              active.stopWatch,
              active.reconcileFiber === null ? Effect.void : Fiber.interrupt(active.reconcileFiber),
            ],
            { discard: true },
          )
    active = null
    return stop
  }

  const handle = Effect.fn("RepositoryWatcher.handle")(function* (event: Event) {
    switch (event["_tag"]) {
      case "Activate": {
        yield* stopActive()
        active = {
          projectId: event.projectId,
          checkoutPath: event.checkoutPath,
          generation: event.generation,
          directories: null,
          stopWatch: Effect.void,
          fingerprint: null,
          resolving: false,
          inFlight: false,
          reconcileFiber: null,
          followUp: false,
          debounceToken: 0,
          maxWaitToken: 0,
          batchOpen: false,
        }
        yield* resolveDirectories(active)
        return
      }
      case "Deactivate": {
        if (active?.projectId === event.projectId) yield* stopActive()
        return
      }
      case "Hint": {
        if (active?.projectId === event.projectId) yield* scheduleHint(active)
        return
      }
      case "Force": {
        if (active?.projectId === event.projectId) yield* reconcile(active)
        return
      }
      case "Debounce": {
        if (
          active?.generation === event.generation &&
          active.batchOpen &&
          active.debounceToken === event.token
        ) {
          yield* reconcile(active)
        }
        return
      }
      case "MaxWait": {
        if (
          active?.generation === event.generation &&
          active.batchOpen &&
          active.maxWaitToken === event.token
        ) {
          yield* reconcile(active)
        }
        return
      }
      case "Directories": {
        if (active?.generation !== event.generation || active.projectId !== event.projectId) return
        active.resolving = false
        if (Result.isFailure(event.result)) return
        active.directories = event.result.success
        yield* options.watchSource
          .start(event.result.success, (signal) =>
            offerUnsafe(
              signal === "overflow"
                ? { _tag: "Force", projectId: event.projectId }
                : { _tag: "Hint", projectId: event.projectId },
            ),
          )
          .pipe(
            Effect.map(
              (stop): Event => ({
                _tag: "WatchReady",
                projectId: event.projectId,
                generation: event.generation,
                stop,
              }),
            ),
            forkEvent,
          )
        yield* reconcile(active)
        return
      }
      case "WatchReady": {
        if (active?.generation !== event.generation || active.projectId !== event.projectId) {
          yield* event.stop
          return
        }
        yield* active.stopWatch
        active.stopWatch = event.stop
        return
      }
      case "Reconciled": {
        if (active?.generation !== event.generation || active.projectId !== event.projectId) return
        active.inFlight = false
        active.reconcileFiber = null
        if (Result.isSuccess(event.result)) {
          const selected = yield* Ref.get(selection)
          if (
            selected?.generation === event.generation &&
            selected.projectId === event.projectId &&
            active.fingerprint !== event.result.success.fingerprint
          ) {
            active.fingerprint = event.result.success.fingerprint
            yield* options
              .publish({
                projectId: event.projectId,
                generation: event.generation,
                checkoutPath: active.checkoutPath,
                state: event.result.success,
              })
              .pipe(
                Effect.catchCauseIf(
                  (cause) => !Cause.hasInterrupts(cause),
                  () => Effect.void,
                ),
              )
          }
        }
        if (active.followUp) {
          active.followUp = false
          yield* reconcile(active)
        }
      }
    }
  })

  yield* Effect.forever(Queue.take(events).pipe(Effect.flatMap(handle))).pipe(Effect.forkIn(scope))
  yield* Effect.forever(
    Effect.sleep(limits.pollingInterval).pipe(
      Effect.flatMap(() => Ref.get(selection)),
      Effect.flatMap((selected) =>
        selected === null
          ? Effect.void
          : Queue.offer(events, { _tag: "Force", projectId: selected.projectId }),
      ),
    ),
  ).pipe(Effect.forkIn(scope))
  yield* Effect.addFinalizer(() => stopActive())

  return {
    activate: Effect.fn("RepositoryWatcher.activate")(function* (projectId, checkoutPath) {
      const generation = yield* Ref.updateAndGet(nextGeneration, (current) => current + 1)
      yield* Ref.set(selection, { projectId, generation })
      yield* Queue.offer(events, { _tag: "Activate", projectId, generation, checkoutPath })
      return generation
    }),
    deactivate: Effect.fn("RepositoryWatcher.deactivate")(function* (projectId) {
      yield* Ref.update(selection, (selected) =>
        selected?.projectId === projectId ? null : selected,
      )
      yield* Queue.offer(events, { _tag: "Deactivate", projectId })
    }),
    hint: Effect.fn("RepositoryWatcher.hint")((projectId) =>
      Queue.offer(events, { _tag: "Hint", projectId }).pipe(Effect.asVoid),
    ),
    force: Effect.fn("RepositoryWatcher.force")((projectId, _reason) =>
      Queue.offer(events, { _tag: "Force", projectId }).pipe(Effect.asVoid),
    ),
  }
})

/** Native Node watcher for Git metadata and working-tree hints, with failure signaled as overflow. */
export const nodeRepositoryWatchSource: RepositoryWatchSource = {
  start: (directories, onSignal) =>
    Effect.sync(() => {
      const watchers: FSWatcher[] = []
      const paths = new Set([
        directories.checkoutRoot,
        directories.worktreeGitDirectory,
        directories.commonGitDirectory,
        join(directories.commonGitDirectory, "refs"),
        join(directories.commonGitDirectory, "info"),
      ])
      try {
        for (const path of paths) {
          if (!existsSync(path)) continue
          const watcher = watch(path, { recursive: path === directories.checkoutRoot }, () =>
            onSignal("hint"),
          )
          watcher.on("error", () => onSignal("overflow"))
          watchers.push(watcher)
        }
      } catch {
        for (const watcher of watchers) watcher.close()
        onSignal("overflow")
      }
      return Effect.sync(() => {
        for (const watcher of watchers) watcher.close()
      })
    }),
}
