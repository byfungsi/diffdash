/* oxlint-disable eslint/no-underscore-dangle -- Ribbon lifecycle states use Effect-compatible _tag discriminants. */
import type { TransportError } from "@diffdash/protocol/transport-error"

/** Refresh activity retained alongside usable ribbon data. */
export type RibbonRefresh = "idle" | "refreshing"

/**
 * Renderer-local lifecycle for independently loaded project-workspace ribbons.
 * Data remains available while a ready, stale, or degraded ribbon refreshes.
 */
export type RibbonLifecycle<Data, Failure = TransportError, Issue = string> =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly data: Data; readonly refresh: RibbonRefresh }
  | { readonly _tag: "empty"; readonly refresh: RibbonRefresh }
  | { readonly _tag: "unavailable"; readonly reason: string }
  | { readonly _tag: "failure"; readonly error: Failure }
  | {
      readonly _tag: "stale"
      readonly data: Data
      readonly reason: string
      readonly refresh: RibbonRefresh
    }
  | { readonly _tag: "invalid"; readonly reason: string }
  | {
      readonly _tag: "degraded"
      readonly data: Data
      readonly issues: readonly [Issue, ...Issue[]]
      readonly refresh: RibbonRefresh
    }

/** Exhaustive handlers for every project-workspace ribbon lifecycle variant. */
export type RibbonLifecycleHandlers<Data, Failure, Issue, Result> = {
  readonly [Tag in RibbonLifecycle<Data, Failure, Issue>["_tag"]]: (
    state: Extract<RibbonLifecycle<Data, Failure, Issue>, { readonly _tag: Tag }>,
  ) => Result
}
