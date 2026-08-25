import {
  isPublicReasonTransportErrorCode,
  toTransportError,
  transportError,
  TransportError,
} from "@diffdash/protocol/transport-error"
import {
  ReviewThreadAnchorInvalidError,
  ReviewThreadRevisionChangedError,
} from "@diffdash/domain/review-thread"
import { CodeWorkspaceError } from "@diffdash/domain/code-workspace"
import { Match, Option, Schema } from "effect"

/** Untrusted failure value accepted by the Electron public-error boundary. */
export type TransportFailure = Schema.Json | object | bigint | symbol | undefined

/** Adapts one main-process failure to bounded renderer-safe protocol data. */
export const toPublicIpcError = <A>(error: A, operation: string) => {
  return Match.value(toTransportFailure(error)).pipe(
    Match.when(Schema.is(TransportError), (value) => toTransportError(value, operation)),
    Match.when(Schema.is(ReviewThreadRevisionChangedError), () =>
      transportError(
        "REVIEW_CHANGED",
        "Review changed before the local thread was created.",
        operation,
      ),
    ),
    Match.when(Schema.is(ReviewThreadAnchorInvalidError), () =>
      transportError(
        "INVALID_REVIEW_ANCHOR",
        "Review thread anchor does not exist in the expected review revision.",
        operation,
      ),
    ),
    Match.when(Schema.is(CodeWorkspaceError), (failure) =>
      Match.value(failure.reason).pipe(
        Match.when("invalidPath", () =>
          transportError(
            "CODE_WORKSPACE_INVALID_PATH",
            "The requested repository path is invalid.",
            operation,
          ),
        ),
        Match.when("leaseExpired", () =>
          transportError(
            "CODE_WORKSPACE_LEASE_EXPIRED",
            "The Code workspace lease expired.",
            operation,
          ),
        ),
        Match.when("leaseNotFound", () =>
          transportError(
            "CODE_WORKSPACE_LEASE_NOT_FOUND",
            "The Code workspace lease is no longer available.",
            operation,
          ),
        ),
        Match.when("repositoryNotFound", () =>
          transportError(
            "CODE_WORKSPACE_REPOSITORY_NOT_FOUND",
            "The repository is no longer available.",
            operation,
          ),
        ),
        Match.when("repositoryUnavailable", () =>
          transportError(
            "CODE_WORKSPACE_REPOSITORY_UNAVAILABLE",
            "The linked repository checkout is unavailable.",
            operation,
          ),
        ),
        Match.when("revisionUnavailable", () =>
          transportError(
            "CODE_WORKSPACE_REVISION_UNAVAILABLE",
            "Git could not resolve the repository's current revision.",
            operation,
          ),
        ),
        Match.when("snapshotUnavailable", () =>
          transportError(
            "CODE_WORKSPACE_SNAPSHOT_UNAVAILABLE",
            "The review snapshot is no longer available.",
            operation,
          ),
        ),
        Match.when("workspaceUnavailable", () =>
          transportError(
            "CODE_WORKSPACE_UNAVAILABLE",
            "The Code workspace could not be prepared.",
            operation,
          ),
        ),
        Match.exhaustive,
      ),
    ),
    Match.when(
      Schema.is(
        Schema.Struct({
          code: Schema.String,
          safeMessage: Schema.String,
        }),
      ),
      (failure) => transportError(failure.code, failure.safeMessage, operation),
    ),
    Match.orElse((value) => {
      const domainFailure = safeDomainFailure(value)
      return domainFailure === null
        ? toTransportError(toTransportFailure(value), operation)
        : transportError(domainFailure.code, domainFailure.reason, operation)
    }),
  )
}

const safeDomainFailure = <A>(error: A) => {
  const decoded = Schema.decodeUnknownOption(
    Schema.Struct({ _tag: Schema.String, reason: Schema.String }),
  )(error)
  return Match.value(Option.getOrNull(decoded)).pipe(
    Match.when(null, () => null),
    Match.when(
      (value): value is { readonly _tag: string; readonly reason: string } =>
        isPublicReasonTransportErrorCode(value._tag),
      (value) => ({ code: value._tag, reason: value.reason }),
    ),
    Match.orElse(() => null),
  )
}

const toTransportFailure = <A>(error: A): TransportFailure =>
  Schema.is(Schema.Json)(error) || Schema.is(Schema.ErrorInstance())(error) ? error : undefined
