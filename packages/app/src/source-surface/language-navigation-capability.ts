import {
  LanguagePosition,
  LanguageRange,
  type RepositoryLanguageLocationLink,
  RepositoryLanguageLocationResult,
} from "@diffdash/domain/language"
import { Effect, Option, Schema } from "effect"
import { useEffect, useRef, useState, type RefObject } from "react"

import {
  SourceSurfaceContributionId,
  type SourceSurfaceInteractionRoute,
  type SourceSurfaceRuntime,
  type SourceSurfaceTokenCoordinates,
  type SourceSurfaceTokenTarget,
} from "./source-surface-runtime"
import { useStableCallback } from "@/review/pierre"
import type { FloatingPaneAnchor } from "@/shared/ui/floating-pane"
import { isMacPlatform } from "@/shell/keyboard-shortcut-platform"
import { formatError } from "@/shared/errors"

const LanguageNavigationIntent = Schema.Literals([
  "goToDefinition",
  "peekDefinition",
  "findReferences",
])

type LanguageNavigationIntent = typeof LanguageNavigationIntent.Type

const LANGUAGE_NAVIGATION_CAPABILITY_ID = SourceSurfaceContributionId.make(
  "diffdash.builtin.language-navigation",
)

type LanguageNavigationModifiers = Pick<
  MouseEvent | PointerEvent | globalThis.KeyboardEvent,
  "altKey" | "ctrlKey" | "metaKey" | "shiftKey"
>

/** Kind of language locations displayed by the generic Peek pane. */
export const LanguageNavigationPeekKind = Schema.Literals(["definitions", "references"])

/** Kind of language locations displayed by the generic Peek pane. */
export type LanguageNavigationPeekKind = typeof LanguageNavigationPeekKind.Type

/** Exhaustive content state shown by the generic language Peek pane. */
export const LanguageNavigationPeekContent = Schema.TaggedUnion({
  results: {
    kind: LanguageNavigationPeekKind,
    result: RepositoryLanguageLocationResult,
  },
  failure: {
    kind: LanguageNavigationPeekKind,
    message: Schema.String,
  },
})

/** Exhaustive content state shown by the generic language Peek pane. */
export type LanguageNavigationPeekContent = typeof LanguageNavigationPeekContent.Type

/** State needed to place and populate a language-location Peek pane. */
export interface LanguageNavigationPeekState {
  readonly anchor: FloatingPaneAnchor
  readonly content: LanguageNavigationPeekContent
  readonly id: number
  readonly origin: LanguageNavigationOrigin
}

/** Semantic source location retained while resolving or selecting a language destination. */
export interface LanguageNavigationOrigin {
  readonly range: LanguageRange
  readonly surfaceId: string
}

/** Reversible source and target pair produced by language navigation. */
export interface LanguageNavigationDestination {
  readonly location: RepositoryLanguageLocationLink
  readonly origin: LanguageNavigationOrigin
}

/** Definition and reference providers consumed by generic source-surface navigation. */
export interface LanguageNavigationProviders {
  readonly definitions: Option.Option<
    (position: LanguagePosition, signal: AbortSignal) => Promise<RepositoryLanguageLocationResult>
  >
  readonly references: Option.Option<
    (position: LanguagePosition, signal: AbortSignal) => Promise<RepositoryLanguageLocationResult>
  >
}

/** Renderer adapter callbacks and Peek state owned by language navigation. */
export interface LanguageNavigationCapability {
  readonly closePeek: () => void
  readonly onTokenEnter: (token: SourceSurfaceTokenCoordinates, event: PointerEvent) => void
  readonly onTokenLeave: (token: SourceSurfaceTokenCoordinates) => void
  readonly peek: Option.Option<LanguageNavigationPeekState>
}

