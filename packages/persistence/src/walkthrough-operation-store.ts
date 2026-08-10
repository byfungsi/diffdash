import {
  WalkthroughArtifactReference,
  WalkthroughExpectedFailure,
  WalkthroughInternalFailure,
  WalkthroughOperation,
  WalkthroughOperationAcceptance,
  WalkthroughOperationId,
  WalkthroughOperationIdentity,
  WalkthroughOperationState,
  WalkthroughOperationStateVersion,
  WalkthroughOperationTimestamp,
  WalkthroughOperationTransition,
  type WalkthroughOperation as WalkthroughOperationType,
  type WalkthroughOperationId as WalkthroughOperationIdType,
  type WalkthroughOperationIdentity as WalkthroughOperationIdentityType,
  type WalkthroughOperationStateVersion as WalkthroughOperationStateVersionType,
  type WalkthroughExpectedFailure as WalkthroughExpectedFailureType,
  type WalkthroughArtifactReference as WalkthroughArtifactReferenceType,
} from "@diffdash/domain/walkthrough-operation"
import { ReviewKey, ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import { DiagnosticOperation } from "@diffdash/domain/diagnostic-operation"
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

import { type Database, type DatabaseRow, makeDatabase, toError, type SqlParams } from "./database"

const WalkthroughOperationRow = Schema.Struct({
  id: WalkthroughOperationId,
  repo_id: ReviewProjectId,
  review_key: ReviewKey,
  base_sha: ReviewRevision,
  head_sha: ReviewRevision,
  prompt_version: Schema.NonEmptyString,
  state: WalkthroughOperationState,
  state_version: WalkthroughOperationStateVersion,
  regeneration_of_operation_id: Schema.NullOr(WalkthroughOperationId),
  superseded_by_operation_id: Schema.NullOr(WalkthroughOperationId),
  accepted_at: WalkthroughOperationTimestamp,
  started_at: Schema.NullOr(WalkthroughOperationTimestamp),
  cancellation_requested_at: Schema.NullOr(WalkthroughOperationTimestamp),
  terminal_at: Schema.NullOr(WalkthroughOperationTimestamp),
  updated_at: WalkthroughOperationTimestamp,
  failure_kind: Schema.NullOr(Schema.Literals(["expected", "internal"])),
  failure_category: Schema.NullOr(Schema.String),
  failure_code: Schema.NullOr(Schema.String),
  artifact_repo_id: Schema.NullOr(ReviewProjectId),
  artifact_review_key: Schema.NullOr(ReviewKey),
  artifact_base_sha: Schema.NullOr(ReviewRevision),
  artifact_head_sha: Schema.NullOr(ReviewRevision),
  artifact_prompt_version: Schema.NullOr(Schema.String),
})

/** Input for atomically accepting or finding one exact walkthrough operation. */
export interface AcceptWalkthroughOperationInput {
  readonly operationId: WalkthroughOperationIdType
  readonly identity: WalkthroughOperationIdentityType
  readonly regenerate: boolean
}

/** Optimistic-concurrency guard shared by walkthrough operation transitions. */
export interface WalkthroughOperationVersionGuard {
  readonly operationId: WalkthroughOperationIdType
  readonly expectedStateVersion: WalkthroughOperationStateVersionType
}

/** Successful completion referencing an artifact already saved by WalkthroughStore. */
export interface CompleteWalkthroughOperationInput extends WalkthroughOperationVersionGuard {
  readonly artifact: WalkthroughArtifactReferenceType
}

/** Expected terminal failure reduced to a bounded privacy-safe classification. */
export interface FailExpectedWalkthroughOperationInput extends WalkthroughOperationVersionGuard {
  readonly failure: WalkthroughExpectedFailureType
}

/** Explicit supersession of active work by another operation for the same identity. */
export interface SupersedeWalkthroughOperationInput extends WalkthroughOperationVersionGuard {
  readonly supersededByOperationId: WalkthroughOperationIdType
}

/** A requested durable walkthrough operation does not exist. */
export class WalkthroughOperationNotFoundError extends Schema.TaggedError<WalkthroughOperationNotFoundError>()(
  "WalkthroughOperationNotFoundError",
  { operationId: WalkthroughOperationId, message: Schema.String },
) {}

/** A database or row-decoding failure prevented a walkthrough operation update. */
export class WalkthroughOperationStoreError extends Schema.TaggedError<WalkthroughOperationStoreError>()(
  "WalkthroughOperationStoreError",
  {
    operation: DiagnosticOperation,
    message: Schema.String,
    cause: Schema.ErrorInstance(),
  },
) {}

class WalkthroughOperationInvariantError extends Schema.TaggedError<WalkthroughOperationInvariantError>()(
  "WalkthroughOperationInvariantError",
  { message: Schema.String },
) {}

type WalkthroughOperationTransitionError =
  | WalkthroughOperationNotFoundError
  | WalkthroughOperationStoreError

/** Durable lifecycle store for walkthrough acceptance, execution, and terminal recovery. */
export class WalkthroughOperationStore extends Context.Service<
  WalkthroughOperationStore,
  {
    readonly acceptOrGet: (
      input: AcceptWalkthroughOperationInput,
    ) => Effect.Effect<WalkthroughOperationAcceptance, WalkthroughOperationStoreError>
    readonly get: (
      operationId: WalkthroughOperationIdType,
    ) => Effect.Effect<Option.Option<WalkthroughOperationType>, WalkthroughOperationStoreError>
    readonly markRunning: (
      input: WalkthroughOperationVersionGuard,
    ) => Effect.Effect<WalkthroughOperationTransition, WalkthroughOperationTransitionError>
    readonly completeSuccess: (
      input: CompleteWalkthroughOperationInput,
    ) => Effect.Effect<WalkthroughOperationTransition, WalkthroughOperationTransitionError>
    readonly persistExpectedFailure: (
      input: FailExpectedWalkthroughOperationInput,
    ) => Effect.Effect<WalkthroughOperationTransition, WalkthroughOperationTransitionError>
    readonly persistInternalFailure: (
      input: WalkthroughOperationVersionGuard,
    ) => Effect.Effect<WalkthroughOperationTransition, WalkthroughOperationTransitionError>
    readonly requestCancellation: (
      input: WalkthroughOperationVersionGuard,
    ) => Effect.Effect<WalkthroughOperationTransition, WalkthroughOperationTransitionError>
    readonly supersede: (
      input: SupersedeWalkthroughOperationInput,
    ) => Effect.Effect<WalkthroughOperationTransition, WalkthroughOperationTransitionError>
    readonly recoverActiveAsInterrupted: Effect.Effect<
      readonly WalkthroughOperationType[],
      WalkthroughOperationStoreError
    >
  }
>()("@diffdash/WalkthroughOperationStore") {
  static readonly layer = Layer.effect(
    WalkthroughOperationStore,
    Effect.gen(function* () {
      const database = makeDatabase(yield* SqlClient.SqlClient)

      const get = Effect.fn("WalkthroughOperationStore.get")(function (
        operationId: WalkthroughOperationIdType,
      ) {
        return database
          .get("SELECT * FROM walkthrough_operations WHERE id = ?", [operationId])
          .pipe(
            Effect.mapError((cause) => storeError("get.query", cause)),
            Effect.flatMap((row) =>
              Option.map(row, (value) =>
                decodeOperationRow(value).pipe(
                  Effect.mapError((cause) => storeError("get.decode", cause)),
                ),
              ).pipe(Effect.transposeOption),
            ),
          )
      })

      return WalkthroughOperationStore.of({
        acceptOrGet: Effect.fn("WalkthroughOperationStore.acceptOrGet")(function* (input) {
          const now = timestamp(yield* DateTime.now)
          return yield* database
            .transaction(
              Effect.gen(function* () {
                const identity = yield* Schema.decodeUnknownEffect(WalkthroughOperationIdentity)(
                  input.identity,
                )
                const operationId = yield* Schema.decodeUnknownEffect(WalkthroughOperationId)(
                  input.operationId,
                )
                const existing = yield* findLatestExactOperation(database, identity)
                if (!input.regenerate && Option.isSome(existing)) {
                  return WalkthroughOperationAcceptance.make({
                    created: false,
                    operation: existing.value,
                  })
                }
                if (Option.isSome(existing) && existing.value.id === operationId) {
                  return yield* WalkthroughOperationInvariantError.make({
                    message: "Regeneration requires a new walkthrough operation ID.",
                  })
                }

                if (Option.isSome(existing)) {
                  yield* database.run("PRAGMA defer_foreign_keys = ON")
                  yield* database.run(
                    `UPDATE walkthrough_operations
                     SET state = 'superseded', state_version = state_version + 1,
                         superseded_by_operation_id = ?, cancellation_requested_at = NULL,
                         terminal_at = ?, updated_at = ?,
                         failure_kind = NULL, failure_category = NULL, failure_code = NULL,
                         artifact_repo_id = NULL, artifact_review_key = NULL,
                         artifact_base_sha = NULL, artifact_head_sha = NULL,
                         artifact_prompt_version = NULL
                     WHERE id = ? AND state_version = ? AND state = ?`,
                    [
                      operationId,
                      now,
                      now,
                      existing.value.id,
                      existing.value.stateVersion,
                      existing.value.state,
                    ],
                  )
                }

                yield* database.run(
                  `INSERT INTO walkthrough_operations (
                     id, repo_id, review_key, base_sha, head_sha, prompt_version,
                     state, state_version, regeneration_of_operation_id,
                     accepted_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', 1, ?, ?, ?)`,
                  [
                    operationId,
                    identity.repoId,
                    identity.reviewKey,
                    identity.baseRevision,
                    identity.headRevision,
                    identity.promptVersion,
                    Option.getOrNull(Option.map(existing, ({ id }) => id)),
                    now,
                    now,
                  ],
                )
                return WalkthroughOperationAcceptance.make({
                  created: true,
                  operation: yield* requireOperation(database, operationId),
                })
              }),
            )
            .pipe(Effect.mapError((cause) => storeError("acceptOrGet", cause)))
        }),
        get,
        markRunning: Effect.fn("WalkthroughOperationStore.markRunning")(function* (input) {
          const now = timestamp(yield* DateTime.now)
          return yield* guardedTransition(
            database,
            "markRunning",
            input,
            ["accepted"],
            `UPDATE walkthrough_operations
             SET state = 'running', state_version = state_version + 1,
                 started_at = ?, updated_at = ?
             WHERE id = ? AND state_version = ? AND state = 'accepted'`,
            [now, now, input.operationId, input.expectedStateVersion],
          )
        }),
        completeSuccess: Effect.fn("WalkthroughOperationStore.completeSuccess")(function* (input) {
          const now = timestamp(yield* DateTime.now)
          return yield* database
            .transaction(
              Effect.gen(function* () {
                const before = yield* requireOperation(database, input.operationId)
                const artifact = yield* Schema.decodeUnknownEffect(WalkthroughArtifactReference)(
                  input.artifact,
                )
                if (!sameIdentity(before.identity, artifact)) {
                  return yield* WalkthroughOperationInvariantError.make({
                    message:
                      "Walkthrough artifact reference does not match the operation identity.",
                  })
                }
                if (
                  before.stateVersion !== input.expectedStateVersion ||
                  before.state !== "running"
                ) {
                  return WalkthroughOperationTransition.make({ won: false, operation: before })
                }
                yield* database.run(
                  `UPDATE walkthrough_operations
                   SET state = 'completed', state_version = state_version + 1,
                       terminal_at = ?, updated_at = ?,
                       artifact_repo_id = ?, artifact_review_key = ?, artifact_base_sha = ?,
                       artifact_head_sha = ?, artifact_prompt_version = ?
                   WHERE id = ? AND state_version = ? AND state = 'running'`,
                  [
                    now,
                    now,
                    artifact.repoId,
                    artifact.reviewKey,
                    artifact.baseRevision,
                    artifact.headRevision,
                    artifact.promptVersion,
                    input.operationId,
                    input.expectedStateVersion,
                  ],
                )
                return yield* transitionWon(database, input.operationId)
              }),
            )
            .pipe(mapTransitionError("completeSuccess"))
        }),
        persistExpectedFailure: Effect.fn("WalkthroughOperationStore.persistExpectedFailure")(
          function* (input) {
            const now = timestamp(yield* DateTime.now)
            const failure = yield* Schema.decodeUnknownEffect(WalkthroughExpectedFailure)(
              input.failure,
            )
            return yield* guardedTransition(
              database,
              "persistExpectedFailure",
              input,
              ["accepted", "running"],
              `UPDATE walkthrough_operations
               SET state = 'failed', state_version = state_version + 1,
                   terminal_at = ?, updated_at = ?, failure_kind = 'expected',
                   failure_category = ?, failure_code = ?
               WHERE id = ? AND state_version = ? AND state IN ('accepted', 'running')`,
              [
                now,
                now,
                failure.category,
                failure.code,
                input.operationId,
                input.expectedStateVersion,
              ],
            )
          },
          Effect.mapError((cause) =>
            Schema.is(WalkthroughOperationNotFoundError)(cause) ||
            Schema.is(WalkthroughOperationStoreError)(cause)
              ? cause
              : storeError("persistExpectedFailure.decode", cause),
          ),
        ),
        persistInternalFailure: Effect.fn("WalkthroughOperationStore.persistInternalFailure")(
          function* (input) {
            const now = timestamp(yield* DateTime.now)
            const failure = WalkthroughInternalFailure.make({
              kind: "internal",
              category: "internal",
              code: "unexpected-defect",
            })
            return yield* guardedTransition(
              database,
              "persistInternalFailure",
              input,
              ["accepted", "running"],
              `UPDATE walkthrough_operations
               SET state = 'failed', state_version = state_version + 1,
                   terminal_at = ?, updated_at = ?, failure_kind = ?,
                   failure_category = ?, failure_code = ?
               WHERE id = ? AND state_version = ? AND state IN ('accepted', 'running')`,
              [
                now,
                now,
                failure.kind,
                failure.category,
                failure.code,
                input.operationId,
                input.expectedStateVersion,
              ],
            )
          },
        ),
        requestCancellation: Effect.fn("WalkthroughOperationStore.requestCancellation")(
          function* (input) {
            const now = timestamp(yield* DateTime.now)
            return yield* guardedTransition(
              database,
              "requestCancellation",
              input,
              ["accepted", "running"],
              `UPDATE walkthrough_operations
               SET state = 'cancelled', state_version = state_version + 1,
                   cancellation_requested_at = ?, terminal_at = ?, updated_at = ?
               WHERE id = ? AND state_version = ? AND state IN ('accepted', 'running')`,
              [now, now, now, input.operationId, input.expectedStateVersion],
            )
          },
        ),
        supersede: Effect.fn("WalkthroughOperationStore.supersede")(function* (input) {
          const now = timestamp(yield* DateTime.now)
          return yield* database
            .transaction(
              Effect.gen(function* () {
                const before = yield* requireOperation(database, input.operationId)
                const replacement = yield* requireOperation(database, input.supersededByOperationId)
                if (
                  before.id === replacement.id ||
                  !sameIdentity(before.identity, replacement.identity)
                ) {
                  return yield* WalkthroughOperationInvariantError.make({
                    message: "Superseding operations must have the same exact identity.",
                  })
                }
                if (before.stateVersion !== input.expectedStateVersion || !isActive(before)) {
                  return WalkthroughOperationTransition.make({ won: false, operation: before })
                }
                yield* database.run(
                  `UPDATE walkthrough_operations
                   SET state = 'superseded', state_version = state_version + 1,
                       superseded_by_operation_id = ?, terminal_at = ?, updated_at = ?
                   WHERE id = ? AND state_version = ? AND state IN ('accepted', 'running')`,
                  [replacement.id, now, now, input.operationId, input.expectedStateVersion],
                )
                return yield* transitionWon(database, input.operationId)
              }),
            )
            .pipe(mapTransitionError("supersede"))
        }),
        recoverActiveAsInterrupted: Effect.gen(function* () {
          const now = timestamp(yield* DateTime.now)
          return yield* database
            .transaction(
              Effect.gen(function* () {
                const activeRows = yield* database.all(
                  `SELECT * FROM walkthrough_operations
                   WHERE state IN ('accepted', 'running') ORDER BY accepted_at, id`,
                )
                const active = yield* decodeOperationRows(activeRows)
                yield* database.run(
                  `UPDATE walkthrough_operations
                   SET state = 'interrupted', state_version = state_version + 1,
                       terminal_at = ?, updated_at = ?
                   WHERE state IN ('accepted', 'running')`,
                  [now, now],
                )
                return yield* Effect.forEach(active, (operation) =>
                  requireOperation(database, operation.id),
                )
              }),
            )
            .pipe(Effect.mapError((cause) => storeError("recoverActiveAsInterrupted", cause)))
        }),
      })
    }),
  )
}

const guardedTransition = (
  database: Database,
  operation: string,
  input: WalkthroughOperationVersionGuard,
  allowedStates: readonly WalkthroughOperationType["state"][],
  sql: string,
  params: SqlParams,
) =>
  database
    .transaction(
      Effect.gen(function* () {
        const before = yield* requireOperation(database, input.operationId)
        if (
          before.stateVersion !== input.expectedStateVersion ||
          !allowedStates.includes(before.state)
        ) {
          return WalkthroughOperationTransition.make({ won: false, operation: before })
        }
        yield* database.run(sql, params)
        return yield* transitionWon(database, input.operationId)
      }),
    )
    .pipe(mapTransitionError(operation))

const transitionWon = Effect.fn("WalkthroughOperationStore.transitionWon")(function* (
  database: Database,
  operationId: WalkthroughOperationIdType,
) {
  return WalkthroughOperationTransition.make({
    won: true,
    operation: yield* requireOperation(database, operationId),
  })
})

const findLatestExactOperation = Effect.fn("WalkthroughOperationStore.findLatestExactOperation")(
  function* (database: Database, identity: WalkthroughOperationIdentityType) {
    const row = yield* database.get(
      `SELECT * FROM walkthrough_operations
       WHERE repo_id = ? AND review_key = ? AND base_sha = ?
         AND head_sha = ? AND prompt_version = ?
       ORDER BY accepted_at DESC, rowid DESC LIMIT 1`,
      [
        identity.repoId,
        identity.reviewKey,
        identity.baseRevision,
        identity.headRevision,
        identity.promptVersion,
      ],
    )
    return yield* Option.map(row, decodeOperationRow).pipe(Effect.transposeOption)
  },
)

const requireOperation = Effect.fn("WalkthroughOperationStore.requireOperation")(function* (
  database: Database,
  operationId: WalkthroughOperationIdType,
) {
  const row = yield* database.get("SELECT * FROM walkthrough_operations WHERE id = ?", [
    operationId,
  ])
  const value = yield* Effect.fromOption(row, () =>
    WalkthroughOperationNotFoundError.make({
      operationId,
      message: "Walkthrough operation was not found.",
    }),
  )
  return yield* decodeOperationRow(value)
})

const decodeOperationRow = Effect.fn("WalkthroughOperationStore.decodeOperationRow")(function* (
  input: DatabaseRow,
) {
  const row = yield* Schema.decodeUnknownEffect(WalkthroughOperationRow)(input)
  return yield* makeOperation(row)
})

const decodeOperationRows = (input: readonly DatabaseRow[]) =>
  Schema.decodeUnknownEffect(Schema.Array(WalkthroughOperationRow))(input).pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, makeOperation)),
  )

