import { Schema } from "effect"

import { ApplicationInstanceId, CoreProcessEpoch, HostRequestId } from "./identity"
import { CoreLifecycleState } from "./lifecycle"

/** Retry classification safe to expose outside the Core process. */
export const CoreRpcRetryClass = Schema.Literals(["automatic", "userAction", "notRetryable"])

/** Retry classification safe to expose outside the Core process. */
export type CoreRpcRetryClass = typeof CoreRpcRetryClass.Type

const isSafeMessage = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (
      codePoint === undefined ||
      codePoint < 0x20 ||
      codePoint === 0x7f ||
      codePoint === 0x85 ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      return false
    }
  }
  return true
}

/** Bounded single-line message that contains no private diagnostic detail. */
export const CoreRpcSafeMessage = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(240)),
  Schema.check(Schema.makeFilter(isSafeMessage, { message: "Invalid Core RPC safe message" })),
)

/** Bounded single-line message that contains no private diagnostic detail. */
export type CoreRpcSafeMessage = typeof CoreRpcSafeMessage.Type

const CoreRpcFailureIdentity = {
  applicationInstanceId: ApplicationInstanceId,
  processEpoch: CoreProcessEpoch,
  requestId: HostRequestId,
} as const

const CoreControlDefectIdentity = {
  ...CoreRpcFailureIdentity,
  code: Schema.Literal("CORE_INTERNAL_ERROR"),
  retryClass: Schema.Literal("notRetryable"),
  safeMessage: Schema.Literal("DiffDash Core encountered an internal control-plane error."),
} as const

const CoreRpcDefectValue = Schema.NullishOr(Schema.ObjectKeyword)

/** Identity mismatch returned by `Core.health`. */
export const CoreHealthIdentityMismatchFailure = Schema.TaggedStruct(
  "CoreIdentityMismatchFailure",
  {
    code: Schema.Literal("CORE_REQUEST_IDENTITY_MISMATCH"),
    method: Schema.Literal("Core.health"),
    ...CoreRpcFailureIdentity,
    retryClass: Schema.Literal("automatic"),
    safeMessage: Schema.Literal(
      "DiffDash Core rejected a request for a different process identity.",
    ),
  },
).annotate({ identifier: "CoreHealthIdentityMismatchFailure" })

/** Identity mismatch returned by `Core.health`. */
export type CoreHealthIdentityMismatchFailure = typeof CoreHealthIdentityMismatchFailure.Type

/** Identity mismatch returned by `Core.authorizeDatabaseOwnership`. */
export const CoreAuthorizeDatabaseOwnershipIdentityMismatchFailure = Schema.TaggedStruct(
  "CoreIdentityMismatchFailure",
  {
    code: Schema.Literal("CORE_REQUEST_IDENTITY_MISMATCH"),
    method: Schema.Literal("Core.authorizeDatabaseOwnership"),
    ...CoreRpcFailureIdentity,
    retryClass: Schema.Literal("automatic"),
    safeMessage: Schema.Literal(
      "DiffDash Core rejected a request for a different process identity.",
    ),
  },
).annotate({ identifier: "CoreAuthorizeDatabaseOwnershipIdentityMismatchFailure" })

/** Identity mismatch returned by `Core.authorizeDatabaseOwnership`. */
export type CoreAuthorizeDatabaseOwnershipIdentityMismatchFailure =
  typeof CoreAuthorizeDatabaseOwnershipIdentityMismatchFailure.Type

/** Identity mismatch returned by `Core.shutdown`. */
export const CoreShutdownIdentityMismatchFailure = Schema.TaggedStruct(
  "CoreIdentityMismatchFailure",
  {
    code: Schema.Literal("CORE_REQUEST_IDENTITY_MISMATCH"),
    method: Schema.Literal("Core.shutdown"),
    ...CoreRpcFailureIdentity,
    retryClass: Schema.Literal("automatic"),
    safeMessage: Schema.Literal(
      "DiffDash Core rejected a request for a different process identity.",
    ),
  },
).annotate({ identifier: "CoreShutdownIdentityMismatchFailure" })

