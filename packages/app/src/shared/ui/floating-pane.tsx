import { Option, Schema } from "effect"
import { X } from "lucide-react"
import { Popover } from "radix-ui"
import {
  createContext,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"

import { Button } from "@/shared/ui/button"
import { cn } from "@/shared/utils"

const FLOATING_PANE_MARGIN = 8
const FLOATING_PANE_DEFAULT_WIDTH = 384
const FLOATING_PANE_DEFAULT_HEIGHT = 256
const FLOATING_PANE_MIN_WIDTH = 240
const FLOATING_PANE_MIN_HEIGHT = 120
const FLOATING_PANE_RESIZE_STEP = 8
const FLOATING_PANE_SURFACE_CLASS_NAME =
  "bg-popover text-popover-foreground pointer-events-auto m-0 flex min-h-0 flex-col overflow-hidden rounded-xl border shadow-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/50"

const DEFAULT_FLOATING_PANE_POSITION: FloatingPanePosition = { x: 24, y: 24 }
const DEFAULT_FLOATING_PANE_SIZE: FloatingPaneSize = {
  width: FLOATING_PANE_DEFAULT_WIDTH,
  height: FLOATING_PANE_DEFAULT_HEIGHT,
}
const DEFAULT_FLOATING_PANE_MIN_SIZE: FloatingPaneSize = {
  width: FLOATING_PANE_MIN_WIDTH,
  height: FLOATING_PANE_MIN_HEIGHT,
}
const FLOATING_PANE_ARROW_DELTAS: Readonly<
  Partial<Record<string, { readonly width: number; readonly height: number }>>
> = {
  ArrowDown: { width: 0, height: 1 },
  ArrowLeft: { width: -1, height: 0 },
  ArrowRight: { width: 1, height: 0 },
  ArrowUp: { width: 0, height: -1 },
}

/** Position of a floating pane relative to its workspace. */
export const FloatingPanePosition = Schema.Struct({ x: Schema.Number, y: Schema.Number })

/** Position of a floating pane relative to its workspace. */
export type FloatingPanePosition = typeof FloatingPanePosition.Type

/** Width and height of a floating pane in CSS pixels. */
export const FloatingPaneSize = Schema.Struct({ width: Schema.Number, height: Schema.Number })

/** Width and height of a floating pane in CSS pixels. */
export type FloatingPaneSize = typeof FloatingPaneSize.Type

type FloatingPaneBounds = FloatingPanePosition & FloatingPaneSize

interface FloatingPaneWorkspaceValue {
  readonly activate: (paneId: string) => void
  readonly host: Option.Option<HTMLDivElement>
  readonly register: (paneId: string) => () => void
  readonly size: Option.Option<FloatingPaneSize>
  readonly stack: readonly string[]
}

const FloatingPaneWorkspaceContext = createContext<Option.Option<FloatingPaneWorkspaceValue>>(
  Option.none(),
)

const FloatingPaneBoundsSchema = Schema.Struct({
  height: Schema.Number,
  width: Schema.Number,
  x: Schema.Number,
  y: Schema.Number,
})

const FloatingPaneInteraction = Schema.TaggedUnion({
  Move: {
    pointerId: Schema.Int,
    startBounds: FloatingPaneBoundsSchema,
    startX: Schema.Number,
    startY: Schema.Number,
  },
  Resize: {
    pointerId: Schema.Int,
    startBounds: FloatingPaneBoundsSchema,
    startX: Schema.Number,
    startY: Schema.Number,
  },
})

type FloatingPaneInteraction = typeof FloatingPaneInteraction.Type

/** Bounds floating panes to one workbench region and coordinates their stacking order. */
export function FloatingPaneWorkspace({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  const [host, setHost] = useState<Option.Option<HTMLDivElement>>(Option.none())
  const [size, setSize] = useState<Option.Option<FloatingPaneSize>>(Option.none())
  const [stack, setStack] = useState<readonly string[]>([])

  useLayoutEffect(
    () =>
      Option.match(host, {
        onNone: () => undefined,
        onSome: (hostElement) => {
          const updateSize = () => {
            const rect = hostElement.getBoundingClientRect()
            setSize(Option.some({ width: rect.width, height: rect.height }))
          }
          updateSize()
          const observer = new ResizeObserver(updateSize)
          observer.observe(hostElement)
          return () => observer.disconnect()
        },
      }),
    [host],
  )

  const activate = useCallback((paneId: string) => {
    setStack((current) => {
      if (current.at(-1) === paneId) return current
      return [...current.filter((candidate) => candidate !== paneId), paneId]
    })
  }, [])
  const register = useCallback(
    (paneId: string) => {
      activate(paneId)
      return () => setStack((current) => current.filter((candidate) => candidate !== paneId))
    },
    [activate],
  )
  const contextValue = useMemo(
    () => Option.some({ activate, host, register, size, stack }),
    [activate, host, register, size, stack],
  )
  const updateHost = useCallback(
    (hostElement: HTMLDivElement | null) => setHost(Option.fromNullishOr(hostElement)),
    [],
  )

  return (
    <FloatingPaneWorkspaceContext.Provider value={contextValue}>
      <div data-floating-pane-workspace className={cn("relative isolate", className)} {...props}>
        {children}
        <div
          ref={updateHost}
          data-floating-pane-host
          className="pointer-events-none absolute inset-0 z-40 overflow-hidden"
        />
      </div>
    </FloatingPaneWorkspaceContext.Provider>
  )
}

/** Inputs for one non-modal, movable, and resizable floating pane. */
export interface FloatingPaneProps {
  readonly children: ReactNode
  readonly className?: string
  readonly defaultPosition?: FloatingPanePosition
  readonly defaultSize?: FloatingPaneSize
  readonly minSize?: FloatingPaneSize
  readonly title: string
  readonly onClose: () => void
}

/** Renders one session-local movable pane into the nearest floating-pane workspace. */
export function FloatingPane(props: FloatingPaneProps) {
  const workspace = useContext(FloatingPaneWorkspaceContext)
  return Option.match(workspace, {
    onNone: () => <FloatingPaneCompositionError name="FloatingPane" />,
    onSome: (value) => <FloatingPaneContent {...props} workspace={value} />,
  })
}

/** Inputs for a pane positioned against a live DOM anchor. */
export interface FloatingPaneAnchor {
  readonly getBoundingClientRect: () => DOMRect
}

/** Inputs for a pane positioned against a live or virtual anchor. */
export interface AnchoredFloatingPaneProps {
  readonly align?: "start" | "center" | "end"
  readonly anchor: FloatingPaneAnchor
  readonly ariaLabel: string
  readonly children: ReactNode
  readonly className?: string
  readonly side?: "top" | "right" | "bottom" | "left"
  readonly sideOffset?: number
  readonly onClose: () => void
}

/** Renders a collision-aware pane against an element, outside its scroll container. */
export function AnchoredFloatingPane(props: AnchoredFloatingPaneProps) {
  const workspace = useContext(FloatingPaneWorkspaceContext)
  return Option.match(workspace, {
    onNone: () => <FloatingPaneCompositionError name="AnchoredFloatingPane" />,
    onSome: (value) => <AnchoredFloatingPaneContent {...props} workspace={value} />,
  })
}

const AnchoredFloatingPaneContent = ({
  align = "start",
  anchor,
  ariaLabel,
  children,
  className,
  side = "bottom",
  sideOffset = 4,
  onClose,
  workspace,
}: AnchoredFloatingPaneProps & { readonly workspace: FloatingPaneWorkspaceValue }) => {
  const { activate, host, register, stack } = workspace
  const registryId = useId()
  const anchorRef = useRef<FloatingPaneAnchor>(anchor)
  anchorRef.current = anchor

  useLayoutEffect(() => register(registryId), [register, registryId])

  return Option.match(host, {
    onNone: () => null,
    onSome: (hostElement) => {
      const stackIndex = stack.indexOf(registryId)
      return (
        <Popover.Root
          open
          onOpenChange={(open) => {
            if (!open) onClose()
          }}
        >
          <Popover.Anchor virtualRef={anchorRef} />
          <Popover.Portal container={hostElement}>
            <Popover.Content
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- Native dialog positioning escapes Radix's virtual-anchor geometry.
              role="dialog"
              aria-label={ariaLabel}
              data-floating-pane={registryId}
              data-floating-pane-anchor=""
              data-floating-pane-active={dataAttribute(stackIndex === stack.length - 1)}
              align={align}
              avoidCollisions
              collisionBoundary={hostElement}
              collisionPadding={FLOATING_PANE_MARGIN}
              hideWhenDetached
              side={side}
              sideOffset={sideOffset}
              sticky="always"
              updatePositionStrategy="always"
              style={{
                maxHeight: "var(--radix-popover-content-available-height)",
                maxWidth: "var(--radix-popover-content-available-width)",
                zIndex: Math.max(0, stackIndex),
              }}
              className={cn(FLOATING_PANE_SURFACE_CLASS_NAME, className)}
              onFocusCapture={() => activate(registryId)}
              onPointerDown={() => activate(registryId)}
            >
              {children}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )
    },
  })
}

const FloatingPaneContent = ({
  children,
  className,
  defaultPosition = DEFAULT_FLOATING_PANE_POSITION,
  defaultSize = DEFAULT_FLOATING_PANE_SIZE,
  minSize = DEFAULT_FLOATING_PANE_MIN_SIZE,
  title,
  onClose,
  workspace,
}: FloatingPaneProps & { readonly workspace: FloatingPaneWorkspaceValue }) => {
  const { activate, host, register, size: workspaceSize, stack } = workspace
  const registryId = useId()
  const titleId = useId()
  const paneRef = useRef<HTMLDialogElement>(null)
  const interactionRef = useRef<Option.Option<FloatingPaneInteraction>>(Option.none())
  const [bounds, setBounds] = useState<FloatingPaneBounds>(() => ({
    ...defaultPosition,
    ...defaultSize,
  }))

  useLayoutEffect(() => register(registryId), [register, registryId])

  useLayoutEffect(() => {
    Option.match(workspaceSize, {
      onNone: () => undefined,
      onSome: (measuredSize) =>
        setBounds((current) => clampFloatingPaneBounds(current, minSize, measuredSize)),
    })
  }, [minSize, workspaceSize])

  useLayoutEffect(() => {
    const activePane = Option.filter(Option.fromNullishOr(paneRef.current), (pane) => {
      const focusOutsidePane = Option.match(Option.fromNullishOr(document.activeElement), {
        onNone: () => true,
        onSome: (focusedElement) => !pane.contains(focusedElement),
      })
      return (
        Option.contains(Option.fromNullishOr(stack.at(-1)), registryId) &&
        Option.isSome(host) &&
        focusOutsidePane
      )
    })
    Option.match(activePane, {
      onNone: () => undefined,
      onSome: (pane) => pane.focus({ preventScroll: true }),
    })
  }, [host, registryId, stack])

  const beginInteraction = (
    interaction: FloatingPaneInteraction,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    if (event.button !== 0) return
    event.preventDefault()
    activate(registryId)
    event.currentTarget.setPointerCapture(event.pointerId)
    interactionRef.current = Option.some(interaction)
  }
  const continueInteraction = (event: ReactPointerEvent<HTMLElement>) => {
    Option.match(interactionRef.current, {
      onNone: () => undefined,
      onSome: (interaction) => {
        if (interaction.pointerId !== event.pointerId) return
        const deltaX = event.clientX - interaction.startX
        const deltaY = event.clientY - interaction.startY
        const next = FloatingPaneInteraction.match(interaction, {
          Move: (active) => ({
            ...active.startBounds,
            x: active.startBounds.x + deltaX,
            y: active.startBounds.y + deltaY,
          }),
          Resize: (active) => ({
            ...active.startBounds,
            width: active.startBounds.width + deltaX,
            height: active.startBounds.height + deltaY,
          }),
        })
        Option.match(workspaceSize, {
          onNone: () => undefined,
          onSome: (measuredSize) => setBounds(clampFloatingPaneBounds(next, minSize, measuredSize)),
        })
      },
    })
  }
  const endInteraction = (event: ReactPointerEvent<HTMLElement>) => {
    Option.match(interactionRef.current, {
      onNone: () => undefined,
      onSome: (interaction) => {
        if (interaction.pointerId !== event.pointerId) return
        interactionRef.current = Option.none()
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      },
    })
  }
  const resizeFromKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    let step = FLOATING_PANE_RESIZE_STEP
    if (event.shiftKey) step *= 4
    Option.match(Option.fromNullishOr(FLOATING_PANE_ARROW_DELTAS[event.key]), {
      onNone: () => undefined,
      onSome: (delta) => {
        event.preventDefault()
        event.stopPropagation()
        Option.match(workspaceSize, {
          onNone: () => undefined,
          onSome: (measuredSize) =>
            setBounds((current) =>
              clampFloatingPaneBounds(
                {
                  ...current,
                  width: current.width + delta.width * step,
                  height: current.height + delta.height * step,
                },
                minSize,
                measuredSize,
              ),
            ),
        })
      },
    })
  }
  const moveFromKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    let step = FLOATING_PANE_RESIZE_STEP
    if (event.shiftKey) step *= 4
    Option.match(Option.fromNullishOr(FLOATING_PANE_ARROW_DELTAS[event.key]), {
      onNone: () => undefined,
      onSome: (delta) => {
        event.preventDefault()
        event.stopPropagation()
        Option.match(workspaceSize, {
          onNone: () => undefined,
          onSome: (measuredSize) =>
            setBounds((current) =>
              clampFloatingPaneBounds(
                {
                  ...current,
                  x: current.x + delta.width * step,
                  y: current.y + delta.height * step,
                },
                minSize,
                measuredSize,
              ),
            ),
        })
      },
    })
  }

  return Option.match(host, {
    onNone: () => null,
    onSome: (hostElement) => {
      const stackIndex = stack.indexOf(registryId)
      const style = {
        height: bounds.height,
        transform: `translate3d(${bounds.x}px, ${bounds.y}px, 0)`,
        width: bounds.width,
        zIndex: Math.max(0, stackIndex),
      } satisfies CSSProperties

      return createPortal(
        <dialog
          ref={paneRef}
          open
          aria-modal="false"
          aria-labelledby={titleId}
          data-floating-pane={registryId}
          data-floating-pane-active={dataAttribute(stackIndex === stack.length - 1)}
          tabIndex={-1}
          style={style}
          className={cn(FLOATING_PANE_SURFACE_CLASS_NAME, "absolute top-0 left-0", className)}
          onFocusCapture={() => activate(registryId)}
          onPointerDown={() => activate(registryId)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return
            event.preventDefault()
            event.stopPropagation()
            onClose()
          }}
        >
          <header className="bg-muted/55 flex h-9 shrink-0 items-center border-b">
            <button
              type="button"
              data-floating-pane-drag-handle
              aria-label={`Move ${title}`}
              className="flex h-full min-w-0 flex-1 cursor-move touch-none select-none items-center px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
              onKeyDown={moveFromKeyboard}
              onPointerDown={(event) =>
                beginInteraction(
                  FloatingPaneInteraction.cases.Move.make({
                    pointerId: event.pointerId,
                    startBounds: bounds,
                    startX: event.clientX,
                    startY: event.clientY,
                  }),
                  event,
                )
              }
              onPointerMove={continueInteraction}
              onPointerUp={endInteraction}
              onPointerCancel={endInteraction}
            >
              <h2 id={titleId} className="min-w-0 flex-1 truncate text-xs font-semibold">
                {title}
              </h2>
            </button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={`Close ${title}`}
              className="mr-2 cursor-default"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onClose}
            >
              <X />
            </Button>
          </header>
          <div className="min-h-0 flex-1 overflow-auto">{children}</div>
          <button
            type="button"
            data-floating-pane-resize-handle
            aria-label={`Resize ${title}`}
            className="focus-visible:bg-primary/15 absolute right-0 bottom-0 size-6 cursor-nwse-resize touch-none rounded-tl-sm bg-transparent outline-none after:absolute after:right-1 after:bottom-1 after:size-2 after:border-r after:border-b after:border-muted-foreground/60"
            onKeyDown={resizeFromKeyboard}
            onPointerDown={(event) =>
              beginInteraction(
                FloatingPaneInteraction.cases.Resize.make({
                  pointerId: event.pointerId,
                  startBounds: bounds,
                  startX: event.clientX,
                  startY: event.clientY,
                }),
                event,
              )
            }
            onPointerMove={continueInteraction}
            onPointerUp={endInteraction}
            onPointerCancel={endInteraction}
          />
        </dialog>,
        hostElement,
      )
    },
  })
}

