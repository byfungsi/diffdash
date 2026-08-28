import { Effect, HashMap, Option, Ref, Schema } from "effect"
import { useEffect, useRef, type RefObject } from "react"

import { isHTMLElement } from "@/shared/dom"
import type { FloatingPaneAnchor } from "@/shared/ui/floating-pane"

/** Stable identity for one built-in or extension-owned surface contribution. */
export const SourceSurfaceContributionId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(200)),
  Schema.check(Schema.isPattern(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u)),
  Schema.brand("SourceSurfaceContributionId"),
)

/** Stable identity for one built-in or extension-owned surface contribution. */
export type SourceSurfaceContributionId = typeof SourceSurfaceContributionId.Type

/** Ordered interaction phases exposed by a source surface. */
const SOURCE_SURFACE_INTERACTION_PHASES = [
  "modifiedToken",
  "annotationControl",
  "gutterAction",
  "lineAction",
  "fallback",
] as const

/** Ordered interaction phases exposed by a source surface. */
export const SourceSurfaceInteractionPhase = Schema.Literals(SOURCE_SURFACE_INTERACTION_PHASES)

/** Ordered interaction phases exposed by a source surface. */
export type SourceSurfaceInteractionPhase = typeof SourceSurfaceInteractionPhase.Type

/** Semantic token target resolved from a composed source-surface event. */
export interface SourceSurfaceTokenTarget {
  readonly surfaceId: string
  readonly lineNumber: number
  readonly lineCharStart: number
  readonly lineCharEnd: number
  readonly tokenText: string
  readonly tokenElement: HTMLElement
  readonly side: Option.Option<SourceSurfaceSide>
}

/** Optional old/new side carried by tokens rendered from a diff surface. */
export const SourceSurfaceSide = Schema.Literals(["additions", "deletions"])

/** Optional old/new side carried by tokens rendered from a diff surface. */
export type SourceSurfaceSide = typeof SourceSurfaceSide.Type

/** Pierre token coordinates before the adapter associates them with a semantic surface. */
export type SourceSurfaceTokenCoordinates = Omit<SourceSurfaceTokenTarget, "surfaceId">

/** Normalized click delivered to registered source-surface capabilities. */
export interface SourceSurfaceClickInteraction {
  readonly event: MouseEvent
  readonly lineNumber: number
  readonly token: Option.Option<SourceSurfaceTokenTarget>
}

/** One exclusive route that may claim a normalized surface click. */
export interface SourceSurfaceInteractionRoute {
  readonly id: SourceSurfaceContributionId
  readonly phase: SourceSurfaceInteractionPhase
  readonly handle: (interaction: SourceSurfaceClickInteraction) => boolean
}

/** Render lifecycle phase shared by Pierre file and diff surfaces. */
export const SourceSurfaceRenderPhase = Schema.Literals(["mount", "update", "unmount"])

/** Render lifecycle phase shared by Pierre file and diff surfaces. */
export type SourceSurfaceRenderPhase = typeof SourceSurfaceRenderPhase.Type

/** One mounted surface publication delivered to lifecycle capabilities. */
export interface SourceSurfaceRenderEvent<Instance> {
  readonly generation: number
  readonly host: HTMLElement
  readonly instance: Instance
  readonly phase: SourceSurfaceRenderPhase
  readonly surfaceId: string
}

/** Observer contributed by a capability that reconciles mounted surface DOM. */
export type SourceSurfaceRenderObserver<Instance> = (
  event: SourceSurfaceRenderEvent<Instance>,
) => void

/** Typed failure raised when a source-surface contribution violates its runtime contract. */
export class SourceSurfaceCapabilityError extends Schema.TaggedError<SourceSurfaceCapabilityError>()(
  "SourceSurfaceCapabilityError",
  {
    contributionId: SourceSurfaceContributionId,
    operation: Schema.Literals(["registerInteraction", "registerObserver", "notifyObserver"]),
    message: Schema.String,
  },
) {}

type RenderedSurface<Instance> = {
  readonly generation: number
  readonly instance: Instance
  readonly surfaceId: string
}

type RenderedSurfaceRegistration<Instance> = RenderedSurface<Instance> & {
  readonly host: HTMLElement
}