/** Registers generic definition/reference behavior against independently supplied providers. */
export const useLanguageNavigationCapability = <Instance>({
  navigate,
  providers,
  rootRef,
  runtime,
  surfaceId,
}: {
  readonly navigate: Option.Option<(destination: LanguageNavigationDestination) => void>
  readonly providers: LanguageNavigationProviders
  readonly rootRef: RefObject<HTMLElement | null>
  readonly runtime: SourceSurfaceRuntime<Instance>
  readonly surfaceId: string
}): LanguageNavigationCapability => {
  const [peek, setPeek] = useState<Option.Option<LanguageNavigationPeekState>>(Option.none())
  const hoveredTokenRef = useRef<Option.Option<SourceSurfaceTokenTarget>>(Option.none())
  const hoverRequestRef = useRef<
    Option.Option<{
      controller: AbortController
      sequence: number
      tokenElement: HTMLElement
    }>
  >(Option.none())
  const navigationRequestRef = useRef<
    Option.Option<{
      controller: AbortController
      sequence: number
    }>
  >(Option.none())
  const sequenceRef = useRef(0)

  const clearHover = useStableCallback(() => {
    Option.map(hoverRequestRef.current, ({ controller }) => controller.abort())
    hoverRequestRef.current = Option.none()
    Option.map(hoveredTokenRef.current, ({ tokenElement }) =>
      tokenElement.removeAttribute("data-diffdash-definition-link"),
    )
  })
  const clearNavigationRequest = useStableCallback(() => {
    Option.map(navigationRequestRef.current, ({ controller }) => controller.abort())
    navigationRequestRef.current = Option.none()
  })
  const requestLocations = useStableCallback(
    async (
      token: SourceSurfaceTokenTarget,
      intent: LanguageNavigationIntent,
      mode: "hover" | "open",
    ) => {
      const open = mode === "open"
      const providerRequest = LanguageNavigationRequest.match(
        LanguageNavigationRequest.cases[intent].make({}),
        {
          findReferences: () => providers.references,
          goToDefinition: () => providers.definitions,
          peekDefinition: () => providers.definitions,
        },
      )
      if (Option.isNone(providerRequest)) return
      if (!open && Option.isSome(navigationRequestRef.current)) {
        hoveredTokenRef.current = Option.some(token)
        token.tokenElement.setAttribute("data-diffdash-definition-link", "")
        return
      }
      if (open) {
        clearHover()
        clearNavigationRequest()
        setPeek(Option.none())
      } else {
        clearHover()
        hoveredTokenRef.current = Option.some(token)
        token.tokenElement.setAttribute("data-diffdash-definition-link", "")
      }
      const sequence = sequenceRef.current + 1
      sequenceRef.current = sequence
      const controller = new AbortController()
      if (open) navigationRequestRef.current = Option.some({ controller, sequence })
      else {
        hoverRequestRef.current = Option.some({
          controller,
          sequence,
          tokenElement: token.tokenElement,
        })
      }
      const origin = languageNavigationOrigin(token)
      try {
        const result = await providerRequest.value(
          new LanguagePosition({ line: token.lineNumber - 1, character: token.lineCharStart }),
          controller.signal,
        )
        let requestIsActive = Option.exists(
          hoverRequestRef.current,
          (request) => request.sequence === sequence,
        )
        if (open) {
          requestIsActive = Option.exists(
            navigationRequestRef.current,
            (request) => request.sequence === sequence,
          )
        }
        if (controller.signal.aborted || !requestIsActive) {
          return
        }
        if (result.locations.length === 0) {
          if (!open) token.tokenElement.removeAttribute("data-diffdash-definition-link")
          return
        }
        if (!open) {
          token.tokenElement.setAttribute("data-diffdash-definition-link", "")
          return
        }
        if (intent === "goToDefinition" && result.locations.length === 1) {
          const target = Option.fromNullishOr(result.locations[0])
          if (Option.isSome(target) && Option.isSome(navigate)) {
            navigate.value({ location: target.value, origin })
          }
          return
        }
        setPeek(
          Option.some({
            anchor: runtime.createTokenAnchor(token),
            content: LanguageNavigationPeekContent.cases.results.make({
              kind: languageNavigationPeekKind(intent),
              result,
            }),
            id: sequence,
            origin,
          }),
        )
      } catch (error) {
        if (controller.signal.aborted) return
        if (
          !open &&
          Option.exists(
            hoverRequestRef.current,
            ({ tokenElement }) => tokenElement === token.tokenElement,
          )
        ) {
          token.tokenElement.removeAttribute("data-diffdash-definition-link")
        }
        if (open) {
          setPeek(
            Option.some({
              anchor: runtime.createTokenAnchor(token),
              content: LanguageNavigationPeekContent.cases.failure.make({
                kind: languageNavigationPeekKind(intent),
                message: formatError(error, "Language locations could not be loaded."),
              }),
              id: sequence,
              origin,
            }),
          )
        }
      } finally {
        if (
          open &&
          Option.exists(navigationRequestRef.current, (request) => request.sequence === sequence)
        ) {
          navigationRequestRef.current = Option.none()
        } else if (
          !open &&
          Option.exists(hoverRequestRef.current, (request) => request.sequence === sequence)
        ) {
          hoverRequestRef.current = Option.none()
        }
      }
    },
  )
  const onTokenEnter = useStableCallback(
    (coordinates: SourceSurfaceTokenCoordinates, event: PointerEvent) => {
      const token = { ...coordinates, surfaceId }
      hoveredTokenRef.current = Option.some(token)
      const intent = languageNavigationIntent(event)
      if (Option.isNone(intent)) return
      token.tokenElement.setAttribute("data-diffdash-definition-link", "")
      void requestLocations(token, intent.value, "hover")
    },
  )
  const onTokenLeave = useStableCallback((token: SourceSurfaceTokenCoordinates) => {
    if (
      !Option.exists(
        hoveredTokenRef.current,
        ({ tokenElement }) => tokenElement === token.tokenElement,
      )
    ) {
      return
    }
    clearHover()
    hoveredTokenRef.current = Option.none()
  })
  const handleClick = useStableCallback<SourceSurfaceInteractionRoute["handle"]>(
    ({ event, token }) => {
      const intent = languageNavigationIntent(event)
      if (Option.isNone(intent) || Option.isNone(token)) return false
      document.getSelection()?.removeAllRanges()
      void requestLocations(token.value, intent.value, "open")
      return true
    },
  )

  useEffect(
    () =>
      Effect.runSync(
        runtime.registerInteractionRoute({
          id: LANGUAGE_NAVIGATION_CAPABILITY_ID,
          phase: "modifiedToken",
          handle: handleClick,
        }),
      ),
    [handleClick, runtime],
  )

  useEffect(() => {
    const root = rootRef.current
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!isLanguageNavigationModifierKey(event) || event.repeat) return
      const token = hoveredTokenRef.current
      if (Option.isNone(token)) return
      const intent = languageNavigationIntent(event)
      if (Option.isNone(intent)) return
      token.value.tokenElement.setAttribute("data-diffdash-definition-link", "")
      void requestLocations(token.value, intent.value, "hover")
    }
    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      if (!isLanguageNavigationModifierKey(event)) return
      clearHover()
      const token = hoveredTokenRef.current
      const intent = languageNavigationIntent(event)
      if (Option.isSome(token) && Option.isSome(intent)) {
        void requestLocations(token.value, intent.value, "hover")
      }
    }
    window.addEventListener("keydown", onKeyDown, true)
    window.addEventListener("keyup", onKeyUp, true)
    window.addEventListener("blur", clearHover)
    root?.addEventListener("scroll", clearHover, { passive: true })
    return () => {
      window.removeEventListener("keydown", onKeyDown, true)
      window.removeEventListener("keyup", onKeyUp, true)
      window.removeEventListener("blur", clearHover)
      root?.removeEventListener("scroll", clearHover)
      clearHover()
      clearNavigationRequest()
    }
  }, [clearHover, clearNavigationRequest, requestLocations, rootRef])

  return {
    closePeek: () => setPeek(Option.none()),
    onTokenEnter,
    onTokenLeave,
    peek,
  }
}

