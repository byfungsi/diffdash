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
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"

import { DatabaseService, type DatabaseTransaction } from "./database"

const WalkthroughOperationRow = Schema.Struct({
  id: WalkthroughOperationId,
  repo_id: Schema.NonEmptyString,
  review_key: Schema.NonEmptyString,
  base_sha: Schema.NonEmptyString,
  head_sha: Schema.NonEmptyString,
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
  artifact_repo_id: Schema.NullOr(Schema.String),
  artifact_review_key: Schema.NullOr(Schema.String),
  artifact_base_sha: Schema.NullOr(Schema.String),
  artifact_head_sha: Schema.NullOr(Schema.String),
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
    operation: Schema.NonEmptyString,
    message: Schema.String,
    cause: Schema.Defect(),
  },
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
      const database = yield* DatabaseService

      const get = Effect.fn("WalkthroughOperationStore.get")(function (
        operationId: WalkthroughOperationIdType,
      ) {
        return database
          .get("SELECT * FROM walkthrough_operations WHERE id = ?", [operationId])
          .pipe(
            Effect.mapError((cause) => storeError("get.query", cause)),
            Effect.flatMap((row) =>
              row === undefined
                ? Effect.succeed(Option.none<WalkthroughOperationType>())
                : decodeOperationEffect("get.decode", row).pipe(Effect.map(Option.some)),
            ),
          )
      })

      return WalkthroughOperationStore.of({
        acceptOrGet: Effect.fn("WalkthroughOperationStore.acceptOrGet")(function* (input) {
          const now = timestamp(yield* DateTime.now)
          return yield* database
            .transaction("walkthroughOperations.acceptOrGet", (transaction) => {
              const identity = Schema.decodeUnknownSync(WalkthroughOperationIdentity)(
                input.identity,
              )
              const operationId = Schema.decodeUnknownSync(WalkthroughOperationId)(
                input.operationId,
              )
              const existing = findLatestExactOperation(transaction, identity)
              if (!input.regenerate && existing !== null) {
                return WalkthroughOperationAcceptance.make({ created: false, operation: existing })
              }
              if (existing?.id === operationId) {
                throw new Error("Regeneration requires a new walkthrough operation ID.")
              }

              if (existing !== null) {
                transaction.run("PRAGMA defer_foreign_keys = ON")
                transaction.run(
                  `UPDATE walkthrough_operations
                   SET state = 'superseded', state_version = state_version + 1,
                       superseded_by_operation_id = ?, cancellation_requested_at = NULL,
                       terminal_at = ?, updated_at = ?,
                       failure_kind = NULL, failure_category = NULL, failure_code = NULL,
                       artifact_repo_id = NULL, artifact_review_key = NULL,
                       artifact_base_sha = NULL, artifact_head_sha = NULL,
                       artifact_prompt_version = NULL
                   WHERE id = ? AND state_version = ? AND state = ?`,
                  [operationId, now, now, existing.id, existing.stateVersion, existing.state],
                )
              }

              transaction.run(
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
                  existing?.id ?? null,
                  now,
                  now,
                ],
              )
              return WalkthroughOperationAcceptance.make({
                created: true,
                operation: requireOperation(transaction, operationId),
              })
            })
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
            .transaction("walkthroughOperations.completeSuccess", (transaction) => {
              const before = requireOperation(transaction, input.operationId)
              const artifact = Schema.decodeUnknownSync(WalkthroughArtifactReference)(
                input.artifact,
              )
              if (!sameIdentity(before.identity, artifact)) {
                throw new Error(
                  "Walkthrough artifact reference does not match the operation identity.",
                )
              }
              if (
                before.stateVersion !== input.expectedStateVersion ||
                before.state !== "running"
              ) {
                return WalkthroughOperationTransition.make({ won: false, operation: before })
              }
              transaction.run(
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
              return transitionWon(transaction, input.operationId)
            })
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
            cause instanceof WalkthroughOperationNotFoundError ||
            cause instanceof WalkthroughOperationStoreError
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
            .transaction("walkthroughOperations.supersede", (transaction) => {
              const before = requireOperation(transaction, input.operationId)
              const replacement = requireOperation(transaction, input.supersededByOperationId)
              if (
                before.id === replacement.id ||
                !sameIdentity(before.identity, replacement.identity)
              ) {
                throw new Error("Superseding operations must have the same exact identity.")
              }
              if (before.stateVersion !== input.expectedStateVersion || !isActive(before)) {
                return WalkthroughOperationTransition.make({ won: false, operation: before })
              }
              transaction.run(
                `UPDATE walkthrough_operations
                 SET state = 'superseded', state_version = state_version + 1,
                     superseded_by_operation_id = ?, terminal_at = ?, updated_at = ?
                 WHERE id = ? AND state_version = ? AND state IN ('accepted', 'running')`,
                [replacement.id, now, now, input.operationId, input.expectedStateVersion],
              )
              return transitionWon(transaction, input.operationId)
            })
            .pipe(mapTransitionError("supersede"))
        }),
        recoverActiveAsInterrupted: Effect.gen(function* () {
          const now = timestamp(yield* DateTime.now)
          return yield* database
            .transaction("walkthroughOperations.recoverActiveAsInterrupted", (transaction) => {
              const active = transaction
                .all(
                  `SELECT * FROM walkthrough_operations
                   WHERE state IN ('accepted', 'running') ORDER BY accepted_at, id`,
                )
                .map(decodeOperationRow)
              transaction.run(
                `UPDATE walkthrough_operations
                 SET state = 'interrupted', state_version = state_version + 1,
                     terminal_at = ?, updated_at = ?
                 WHERE state IN ('accepted', 'running')`,
                [now, now],
              )
              return active.map((operation) => requireOperation(transaction, operation.id))
            })
            .pipe(Effect.mapError((cause) => storeError("recoverActiveAsInterrupted", cause)))
        }),
      })
    }),
  )
}