const makeOperation = (row: typeof WalkthroughOperationRow.Type) => {
  const failure =
    row.failure_kind === null
      ? null
      : {
          kind: row.failure_kind,
          category: row.failure_category,
          code: row.failure_code,
        }
  const artifact =
    row.artifact_repo_id === null
      ? null
      : {
          repoId: row.artifact_repo_id,
          reviewKey: row.artifact_review_key,
          baseRevision: row.artifact_base_sha,
          headRevision: row.artifact_head_sha,
          promptVersion: row.artifact_prompt_version,
        }
  return Schema.decodeUnknownEffect(WalkthroughOperation)({
    id: row.id,
    identity: {
      repoId: row.repo_id,
      reviewKey: row.review_key,
      baseRevision: row.base_sha,
      headRevision: row.head_sha,
      promptVersion: row.prompt_version,
    },
    state: row.state,
    stateVersion: row.state_version,
    regenerationOfOperationId: row.regeneration_of_operation_id,
    supersededByOperationId: row.superseded_by_operation_id,
    acceptedAt: row.accepted_at,
    startedAt: row.started_at,
    cancellationRequestedAt: row.cancellation_requested_at,
    terminalAt: row.terminal_at,
    updatedAt: row.updated_at,
    artifact,
    failure,
  })
}

