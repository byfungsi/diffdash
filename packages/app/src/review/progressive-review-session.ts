import type {
  CloseReviewSessionRequest,
  OpenReviewSessionRequest,
  ReviewSessionCapabilities,
  ReviewSessionIdentity,
  ReviewSessionState,
} from "@diffdash/protocol/review-session"
import {
  CloseReviewSessionRequest as CloseReviewSessionRequestSchema,
  ReviewSessionState as ReviewSessionStateSchema,
  reviewSessionCapabilities,
} from "@diffdash/protocol/review-session"
import { Match, Schema } from "effect"

import type { ReviewRendererCaches } from "./review-global-virtualizer"
import type { ReviewLoadScheduler } from "./review-load-scheduler"
import type { ReviewNavigatorController } from "./review-navigation"
import type { ReviewSearchController } from "./review-search-state"
import type { ReviewSnapshotPageSession } from "./review-snapshot-page-session"

/** Renderer output categories that must never cross progressive session ownership. */
export type ReviewSessionPublicationCategory =
  | "text"
  | "syntax"
  | "measurements"
  | "focus"
  | "hints"
  | "ownership"

/** Atomic connection whose subscription immediately publishes its authoritative current state. */
export interface ReviewSessionConnection {
  readonly subscribe: (listener: (state: ReviewSessionState) => void) => () => void
}

/** Browser-safe progressive session operations to be implemented by the Core preload binding. */
export interface ReviewSessionGateway {
  readonly openSession: (request: OpenReviewSessionRequest) => Promise<ReviewSessionConnection>
  readonly closeSession: (request: CloseReviewSessionRequest) => Promise<void>
}

/** Minimal disposable seam implemented by Pierre adapters and highlight owners. */
export interface ReviewSessionDisposable {
  readonly dispose: () => void
}

/** Minimal pool seam implemented by Pierre shell pools. */
export interface ReviewSessionShellPool {
  readonly clear: () => void
  readonly size: number
}

/** Existing review runtime owners coordinated as one progressive session generation. */
export interface ProgressiveReviewSessionResources {
  readonly loadScheduler: ReviewLoadScheduler
  readonly rendererCaches: readonly ReviewRendererCaches[]
  readonly pierreAdapters: readonly ReviewSessionDisposable[]
  readonly pierreShellPools: readonly ReviewSessionShellPool[]
  readonly snapshotPages: Pick<ReviewSnapshotPageSession, "dispose">
  readonly navigator: Pick<ReviewNavigatorController, "dispose">
  readonly search: Pick<ReviewSearchController, "dispose">
  readonly highlights: readonly ReviewSessionDisposable[]
}

/** Observable controller ownership used by deterministic disposal tests and diagnostics. */
export interface ProgressiveReviewSessionDiagnostics {
  readonly active: boolean
  readonly rejectedPublications: Readonly<Record<ReviewSessionPublicationCategory, number>>
  readonly state: ReviewSessionState | null
}

const makePublicationCounts = (): Record<ReviewSessionPublicationCategory, number> => ({
  text: 0,
  syntax: 0,
  measurements: 0,
  focus: 0,
  hints: 0,
  ownership: 0,
})

type ActiveSession = {
  readonly connection: ReviewSessionConnection
  readonly request: OpenReviewSessionRequest
  readonly resources: ProgressiveReviewSessionResources
  releaseSubscription: () => void
  state: ReviewSessionState | null
}

/**
 * Owns one renderer progressive-session generation, admitting only exact monotonic
 * publications and disposing every provisional renderer owner on replacement.
 */
export class ProgressiveReviewSessionController {
  readonly #rejectedPublications = makePublicationCounts()
  #active: ActiveSession | null = null
  #operation = 0
  #disposed = false

  constructor(
    private readonly gateway: ReviewSessionGateway,
    private readonly makeResources: (
      identity: ReviewSessionIdentity,
    ) => ProgressiveReviewSessionResources,
  ) {}

  /** Switches to one committed snapshot after deterministically closing the previous session. */
  readonly switchSession = async (request: OpenReviewSessionRequest): Promise<void> => {
    this.#assertUsable()
    const operation = ++this.#operation
    await this.#releaseActive()
    if (operation !== this.#operation || this.#disposed) return

    const connection = await this.gateway.openSession(request)
    if (operation !== this.#operation || this.#disposed) {
      await this.#closeSupersededConnection(connection)
      return
    }
    let active: ActiveSession | null = null
    const rejected: ReviewSessionState[] = []
    const releaseSubscription = connection.subscribe((candidate) => {
      const state = Schema.decodeUnknownSync(ReviewSessionStateSchema)(candidate)
      if (active === null) {
        if (!sameRequestedSnapshot(request, state.identity)) {
          this.#rejectedPublications.hints += 1
          rejected.push(state)
          return
        }
        active = {
          connection,
          request,
          resources: this.makeResources(state.identity),
          releaseSubscription: () => undefined,
          state: null,
        }
        this.#active = active
      }
      this.#acceptState(active, state)
    })
    const established = this.#active
    if (established === null) {
      releaseSubscription()
      const rejectedState = rejected.at(0)
      if (rejectedState !== undefined) {
        await this.gateway.closeSession(
          CloseReviewSessionRequestSchema.make({ identity: rejectedState.identity }),
        )
      }
      throw new Error("Review session gateway did not synchronously publish its current state")
    }
    established.releaseSubscription = releaseSubscription
  }

  readonly #closeSupersededConnection = async (
    connection: ReviewSessionConnection,
  ): Promise<void> => {
    const publications: ReviewSessionState[] = []
    const release = connection.subscribe((candidate) => {
      if (publications.length === 0) {
        publications.push(Schema.decodeUnknownSync(ReviewSessionStateSchema)(candidate))
      }
    })
    release()
    const current = publications.at(0)
    if (current !== undefined) {
      await this.gateway.closeSession(
        CloseReviewSessionRequestSchema.make({ identity: current.identity }),
      )
    }
  }