const guardedTransition = (
  database: DatabaseService["Service"],
  operation: string,
  input: WalkthroughOperationVersionGuard,
  allowedStates: readonly WalkthroughOperationType["state"][],
  sql: string,
  params: readonly unknown[],
) =>
  database
    .transaction(`walkthroughOperations.${operation}`, (transaction) => {
      const before = requireOperation(transaction, input.operationId)
      if (
        before.stateVersion !== input.expectedStateVersion ||
        !allowedStates.includes(before.state)
      ) {
        return WalkthroughOperationTransition.make({ won: false, operation: before })
      }
      transaction.run(sql, params)
      return transitionWon(transaction, input.operationId)
    })
    .pipe(mapTransitionError(operation))

const transitionWon = (transaction: DatabaseTransaction, operationId: WalkthroughOperationIdType) =>
  WalkthroughOperationTransition.make({
    won: true,
    operation: requireOperation(transaction, operationId),
  })

const findLatestExactOperation = (
  transaction: DatabaseTransaction,
  identity: WalkthroughOperationIdentityType,
) => {
  const row = transaction.get(
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
  return row === undefined ? null : decodeOperationRow(row)
}

const requireOperation = (
  transaction: DatabaseTransaction,
  operationId: WalkthroughOperationIdType,
) => {
  const row = transaction.get("SELECT * FROM walkthrough_operations WHERE id = ?", [operationId])
  if (row === undefined) {
    throw WalkthroughOperationNotFoundError.make({
      operationId,
      message: "Walkthrough operation was not found.",
    })
  }
  return decodeOperationRow(row)
}

const decodeOperationEffect = (operation: string, input: unknown) =>
  Effect.try({
    try: () => decodeOperationRow(input),
    catch: (cause) => storeError(operation, cause),
  })

const decodeOperationRow = (input: unknown): WalkthroughOperationType => {
  const row = Schema.decodeUnknownSync(WalkthroughOperationRow)(input)
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
  return Schema.decodeUnknownSync(WalkthroughOperation)({
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

const nestedCause = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "cause" in cause ? cause.cause : cause

const mapTransitionError = (operation: string) =>
  Effect.mapError((cause: unknown) => {
    const nested = nestedCause(cause)
    return nested instanceof WalkthroughOperationNotFoundError
      ? nested
      : storeError(operation, cause)
  })

const storeError = (operation: string, cause: unknown) =>
  WalkthroughOperationStoreError.make({
    operation,
    message: `Walkthrough operation persistence failed during ${operation}.`,
    cause,
  })
