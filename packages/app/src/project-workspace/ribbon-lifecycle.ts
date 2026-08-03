/* oxlint-disable eslint/no-underscore-dangle -- Ribbon lifecycle states use Effect-compatible _tag discriminants. */
import type { ProjectWorkspaceRibbon } from "@diffdash/domain/project-workspace"
import { Match } from "effect"

/** Stable semantic identifiers for project-workspace ribbons. */
export const ProjectWorkspaceRibbonIds = {
  Reviews: "reviews",
  Files: "files",
  Walkthrough: "walkthrough",
  Threads: "threads",
} as const satisfies Readonly<Record<string, ProjectWorkspaceRibbon>>

/** Semantic identifier for a project-workspace ribbon. */
export type ProjectWorkspaceRibbonId = ProjectWorkspaceRibbon

/**
 * Renderer-local lifecycle for independently loaded project-workspace ribbons.
 * Data remains available while a ready, stale, or degraded ribbon refreshes.
 */
export type RibbonLifecycle<Data, Failure = unknown, Issue = string> =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly data: Data; readonly refreshing: boolean }
  | { readonly _tag: "empty"; readonly refreshing: boolean }
  | { readonly _tag: "unavailable"; readonly reason: string }
  | { readonly _tag: "failure"; readonly error: Failure }
  | {
      readonly _tag: "stale"
      readonly data: Data
      readonly reason: string
      readonly refreshing: boolean
    }
  | { readonly _tag: "invalid"; readonly reason: string }
  | {
      readonly _tag: "degraded"
      readonly data: Data
      readonly issues: readonly [Issue, ...Issue[]]
      readonly refreshing: boolean
    }

/** Exhaustive handlers for every project-workspace ribbon lifecycle variant. */
export type RibbonLifecycleHandlers<Data, Failure, Issue, Result> = {
  readonly [Tag in RibbonLifecycle<Data, Failure, Issue>["_tag"]]: (
    state: Extract<RibbonLifecycle<Data, Failure, Issue>, { readonly _tag: Tag }>,
  ) => Result
}

/** Matches a ribbon lifecycle state and requires a handler for every variant. */
export const matchRibbonLifecycle = <Data, Failure, Issue, Result>(
  state: RibbonLifecycle<Data, Failure, Issue>,
  handlers: RibbonLifecycleHandlers<Data, Failure, Issue, Result>,
): Result => Match.typeTags<RibbonLifecycle<Data, Failure, Issue>, Result>()(handlers)(state)
