import {
  Group,
  type GroupProps,
  Panel,
  type PanelProps,
  Separator,
  type SeparatorProps,
} from "react-resizable-panels"
import { cn } from "@/shared/utils"

/** Resizable group with DiffDash's shared sizing and interaction defaults. */
export function PaneGroup({ className, ...props }: GroupProps) {
  return (
    <Group
      resizeTargetMinimumSize={{ coarse: 24, fine: 8 }}
      className={cn("h-full min-h-0 min-w-0 w-full", className)}
      {...props}
    />
  )
}

/** Constrained region within a resizable pane group. */
export function Pane({ className, style, ...props }: PanelProps) {
  return (
    <Panel
      className={cn("h-full min-h-0 min-w-0 w-full overflow-hidden", className)}
      style={{ ...style, overflow: "hidden" }}
      {...props}
    />
  )
}

/** Accessible pane separator with a narrow visual rule and forgiving hit target. */
export function PaneResizeHandle({ className, children, ...props }: SeparatorProps) {
  return (
    <Separator
      data-pane-resize-handle
      className={cn(
        "group relative z-40 w-0 cursor-col-resize touch-none bg-transparent outline-none",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className="bg-review-sidebar-divider group-hover:bg-review-sidebar-emphasis/60 group-focus-visible:bg-primary/55 pointer-events-none absolute inset-y-0 left-0 w-px transition-colors"
      />
      {children}
    </Separator>
  )
}
