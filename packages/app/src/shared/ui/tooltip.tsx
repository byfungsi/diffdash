import type { ComponentProps } from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/shared/utils"

/** Provides consistent delay behavior for application tooltips. */
export const TooltipProvider = ({
  delayDuration = 300,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Provider>) => (
  <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />
)

/** Owns one accessible tooltip interaction. */
export const Tooltip = (props: ComponentProps<typeof TooltipPrimitive.Root>) => (
  <TooltipPrimitive.Root {...props} />
)

/** Connects a tooltip to its hover and keyboard-focus target. */
export const TooltipTrigger = (props: ComponentProps<typeof TooltipPrimitive.Trigger>) => (
  <TooltipPrimitive.Trigger {...props} />
)

/** Renders tooltip content above workspace overlays. */
export const TooltipContent = ({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      sideOffset={sideOffset}
      className={cn(
        "bg-popover text-popover-foreground z-60 max-w-72 rounded-md border px-2.5 py-1.5 text-xs leading-5 shadow-search-floating",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
)