const languageNavigationOrigin = (token: SourceSurfaceTokenTarget): LanguageNavigationOrigin => {
  const line = token.lineNumber - 1
  return {
    surfaceId: token.surfaceId,
    range: new LanguageRange({
      start: new LanguagePosition({ line, character: token.lineCharStart }),
      end: new LanguagePosition({ line, character: token.lineCharEnd }),
    }),
  }
}

/** Returns whether modifiers reserve an interaction for built-in language navigation. */
export const isLanguageNavigationInteraction = (event: LanguageNavigationModifiers): boolean =>
  Option.isSome(languageNavigationIntent(event))

const languageNavigationIntent = (
  event: LanguageNavigationModifiers,
): Option.Option<LanguageNavigationIntent> => {
  let primary = event.ctrlKey
  if (isMacPlatform()) primary = event.metaKey
  if (primary && event.shiftKey && !event.altKey) return Option.some("findReferences")
  if (event.altKey && !primary && !event.shiftKey) return Option.some("peekDefinition")
  if (primary && !event.shiftKey && !event.altKey) return Option.some("goToDefinition")
  return Option.none()
}

const LanguageNavigationRequest = Schema.TaggedUnion({
  goToDefinition: {},
  peekDefinition: {},
  findReferences: {},
})

const languageNavigationPeekKind = (intent: LanguageNavigationIntent): LanguageNavigationPeekKind =>
  LanguageNavigationRequest.match(LanguageNavigationRequest.cases[intent].make({}), {
    findReferences: () => "references" as const,
    goToDefinition: () => "definitions" as const,
    peekDefinition: () => "definitions" as const,
  })

const isLanguageNavigationModifierKey = (event: globalThis.KeyboardEvent): boolean =>
  ["Alt", "Control", "Meta", "Shift"].includes(event.key)
