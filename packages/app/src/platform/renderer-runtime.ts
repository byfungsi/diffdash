import { Atom, useAtomSuspense } from "@effect-atom/atom-react"
import { Cause, Context, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import { useEffect, useEffectEvent } from "react"

import { DesktopRuntime, desktopRuntimeLayer } from "./desktop-runtime"
import { preloadClientLive } from "./preload-client"
import { ProjectWorkspace, projectWorkspaceLayer } from "./project-workspace"
import { RendererPreferences, rendererPreferencesLayer } from "./preferences"
import { Repositories, repositoriesLayer } from "./repositories"
import { ReviewAutomation, reviewAutomationLayer } from "./review-automation"
import { ReviewContent, reviewContentLayer } from "./review-content"

/** All renderer capabilities built once for one atom registry. */
export type RendererServices =
  | DesktopRuntime
  | ProjectWorkspace
  | RendererPreferences
  | Repositories
  | ReviewAutomation
  | ReviewContent

const capabilityLayers = Layer.mergeAll(
  desktopRuntimeLayer,
  projectWorkspaceLayer,
  rendererPreferencesLayer,
  repositoriesLayer,
  reviewAutomationLayer,
  reviewContentLayer,
)

/** Production renderer service graph with the raw preload client hidden after composition. */
export const rendererServicesLive: Layer.Layer<RendererServices> = Layer.fresh(
  capabilityLayers.pipe(Layer.provide(Layer.fresh(preloadClientLive))),
)

/** Single atom-owned runtime used by every renderer query and imperative capability consumer. */
export const rendererRuntime = Atom.runtime(rendererServicesLive).pipe(Atom.keepAlive)

const useRendererContext = () => useAtomSuspense(rendererRuntime).value.context

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

/** Runs one closed renderer service Effect while rejecting with its original expected failure. */
export const runRendererPromise = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  const failure = Cause.failureOption(exit.cause)
  if (Option.isSome(failure)) throw failure.value
  throw Cause.squash(exit.cause)
}

/** Runs a scoped renderer stream for a component lifetime and interrupts it during cleanup. */
export const useRendererStream = <A, E>(
  stream: Stream.Stream<A, E>,
  onValue: (value: A) => void | Promise<void>,
): void => {
  const emitValue = useEffectEvent(onValue)
  useEffect(() => {
    const fiber = Effect.runFork(
      Stream.runForEach(stream, (value) =>
        Effect.promise(() => Promise.resolve(emitValue(value))),
      ).pipe(Effect.catchAll(() => Effect.void)),
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [stream])
}