/** Identity mismatch returned by `Core.shutdown`. */
export type CoreShutdownIdentityMismatchFailure = typeof CoreShutdownIdentityMismatchFailure.Type

/** Lifecycle rejection returned by database ownership authorization. */
export const CoreAuthorizeDatabaseOwnershipLifecycleRejectedFailure = Schema.TaggedStruct(
  "CoreLifecycleRejectedFailure",
  {
    code: Schema.Literal("CORE_LIFECYCLE_REJECTED"),
    method: Schema.Literal("Core.authorizeDatabaseOwnership"),
    ...CoreRpcFailureIdentity,
    lifecycle: CoreLifecycleState,
    retryClass: Schema.Literal("notRetryable"),
    safeMessage: Schema.Literal("DiffDash Core rejected a request in its current lifecycle state."),
  },
).annotate({ identifier: "CoreAuthorizeDatabaseOwnershipLifecycleRejectedFailure" })

/** Lifecycle rejection returned by database ownership authorization. */
export type CoreAuthorizeDatabaseOwnershipLifecycleRejectedFailure =
  typeof CoreAuthorizeDatabaseOwnershipLifecycleRejectedFailure.Type

/** Lifecycle rejection returned by `Core.shutdown`. */
export const CoreShutdownLifecycleRejectedFailure = Schema.TaggedStruct(
  "CoreLifecycleRejectedFailure",
  {
    code: Schema.Literal("CORE_LIFECYCLE_REJECTED"),
    method: Schema.Literal("Core.shutdown"),
    ...CoreRpcFailureIdentity,
    lifecycle: CoreLifecycleState,
    retryClass: Schema.Literal("notRetryable"),
    safeMessage: Schema.Literal("DiffDash Core rejected a request in its current lifecycle state."),
  },
).annotate({ identifier: "CoreShutdownLifecycleRejectedFailure" })

/** Lifecycle rejection returned by `Core.shutdown`. */
export type CoreShutdownLifecycleRejectedFailure = typeof CoreShutdownLifecycleRejectedFailure.Type

/** Stable plain failure returned when an epoch receives conflicting ownership authorization. */
export const CoreOwnershipAuthorizationMismatchFailure = Schema.TaggedStruct(
  "CoreOwnershipAuthorizationMismatchFailure",
  {
    code: Schema.Literal("CORE_OWNERSHIP_AUTHORIZATION_MISMATCH"),
    method: Schema.Literal("Core.authorizeDatabaseOwnership"),
    ...CoreRpcFailureIdentity,
    lifecycle: CoreLifecycleState,
    retryClass: Schema.Literal("notRetryable"),
    safeMessage: Schema.Literal(
      "DiffDash Core rejected conflicting database ownership authorization.",
    ),
  },
).annotate({ identifier: "CoreOwnershipAuthorizationMismatchFailure" })

/** Stable plain failure returned when an epoch receives conflicting ownership authorization. */
export type CoreOwnershipAuthorizationMismatchFailure =
  typeof CoreOwnershipAuthorizationMismatchFailure.Type

/** Expected failures from database ownership authorization. */
export const CoreAuthorizeDatabaseOwnershipFailure = Schema.Union([
  CoreAuthorizeDatabaseOwnershipIdentityMismatchFailure,
  CoreAuthorizeDatabaseOwnershipLifecycleRejectedFailure,
  CoreOwnershipAuthorizationMismatchFailure,
])

/** Expected failures from database ownership authorization. */
export type CoreAuthorizeDatabaseOwnershipFailure =
  typeof CoreAuthorizeDatabaseOwnershipFailure.Type

/** Expected failures from graceful Core shutdown admission. */
export const CoreShutdownFailure = Schema.Union([
  CoreShutdownIdentityMismatchFailure,
  CoreShutdownLifecycleRejectedFailure,
])

