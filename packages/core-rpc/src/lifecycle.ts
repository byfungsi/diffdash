import { Schema } from "effect"

import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  DatabaseOwnershipAuthorizationId,
  HostRequestId,
} from "./identity"

/** Observable lifecycle state of one Core process epoch. */
export const CoreLifecycleState = Schema.Literals([
  "starting",
  "awaitingOwnership",
  "recovering",
  "ready",
  "draining",
  "stopped",
  "failed",
])

/** Observable lifecycle state of one Core process epoch. */
export type CoreLifecycleState = typeof CoreLifecycleState.Type

/** Health value used by Electron to verify the launched Core process identity and state. */
export const CoreHealth = Schema.Struct({
  applicationInstanceId: ApplicationInstanceId,
  processEpoch: CoreProcessEpoch,
  lifecycle: CoreLifecycleState,
}).annotate({ identifier: "CoreHealth" })

/** Health value used by Electron to verify the launched Core process identity and state. */
export type CoreHealth = typeof CoreHealth.Type

/** Request proving Electron persisted the no-fallback barrier for this Core epoch. */
export const AuthorizeDatabaseOwnershipRequest = Schema.Struct({
  applicationInstanceId: ApplicationInstanceId,
  processEpoch: CoreProcessEpoch,
  requestId: HostRequestId,
  authorizationId: DatabaseOwnershipAuthorizationId,
}).annotate({ identifier: "AuthorizeDatabaseOwnershipRequest" })

/** Request proving Electron persisted the no-fallback barrier for this Core epoch. */
export type AuthorizeDatabaseOwnershipRequest = typeof AuthorizeDatabaseOwnershipRequest.Type

/** Acknowledgement that Core may begin database ownership acquisition and recovery. */
export const DatabaseOwnershipAuthorized = Schema.Struct({
  applicationInstanceId: ApplicationInstanceId,
  processEpoch: CoreProcessEpoch,
  authorizationId: DatabaseOwnershipAuthorizationId,
  lifecycle: Schema.Literals(["recovering", "ready"]),
}).annotate({ identifier: "DatabaseOwnershipAuthorized" })

/** Acknowledgement that Core may begin database ownership acquisition and recovery. */
export type DatabaseOwnershipAuthorized = typeof DatabaseOwnershipAuthorized.Type

/** Acknowledgement that Core has stopped admitting work and is draining or already stopped. */
export const CoreShutdownAcknowledged = Schema.Struct({
  applicationInstanceId: ApplicationInstanceId,
  processEpoch: CoreProcessEpoch,
  lifecycle: Schema.Literals(["draining", "stopped"]),
}).annotate({ identifier: "CoreShutdownAcknowledged" })

/** Acknowledgement that Core has stopped admitting work and is draining or already stopped. */
export type CoreShutdownAcknowledged = typeof CoreShutdownAcknowledged.Type
