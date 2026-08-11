import { Schema } from "effect"

import { ApplicationInstanceId, CoreProcessEpoch, HostRequestId } from "./identity"

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