  /** Returns capabilities derived from the authoritative tag, never from caller flags. */
  readonly capabilities = (): ReviewSessionCapabilities => {
    const state = this.#active?.state
    return state === null || state === undefined
      ? {
          committedContent: "unavailable",
          search: "unavailable",
          filter: "unavailable",
          navigation: "unavailable",
          mutations: "disabled",
        }
      : reviewSessionCapabilities(state)
  }

  /** Publishes output only when every project/review/snapshot/process/session/version field matches. */
  readonly publish = (
    category: ReviewSessionPublicationCategory,
    identity: ReviewSessionIdentity,
    publication: () => void,
  ): boolean => {
    const state = this.#active?.state
    if (
      state === null ||
      state === undefined ||
      isTerminal(state) ||
      !sameSessionIdentity(state.identity, identity)
    ) {
      this.#rejectedPublications[category] += 1
      return false
    }
    publication()
    return true
  }

  /** Returns immutable lifecycle and stale-publication counters. */
  readonly diagnostics = (): ProgressiveReviewSessionDiagnostics => ({
    active: this.#active !== null,
    rejectedPublications: Object.freeze({ ...this.#rejectedPublications }),
    state: this.#active?.state ?? null,
  })

  /** Terminally cancels renderer work, releases resources, and closes the Core session. */
  readonly dispose = async (): Promise<void> => {
    if (this.#disposed) return
    this.#disposed = true
    this.#operation += 1
    await this.#releaseActive()
  }

  readonly #acceptState = (active: ActiveSession, candidate: ReviewSessionState): void => {
    if (this.#active !== active) {
      this.#rejectedPublications.hints += 1
      return
    }
    const current = active.state
    if (
      current !== null &&
      (!sameSessionGeneration(current.identity, candidate.identity) ||
        candidate.identity.stateVersion <= current.identity.stateVersion ||
        !isLegalProgression(current, candidate))
    ) {
      this.#rejectedPublications.hints += 1
      return
    }
    active.state = candidate
    if (isTerminal(candidate)) {
      queueMicrotask(() => {
        if (this.#active === active) void this.#releaseActive().catch(() => undefined)
      })
    }
  }

  readonly #releaseActive = async (): Promise<void> => {
    const active = this.#active
    if (active === null) return
    this.#active = null
    active.releaseSubscription()
    const failures: Error[] = []
    const attempt = (label: string, release: () => void): void => {
      try {
        release()
      } catch (cause) {
        failures.push(new Error(`Could not release ${label}`, { cause }))
      }
    }

    attempt("review load scheduler", () => active.resources.loadScheduler.dispose())
    for (const adapter of active.resources.pierreAdapters) {
      attempt("Pierre range adapter", adapter.dispose)
    }
    attempt("review search controller", active.resources.search.dispose)
    attempt("review navigator", active.resources.navigator.dispose)
    attempt("snapshot page session", active.resources.snapshotPages.dispose)
    for (const highlights of active.resources.highlights) {
      attempt("review highlights", highlights.dispose)
    }
    for (const caches of active.resources.rendererCaches) {
      attempt("renderer caches", () => caches.clear())
    }
    for (const shells of active.resources.pierreShellPools) {
      attempt("Pierre shell pool", () => shells.clear())
    }

    const identity = active.state?.identity
    if (identity !== undefined) {
      try {
        await this.gateway.closeSession(CloseReviewSessionRequestSchema.make({ identity }))
      } catch (cause) {
        failures.push(new Error("Could not close progressive review session", { cause }))
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Could not dispose progressive review session")
    }
  }

  readonly #assertUsable = (): void => {
    if (this.#disposed) throw new Error("ProgressiveReviewSessionController is disposed")
  }
}

const sameRequestedSnapshot = (
  request: OpenReviewSessionRequest,
  identity: ReviewSessionIdentity,
): boolean =>
  request.projectId === identity.projectId &&
  request.reviewKey === identity.reviewKey &&
  request.snapshotId === identity.snapshotId

const sameSessionGeneration = (
  left: ReviewSessionIdentity,
  right: ReviewSessionIdentity,
): boolean =>
  left.projectId === right.projectId &&
  left.reviewKey === right.reviewKey &&
  left.snapshotId === right.snapshotId &&
  left.processId === right.processId &&
  left.sessionId === right.sessionId

const sameSessionIdentity = (left: ReviewSessionIdentity, right: ReviewSessionIdentity): boolean =>
  sameSessionGeneration(left, right) && left.stateVersion === right.stateVersion

const isTerminal = (state: ReviewSessionState): boolean =>
  Match.valueTags(state, {
    negotiation: () => false,
    reservation: () => false,
    indexing: () => false,
    verification: () => false,
    ready: () => false,
    invalidated: () => true,
    failed: () => true,
    disposed: () => true,
  })

const progressionRank = (state: ReviewSessionState): number =>
  Match.valueTags(state, {
    negotiation: () => 0,
    reservation: () => 1,
    indexing: () => 2,
    verification: () => 3,
    ready: () => 4,
    invalidated: () => 5,
    failed: () => 5,
    disposed: () => 5,
  })

const isLegalProgression = (
  current: ReviewSessionState,
  candidate: ReviewSessionState,
): boolean => {
  if (isTerminal(current)) return false
  if (isTerminal(candidate)) return true
  return progressionRank(candidate) >= progressionRank(current)
}
