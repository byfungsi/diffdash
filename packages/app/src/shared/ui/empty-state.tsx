import type { ReactNode } from "react"

/** Dashed empty/loading message used across application feature screens. */
export const EmptyState = ({
  children,
  className = "",
}: {
  readonly children: ReactNode
  readonly className?: string
}) => (
  <div
    className={`text-muted-foreground rounded-2xl border border-dashed p-8 text-center text-sm ${className}`}
  >
    {children}
  </div>
)