/** Expected failures from graceful Core shutdown admission. */
export type CoreShutdownFailure = typeof CoreShutdownFailure.Type

/** Sanitized defect value for `Core.health`. */
export const CoreHealthDefect = Schema.TaggedStruct("CoreControlDefect", {
  method: Schema.Literal("Core.health"),
  ...CoreControlDefectIdentity,
}).annotate({ identifier: "CoreHealthDefect" })

/** Sanitized defect value for `Core.health`. */
export type CoreHealthDefect = typeof CoreHealthDefect.Type

/** RPC defect codec whose wire form is the sanitized `Core.health` defect. */
export const CoreHealthDefectSchema = CoreHealthDefect.pipe(Schema.decodeTo(CoreRpcDefectValue))

/** Sanitized defect value for `Core.authorizeDatabaseOwnership`. */
export const CoreAuthorizeDatabaseOwnershipDefect = Schema.TaggedStruct("CoreControlDefect", {
  method: Schema.Literal("Core.authorizeDatabaseOwnership"),
  ...CoreControlDefectIdentity,
}).annotate({ identifier: "CoreAuthorizeDatabaseOwnershipDefect" })

/** Sanitized defect value for `Core.authorizeDatabaseOwnership`. */
export type CoreAuthorizeDatabaseOwnershipDefect = typeof CoreAuthorizeDatabaseOwnershipDefect.Type

/** RPC defect codec whose wire form is the sanitized ownership-authorization defect. */
export const CoreAuthorizeDatabaseOwnershipDefectSchema = CoreAuthorizeDatabaseOwnershipDefect.pipe(
  Schema.decodeTo(CoreRpcDefectValue),
)

/** Sanitized defect value for `Core.shutdown`. */
export const CoreShutdownDefect = Schema.TaggedStruct("CoreControlDefect", {
  method: Schema.Literal("Core.shutdown"),
  ...CoreControlDefectIdentity,
}).annotate({ identifier: "CoreShutdownDefect" })

/** Sanitized defect value for `Core.shutdown`. */
export type CoreShutdownDefect = typeof CoreShutdownDefect.Type

/** RPC defect codec whose wire form is the sanitized `Core.shutdown` defect. */
export const CoreShutdownDefectSchema = CoreShutdownDefect.pipe(Schema.decodeTo(CoreRpcDefectValue))

/** Sanitized defect value for `AppState.get`. */
export const AppStateGetDefect = Schema.TaggedStruct("AppStateGetDefect", {
  code: Schema.Literal("APP_STATE_INTERNAL_ERROR"),
  method: Schema.Literal("AppState.get"),
  ...CoreRpcFailureIdentity,
  retryClass: Schema.Literal("notRetryable"),
  safeMessage: Schema.Literal("DiffDash Core encountered an internal application-state error."),
}).annotate({ identifier: "AppStateGetDefect" })

/** Sanitized defect value for `AppState.get`. */
export type AppStateGetDefect = typeof AppStateGetDefect.Type

/** RPC defect codec whose wire form is the sanitized `AppState.get` defect. */
export const AppStateGetDefectSchema = AppStateGetDefect.pipe(Schema.decodeTo(CoreRpcDefectValue))

/** Stable plain failure returned when Core cannot read application state. */
export const AppStateReadFailure = Schema.TaggedStruct("AppStateReadFailure", {
  code: Schema.Literal("APP_STATE_READ_FAILED"),
  method: Schema.Literal("AppState.get"),
  applicationInstanceId: ApplicationInstanceId,
  processEpoch: CoreProcessEpoch,
  requestId: HostRequestId,
  retryClass: CoreRpcRetryClass,
  safeMessage: Schema.Literal("DiffDash could not read application state."),
}).annotate({ identifier: "AppStateReadFailure" })

/** Stable plain failure returned when Core cannot read application state. */
export type AppStateReadFailure = typeof AppStateReadFailure.Type
