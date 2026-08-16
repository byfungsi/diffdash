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
import { Match, Option, Schema } from "effect"

type TransportFailure = Schema.Json | object | bigint | symbol | undefined

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
