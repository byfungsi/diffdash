import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware"

import { CoreReviewSessionFailure } from "./review-session"

/** Admission boundary for opening a foreground progressive review session. */
export class CoreReviewSessionOpenAdmissionMiddleware extends RpcMiddleware.Service<CoreReviewSessionOpenAdmissionMiddleware>()(
  "@diffdash/core-rpc/CoreReviewSessionOpenAdmissionMiddleware",
  { error: CoreReviewSessionFailure },
) {}

/** Admission boundary for exact-version progressive review reads. */
export class CoreReviewSessionAdmissionMiddleware extends RpcMiddleware.Service<CoreReviewSessionAdmissionMiddleware>()(
  "@diffdash/core-rpc/CoreReviewSessionAdmissionMiddleware",
  { error: CoreReviewSessionFailure },
) {}

/** Admission boundary for deterministic progressive review disposal. */
export class CoreReviewSessionCloseAdmissionMiddleware extends RpcMiddleware.Service<CoreReviewSessionCloseAdmissionMiddleware>()(
  "@diffdash/core-rpc/CoreReviewSessionCloseAdmissionMiddleware",
  { error: CoreReviewSessionFailure },
) {}