const SourceSurfaceLineIndexText = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)$/u)),
)

const SourceSurfaceRenderLineIndexText = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)(?:,(?:0|[1-9][0-9]*))?$/u)),
)

/**
 * Governs stable Pierre callbacks while capabilities register semantic interactions and render
 * observers independently.
 */
export class SourceSurfaceRuntime<Instance> {
  private readonly interactionRoutes = Ref.makeUnsafe(
    HashMap.empty<SourceSurfaceContributionId, SourceSurfaceInteractionRoute>(),
  )
  private readonly renderObservers = Ref.makeUnsafe(
    HashMap.empty<SourceSurfaceContributionId, SourceSurfaceRenderObserver<Instance>>(),
  )
  private readonly renderedSurfaces = Ref.makeUnsafe<
    readonly RenderedSurfaceRegistration<Instance>[]
  >([])

  /** Registers one interaction route and returns its ownership-safe disposer. */
  registerInteractionRoute(
    route: SourceSurfaceInteractionRoute,
  ): Effect.Effect<() => void, SourceSurfaceCapabilityError> {
    return Effect.gen({ self: this }, function* () {
      if (HashMap.has(yield* Ref.get(this.interactionRoutes), route.id)) {
        return yield* SourceSurfaceCapabilityError.make({
          contributionId: route.id,
          operation: "registerInteraction",
          message: `Source surface interaction contribution already registered: ${route.id}`,
        })
      }
      yield* Ref.update(this.interactionRoutes, HashMap.set(route.id, route))
      return () => {
        Effect.runSync(
          Ref.update(this.interactionRoutes, (routes) =>
            Option.match(HashMap.get(routes, route.id), {
              onNone: () => routes,
              onSome: (registered) =>
                registered === route ? HashMap.remove(routes, route.id) : routes,
            }),
          ),
        )
      }
    })
  }

  /** Registers one render observer, replaying currently mounted surfaces to late capabilities. */
  registerRenderObserver(
    id: SourceSurfaceContributionId,
    observer: SourceSurfaceRenderObserver<Instance>,
  ): Effect.Effect<() => void, SourceSurfaceCapabilityError> {
    return Effect.gen({ self: this }, function* () {
      if (HashMap.has(yield* Ref.get(this.renderObservers), id)) {
        return yield* SourceSurfaceCapabilityError.make({
          contributionId: id,
          operation: "registerObserver",
          message: `Source surface render contribution already registered: ${id}`,
        })
      }
      yield* Ref.update(this.renderObservers, HashMap.set(id, observer))
      yield* Effect.forEach(yield* Ref.get(this.renderedSurfaces), ({ host, ...rendered }) =>
        Effect.try({
          try: () => observer({ ...rendered, host, phase: "mount" }),
          catch: () =>
            SourceSurfaceCapabilityError.make({
              contributionId: id,
              operation: "registerObserver",
              message: `Source surface render observer failed while replaying mounted surfaces: ${id}`,
            }),
        }),
      ).pipe(Effect.tapError(() => Ref.update(this.renderObservers, HashMap.remove(id))))
      return () => {
        Effect.runSync(
          Ref.update(this.renderObservers, (observers) =>
            Option.match(HashMap.get(observers, id), {
              onNone: () => observers,
              onSome: (registered) =>
                registered === observer ? HashMap.remove(observers, id) : observers,
            }),
          ),
        )
      }
    })
  }

  /** Visits every currently mounted host without forcing Pierre to render again. */
  forEachRenderedHost(visit: (host: HTMLElement, instance: Instance) => void): void {
    for (const { host, instance } of Ref.getUnsafe(this.renderedSurfaces)) {
      visit(host, instance)
    }
  }

  /** Creates a durable virtual anchor that resolves the current token after source rerenders. */
  createTokenAnchor(target: SourceSurfaceTokenTarget): FloatingPaneAnchor {
    let lastRect = target.tokenElement.getBoundingClientRect()
    const renderLineIndex = Option.flatMap(
      Option.fromNullishOr(target.tokenElement.closest<HTMLElement>("[data-line-index]")),
      (line) =>
        Schema.decodeUnknownOption(SourceSurfaceRenderLineIndexText)(line.dataset.lineIndex),
    )
    return {
      getBoundingClientRect: () => {
        const token = target.tokenElement.isConnected
          ? Option.some(target.tokenElement)
          : this.findRenderedToken(target, renderLineIndex)
        Option.map(token, (element) => {
          lastRect = element.getBoundingClientRect()
        })
        return lastRect
      },
    }
  }