const sameIdentity = (
  left: WalkthroughOperationIdentityType,
  right: WalkthroughOperationIdentityType,
) =>
  left.repoId === right.repoId &&
  left.reviewKey === right.reviewKey &&
  left.baseRevision === right.baseRevision &&
  left.headRevision === right.headRevision &&
  left.promptVersion === right.promptVersion

const isActive = (operation: WalkthroughOperationType) =>
  operation.state === "accepted" || operation.state === "running"

const timestamp = (dateTime: DateTime.Utc) =>
  WalkthroughOperationTimestamp.make(DateTime.formatIso(dateTime))

const nestedCause = <A>(cause: A) => {
  const nested = Option.getOrNull(
    Schema.decodeUnknownOption(Schema.Struct({ cause: Schema.ErrorInstance() }))(cause),
  )
  return nested?.cause ?? cause
}

const mapTransitionError = (operation: string) =>
  Effect.mapError((cause) => {
    const nested = nestedCause(cause)
    return Schema.is(WalkthroughOperationNotFoundError)(nested)
      ? nested
      : storeError(operation, cause)
  })

const storeError = <A>(operation: string, cause: A) =>
  WalkthroughOperationStoreError.make({
    operation: DiagnosticOperation.make(operation),
    message: `Walkthrough operation persistence failed during ${operation}.`,
    cause: toError(cause),
  })
