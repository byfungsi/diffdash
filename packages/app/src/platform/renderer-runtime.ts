import { useAtomSuspense } from "@effect/atom-react"
import { Context, Effect, Fiber, Layer, Schedule, Stream } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { useEffect, useEffectEvent } from "react"

import { DesktopRuntime, desktopRuntimeLayer } from "./desktop-runtime"
import { preloadClientLive } from "./preload-client"
import { ProjectWorkspace, projectWorkspaceLayer } from "./project-workspace"
import { RendererPreferences, rendererPreferencesLayer } from "./preferences"
import { Repositories, repositoriesLayer } from "./repositories"
import { ReviewAutomation, reviewAutomationLayer } from "./review-automation"
import { ReviewContent, reviewContentLayer } from "./review-content"
import { ReviewSourceOperations, reviewSourceOperationsLayer } from "./review-source-operations"
import { WalkthroughOperations, walkthroughOperationsLayer } from "./walkthrough-operations"
export { runRendererPromise } from "./renderer-effect"

/** All renderer capabilities built once for one atom registry. */
export type RendererServices =
  | DesktopRuntime
  | ProjectWorkspace
  | RendererPreferences
  | Repositories
  | ReviewAutomation
  | ReviewContent
  | ReviewSourceOperations
  | WalkthroughOperations

const capabilityLayers = Layer.mergeAll(
  desktopRuntimeLayer,
  projectWorkspaceLayer,
  rendererPreferencesLayer,
  repositoriesLayer,
  reviewAutomationLayer,
  reviewContentLayer,
  reviewSourceOperationsLayer,
  walkthroughOperationsLayer,
)

/** Production renderer service graph with the raw preload client hidden after composition. */
export const rendererServicesLive: Layer.Layer<RendererServices> = Layer.fresh(
  capabilityLayers.pipe(Layer.provide(Layer.fresh(preloadClientLive))),
)

/** Single atom-owned runtime used by every renderer query and imperative capability consumer. */
export const rendererRuntime = Atom.runtime(rendererServicesLive).pipe(Atom.keepAlive)

const useRendererContext = () => useAtomSuspense(rendererRuntime).value

/** Returns the Electron-shell capability from the shared renderer runtime. */
export const useDesktopRuntime = () => Context.get(useRendererContext(), DesktopRuntime)

/** Returns the project-target capability from the shared renderer runtime. */
export const useProjectWorkspace = () => Context.get(useRendererContext(), ProjectWorkspace)

/** Returns renderer persistence capabilities from the shared renderer runtime. */
export const useRendererPreferences = () => Context.get(useRendererContext(), RendererPreferences)

/** Returns repository capabilities from the shared renderer runtime. */
export const useRepositories = () => Context.get(useRendererContext(), Repositories)

/** Returns review automation capabilities from the shared renderer runtime. */
export const useReviewAutomation = () => Context.get(useRendererContext(), ReviewAutomation)

/** Returns review content capabilities from the shared renderer runtime. */
export const useReviewContent = () => Context.get(useRendererContext(), ReviewContent)

/** Returns the factory for source-specific operations of an authoritative ready review. */
export const useReviewSourceOperationsFactory = () =>
  Context.get(useRendererContext(), ReviewSourceOperations)

/** Returns the factory for source-neutral durable walkthrough operation sessions. */
export const useWalkthroughOperationsFactory = () =>
  Context.get(useRendererContext(), WalkthroughOperations)

/** Consumes a renderer stream, reports typed failures, and reconnects after a bounded delay. */
export const consumeRendererStream = <A, E, R, R2, R3>(
  stream: Stream.Stream<A, E, R>,
  onValue: (value: A) => Effect.Effect<void, never, R2>,
  onError: (error: E) => Effect.Effect<void, never, R3>,
): Effect.Effect<void, E, R | R2 | R3> =>
  stream.pipe(
    Stream.tapError(onError),
    Stream.retry(Schedule.spaced("1 second")),
    Stream.runForEach(onValue),
  )

/** Runs a supervised renderer stream for a component lifetime and interrupts it during cleanup. */
export const useRendererStream = <A, E>(
  stream: Stream.Stream<A, E>,
  onValue: (value: A) => void | Promise<void>,
  onError: (error: E) => void,
): void => {
  const emitValue = useEffectEvent(onValue)
  const emitError = useEffectEvent(onError)
  useEffect(() => {
    const fiber = Effect.runFork(
      consumeRendererStream(
        stream,
        (value) => Effect.promise(() => Promise.resolve(emitValue(value))),
        (error) => Effect.sync(() => emitError(error)),
      ),
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [stream])
}