  /** Creates the sole Pierre render callback for one semantically identified surface. */
  createRenderPublisher(surfaceId: string) {
    return (host: HTMLElement, instance: Instance, phase: SourceSurfaceRenderPhase): void => {
      Effect.runSync(this.publishRender(surfaceId, host, instance, phase))
    }
  }

  /** Publishes a named surface through the shared stable render lifecycle. */
  publishRender(
    surfaceId: string,
    host: HTMLElement,
    instance: Instance,
    phase: SourceSurfaceRenderPhase,
  ): Effect.Effect<void, SourceSurfaceCapabilityError> {
    return Effect.gen({ self: this }, function* () {
      const previous = this.getRenderedSurface(host)
      const failure = yield* Ref.make(Option.none<SourceSurfaceCapabilityError>())
      yield* Option.match(previous, {
        onNone: () => Effect.void,
        onSome: (displaced) => {
          if (
            phase === "unmount" ||
            (displaced.instance === instance && displaced.surfaceId === surfaceId)
          ) {
            return Effect.void
          }
          return this.publishSingleRender(
            displaced.surfaceId,
            host,
            displaced.instance,
            "unmount",
          ).pipe(Effect.catch((error) => Ref.set(failure, Option.some(error))))
        },
      })
      yield* this.publishSingleRender(surfaceId, host, instance, phase).pipe(
        Effect.catch((error) =>
          Ref.update(
            failure,
            Option.orElse(() => Option.some(error)),
          ),
        ),
      )
      yield* Option.match(yield* Ref.get(failure), {
        onNone: () => Effect.void,
        onSome: (error) => error,
      })
    })
  }

