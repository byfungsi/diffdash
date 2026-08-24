import type { ReactNode } from "react"

/** Contribution-neutral metadata rendered by the host-owned Pierre adapter. */
export interface ReviewDiffAnnotationMetadata {
  readonly render: () => ReactNode
}
