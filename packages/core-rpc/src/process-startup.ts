import { Schema } from "effect"

import { ApplicationInstanceId, CoreProcessEpoch } from "./identity"

/** Private environment key carrying one bounded Core process bootstrap envelope. */
export const CORE_PROCESS_STARTUP_ENV = "DIFFDASH_CORE_PROCESS_STARTUP"

/** Maximum encoded startup envelope accepted by the standalone Core process. */
export const CORE_PROCESS_STARTUP_MAX_BYTES = 16 * 1_024

const TransportToken = Schema.String.pipe(
  Schema.check(Schema.isMinLength(32)),
  Schema.check(Schema.isMaxLength(256)),
)

/** Exact host-authored configuration consumed once by a standalone Core process. */
export const CoreProcessStartupConfiguration = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  applicationInstanceId: ApplicationInstanceId,
  processEpoch: CoreProcessEpoch,
  socketPath: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  databasePath: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(4_096)),
  ),
  statePath: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(4_096)),
  ),
  coreConfiguration: Schema.Json,
  token: Schema.RedactedFromValue(TransportToken),
}).annotate({ identifier: "CoreProcessStartupConfiguration" })

/** Exact host-authored configuration consumed once by a standalone Core process. */
export type CoreProcessStartupConfiguration = typeof CoreProcessStartupConfiguration.Type

const EncodedCoreProcessStartupConfiguration = Schema.fromJsonString(
  CoreProcessStartupConfiguration,
)

/** Encodes the private startup envelope without widening its branded identities. */
export const encodeCoreProcessStartupConfiguration = Schema.encodeEffect(
  EncodedCoreProcessStartupConfiguration,
)

/** Decodes the private startup envelope and immediately redacts its transport credential. */
export const decodeCoreProcessStartupConfiguration = Schema.decodeUnknownEffect(
  EncodedCoreProcessStartupConfiguration,
)