  /** Stable bubble-phase dispatcher installed once on the surface root. */
  readonly handleClick = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0 || event.detail > 1) return
    Option.match(sourceSurfaceClickInteraction(event, this.renderedSurfaces), {
      onNone: () => undefined,
      onSome: (interaction) => {
        for (const phase of SOURCE_SURFACE_INTERACTION_PHASES) {
          for (const route of HashMap.values(Ref.getUnsafe(this.interactionRoutes))) {
            if (route.phase !== phase || !route.handle(interaction)) continue
            event.preventDefault()
            event.stopPropagation()
            return
          }
        }
      },
    })
  }

  /** Releases every contribution and mounted-host registration owned by this runtime. */
  dispose(): void {
    Effect.runSync(
      Effect.all([
        Ref.set(this.interactionRoutes, HashMap.empty()),
        Ref.set(this.renderObservers, HashMap.empty()),
        Ref.set(this.renderedSurfaces, []),
      ]),
    )
  }

  private publishSingleRender(
    surfaceId: string,
    host: HTMLElement,
    instance: Instance,
    phase: SourceSurfaceRenderPhase,
  ): Effect.Effect<void, SourceSurfaceCapabilityError> {
    return Effect.gen({ self: this }, function* () {
      const previous = this.getRenderedSurface(host)
      if (
        phase === "unmount" &&
        !Option.exists(
          previous,
          (rendered) => rendered.instance === instance && rendered.surfaceId === surfaceId,
        )
      ) {
        return
      }
      const generation = Option.match(previous, {
        onNone: () => 1,
        onSome: (rendered) => {
          if (rendered.instance === instance) return rendered.generation + 1
          return 1
        },
      })
      const phaseHandlers = {
        mount: () => this.setRenderedSurface({ generation, host, instance, surfaceId }),
        update: () => this.setRenderedSurface({ generation, host, instance, surfaceId }),
        unmount: () => undefined,
      } satisfies Readonly<Record<SourceSurfaceRenderPhase, () => void>>
      phaseHandlers[phase]()
      const event = {
        generation,
        host,
        instance,
        phase,
        surfaceId,
      } satisfies SourceSurfaceRenderEvent<Instance>
      const failure = yield* Ref.make(Option.none<SourceSurfaceCapabilityError>())
      for (const [id, observer] of yield* Ref.get(this.renderObservers)) {
        yield* Effect.try({
          try: () => observer(event),
          catch: () =>
            SourceSurfaceCapabilityError.make({
              contributionId: id,
              operation: "notifyObserver",
              message: `Source surface render observer failed: ${id}`,
            }),
        }).pipe(
          Effect.catch((error) =>
            Ref.update(
              failure,
              Option.orElse(() => Option.some(error)),
            ),
          ),
        )
      }
      if (phase === "unmount") {
        const current = this.getRenderedSurface(host)
        if (
          Option.exists(
            current,
            (rendered) => rendered.instance === instance && rendered.surfaceId === surfaceId,
          )
        ) {
          this.removeRenderedSurface(host)
        }
      }
      yield* Option.match(yield* Ref.get(failure), {
        onNone: () => Effect.void,
        onSome: (error) => error,
      })
    })
  }

  private findRenderedToken(
    target: SourceSurfaceTokenTarget,
    renderLineIndex: Option.Option<string>,
  ): Option.Option<HTMLElement> {
    for (const { host, ...rendered } of Ref.getUnsafe(this.renderedSurfaces)) {
      if (rendered.surfaceId !== target.surfaceId) continue
      const line = Option.flatMap(renderLineIndex, (lineIndex) =>
        Option.fromNullishOr(
          host.shadowRoot?.querySelector<HTMLElement>(
            `[data-line-index="${lineIndex}"][data-line]`,
          ),
        ),
      )
      const token = Option.flatMap(line, (lineElement) =>
        Option.fromNullishOr(
          lineElement.querySelector<HTMLElement>(`[data-char="${String(target.lineCharStart)}"]`),
        ),
      )
      if (Option.exists(token, (element) => element.textContent === target.tokenText)) {
        return token
      }
    }
    return Option.none()
  }

  private getRenderedSurface(host: HTMLElement): Option.Option<RenderedSurface<Instance>> {
    return Option.map(
      Option.fromNullishOr(
        Ref.getUnsafe(this.renderedSurfaces).find((registration) => registration.host === host),
      ),
      ({ generation, instance, surfaceId }) => ({ generation, instance, surfaceId }),
    )
  }

  private setRenderedSurface(registration: RenderedSurfaceRegistration<Instance>): void {
    Effect.runSync(
      Ref.update(this.renderedSurfaces, (rendered) => [
        ...rendered.filter((current) => current.host !== registration.host),
        registration,
      ]),
    )
  }

  private removeRenderedSurface(host: HTMLElement): void {
    Effect.runSync(
      Ref.update(this.renderedSurfaces, (rendered) =>
        rendered.filter((registration) => registration.host !== host),
      ),
    )
  }
}

/** Creates one stable source-surface runtime and disposes it with its React owner. */
export const useSourceSurfaceRuntime = <Instance>(): SourceSurfaceRuntime<Instance> => {
  const runtimeRef = useRef<SourceSurfaceRuntime<Instance> | null>(null)
  runtimeRef.current ??= new SourceSurfaceRuntime<Instance>()
  const runtime = runtimeRef.current
  useEffect(() => () => runtime.dispose(), [runtime])
  return runtime
}

/** Installs a runtime's delegated interaction listener on one rendered source-surface root. */
export const useSourceSurfaceHost = <Instance>(
  runtime: SourceSurfaceRuntime<Instance>,
  rootRef: RefObject<HTMLElement | null>,
): void => {
  useEffect(() => {
    const root = rootRef.current
    if (root === null) return undefined
    root.addEventListener("click", runtime.handleClick)
    return () => root.removeEventListener("click", runtime.handleClick)
  }, [rootRef, runtime])
}

