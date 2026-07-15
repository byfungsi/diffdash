import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const surfaceVariants = cva("border bg-card text-card-foreground", {
  variants: {
    variant: {
      default: "rounded-xl border-border shadow-xs",
      floatingSearch:
        "overflow-hidden rounded-2xl border-search-surface-border bg-search-surface transition-shadow",
    },
    active: {
      true: "shadow-search-floating",
      false: "shadow-sm",
    },
  },
  defaultVariants: {
    active: false,
    variant: "default",
  },
})

/** Theme-backed non-card surface primitive for reusable app chrome. */
function Surface({
  active,
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof surfaceVariants>) {
  return <div className={cn(surfaceVariants({ active, variant, className }))} {...props} />
}

export { Surface, surfaceVariants }
