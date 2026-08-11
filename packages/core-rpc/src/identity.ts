import { Schema } from "effect"

const BoundedIdentity = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(100)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)),
)

/** Identity shared by Electron and every Core process it launches. */
export const ApplicationInstanceId = BoundedIdentity.pipe(Schema.brand("ApplicationInstanceId"))

/** Identity shared by Electron and every Core process it launches. */
export type ApplicationInstanceId = typeof ApplicationInstanceId.Type

/** Identity of one Core process lifetime within an application instance. */
export const CoreProcessEpoch = BoundedIdentity.pipe(Schema.brand("CoreProcessEpoch"))

/** Identity of one Core process lifetime within an application instance. */
export type CoreProcessEpoch = typeof CoreProcessEpoch.Type

/** Application-level correlation identity allocated by Electron for a Core request. */
export const HostRequestId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(3)),
  Schema.check(Schema.isMaxLength(100)),
  Schema.check(Schema.isPattern(/^h:[A-Za-z0-9][A-Za-z0-9._-]*$/u)),
  Schema.brand("HostRequestId"),
)

/** Application-level correlation identity allocated by Electron for a Core request. */
export type HostRequestId = typeof HostRequestId.Type

/** Application-level correlation identity allocated by Core for a host-capability request. */
export const CoreRequestId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(3)),
  Schema.check(Schema.isMaxLength(100)),
  Schema.check(Schema.isPattern(/^c:[A-Za-z0-9][A-Za-z0-9._-]*$/u)),
  Schema.brand("CoreRequestId"),
)

/** Application-level correlation identity allocated by Core for a host-capability request. */
export type CoreRequestId = typeof CoreRequestId.Type

/** Identity metadata carried by every Electron-originated Core RPC payload. */
export const HostRequestContext = Schema.Struct({
  applicationInstanceId: ApplicationInstanceId,
  processEpoch: CoreProcessEpoch,
  requestId: HostRequestId,
}).annotate({ identifier: "HostRequestContext" })

/** Identity metadata carried by every Electron-originated Core RPC payload. */
export type HostRequestContext = typeof HostRequestContext.Type

/** Identity metadata carried by every Core-originated host-capability RPC payload. */
export const CoreRequestContext = Schema.Struct({
  applicationInstanceId: ApplicationInstanceId,
  processEpoch: CoreProcessEpoch,
  requestId: CoreRequestId,
}).annotate({ identifier: "CoreRequestContext" })

/** Identity metadata carried by every Core-originated host-capability RPC payload. */
export type CoreRequestContext = typeof CoreRequestContext.Type