const sourceSurfaceClickInteraction = <Instance>(
  event: MouseEvent,
  renderedSurfaces: Ref.Ref<readonly RenderedSurfaceRegistration<Instance>[]>,
): Option.Option<SourceSurfaceClickInteraction> => {
  const path = event.composedPath()
  const registrations = Ref.getUnsafe(renderedSurfaces)
  const renderedHost = Option.fromNullishOr(
    path.find(
      (candidate): candidate is HTMLElement =>
        isHTMLElement(candidate) &&
        registrations.some((registration) => registration.host === candidate),
    ),
  )
  if (Option.isNone(renderedHost)) return Option.none()
  const rendered = Option.map(
    Option.fromNullishOr(
      registrations.find((registration) => registration.host === renderedHost.value),
    ),
    ({ generation, instance, surfaceId }) => ({ generation, instance, surfaceId }),
  )
  const sourceLineElement = Option.fromNullishOr(
    path.find(
      (candidate): candidate is HTMLElement =>
        isHTMLElement(candidate) && candidate.hasAttribute("data-line"),
    ),
  )
  const renderLineElement = Option.fromNullishOr(
    path.find(
      (candidate): candidate is HTMLElement =>
        isHTMLElement(candidate) && candidate.hasAttribute("data-line-index"),
    ),
  )
  const lineNumber = Option.match(sourceLineElement, {
    onNone: () =>
      Option.map(
        Option.flatMap(renderLineElement, (line) =>
          decodePierreNonNegativeInteger(line.dataset.lineIndex),
        ),
        (lineIndex) => lineIndex + 1,
      ),
    onSome: (line) => decodePierrePositiveInteger(line.dataset.line),
  })
  if (Option.isNone(lineNumber) || Option.isNone(rendered)) return Option.none()
  const tokenElement = Option.fromNullishOr(
    path.find(
      (candidate): candidate is HTMLElement =>
        isHTMLElement(candidate) && candidate.hasAttribute("data-char"),
    ),
  )
  if (Option.isNone(tokenElement)) {
    return Option.some({ event, lineNumber: lineNumber.value, token: Option.none() })
  }
  const lineCharStart = decodePierreNonNegativeInteger(tokenElement.value.dataset.char)
  if (Option.isNone(lineCharStart)) return Option.none()
  const tokenText = Option.getOrElse(Option.fromNullishOr(tokenElement.value.textContent), () => "")
  const code = Option.fromNullishOr(
    path.find(
      (candidate): candidate is HTMLElement =>
        isHTMLElement(candidate) && candidate.hasAttribute("data-code"),
    ),
  )
  const side: Option.Option<SourceSurfaceSide> = Option.flatMap(code, (codeElement) => {
    const explicitSides = [
      ["data-deletions", "deletions"],
      ["data-additions", "additions"],
    ] as const satisfies readonly (readonly [string, SourceSurfaceSide])[]
    const explicitSide: Option.Option<SourceSurfaceSide> = Option.map(
      Option.fromNullishOr(
        explicitSides.find(([attribute]) => codeElement.hasAttribute(attribute)),
      ),
      ([, value]) => value,
    )
    if (Option.isSome(explicitSide) || !codeElement.hasAttribute("data-unified")) {
      return explicitSide
    }
    const line = Option.fromNullishOr(
      path.find(
        (candidate): candidate is HTMLElement =>
          isHTMLElement(candidate) && candidate.hasAttribute("data-line-type"),
      ),
    )
    return Option.map(line, (lineElement) =>
      Option.getOrElse(
        HashMap.get(
          HashMap.fromIterable<string, SourceSurfaceSide>([["change-deletion", "deletions"]]),
          Option.getOrElse(Option.fromNullishOr(lineElement.dataset.lineType), () => ""),
        ),
        () => "additions",
      ),
    )
  })
  return Option.some({
    event,
    lineNumber: lineNumber.value,
    token: Option.some({
      surfaceId: rendered.value.surfaceId,
      lineNumber: lineNumber.value,
      lineCharStart: lineCharStart.value,
      lineCharEnd: lineCharStart.value + tokenText.length,
      tokenText,
      tokenElement: tokenElement.value,
      side,
    }),
  })
}

/** Decodes one Pierre zero-based DOM coordinate without accepting coercible malformed values. */
export const decodePierreNonNegativeInteger = (value: string | undefined): Option.Option<number> =>
  Option.filter(
    Option.map(Schema.decodeUnknownOption(SourceSurfaceLineIndexText)(value), Number),
    Number.isSafeInteger,
  )

/** Decodes one Pierre one-based line number. */
export const decodePierrePositiveInteger = (value: string | undefined): Option.Option<number> =>
  Option.filter(decodePierreNonNegativeInteger(value), (coordinate) => coordinate > 0)