const FloatingPaneCompositionError = ({ name }: { readonly name: string }) => (
  <span role="alert" data-floating-pane-composition-error>
    {name} requires a FloatingPaneWorkspace.
  </span>
)

const clampFloatingPaneBounds = (
  bounds: FloatingPaneBounds,
  minimum: FloatingPaneSize,
  workspace: FloatingPaneSize,
): FloatingPaneBounds => {
  const availableWidth = Math.max(0, workspace.width - FLOATING_PANE_MARGIN * 2)
  const availableHeight = Math.max(0, workspace.height - FLOATING_PANE_MARGIN * 2)
  const width = clamp(bounds.width, Math.min(minimum.width, availableWidth), availableWidth)
  const height = clamp(bounds.height, Math.min(minimum.height, availableHeight), availableHeight)
  return {
    width,
    height,
    x: clamp(
      bounds.x,
      FLOATING_PANE_MARGIN,
      Math.max(FLOATING_PANE_MARGIN, workspace.width - width - FLOATING_PANE_MARGIN),
    ),
    y: clamp(
      bounds.y,
      FLOATING_PANE_MARGIN,
      Math.max(FLOATING_PANE_MARGIN, workspace.height - height - FLOATING_PANE_MARGIN),
    ),
  }
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value))

const dataAttribute = (present: boolean): "" | undefined => {
  if (present) return ""
  return undefined
}
