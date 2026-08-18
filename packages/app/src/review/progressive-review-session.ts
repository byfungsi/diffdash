import type {
  CloseReviewSessionRequest,
  OpenReviewSessionRequest,
  ReviewSessionState,
} from "@diffdash/protocol/review-session"

/** Atomic Core connection whose subscription publishes its authoritative current state. */
export interface ReviewSessionConnection {
  readonly subscribe: (listener: (state: ReviewSessionState) => void) => () => void
}

/** Browser-safe review session operations implemented by the Core preload binding. */
export interface ReviewSessionGateway {
  readonly openSession: (request: OpenReviewSessionRequest) => Promise<ReviewSessionConnection>
  readonly closeSession: (request: CloseReviewSessionRequest) => Promise<void>
}
