import { describe, expect, it } from "@effect/vitest"
import { DiagnosticOperation } from "@diffdash/domain/diagnostic-operation"
import {
  ReviewKey,
  ReviewRevision,
  ReviewSnapshotId,
  type ReviewProjectId,
} from "@diffdash/domain/review-identity"
import { Walkthrough } from "@diffdash/domain/walkthrough"
import {
  WalkthroughArtifactReference,
  WalkthroughExpectedFailure,
  WalkthroughOperationAcceptanceEvidence,
  WalkthroughOperationCandidatePlanFingerprint,
  WalkthroughOperationId,
  WalkthroughOperationIdempotencyKey,
  WalkthroughOperationIdentity,
} from "@diffdash/domain/walkthrough-operation"
import { Effect, Layer, Option, Result, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { makeDatabase } from "./database"
import * as DatabaseNode from "./database-node"
import { RepositoryStore } from "./repository-store"
import {
  WalkthroughOperationStore,
  WalkthroughOperationStoreError,
} from "./walkthrough-operation-store"
import { WalkthroughStore } from "./walkthrough-store"
import { hostedTestRepositoryInput } from "./test-support/repository"

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-walkthrough-operation-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const makeLayer = (databasePath: string) =>
  Layer.mergeAll(
    RepositoryStore.layer,
    WalkthroughStore.layer,
    WalkthroughOperationStore.layer,
  ).pipe(Layer.provideMerge(DatabaseNode.layer(databasePath)))

const createRepository = Effect.fn("test.createWalkthroughOperationRepository")(function* () {
  const repositories = yield* RepositoryStore
  return yield* repositories.upsertRepository(
    hostedTestRepositoryInput({ name: "walkthrough-operations" }),
  )
})

const makeIdentity = (repoId: ReviewProjectId, headRevision = "head-1") =>
  WalkthroughOperationIdentity.make({
    repoId,
    reviewKey: ReviewKey.make("github:fungsi/walkthrough-operations#1"),
    baseRevision: ReviewRevision.make("base-1"),
    headRevision: ReviewRevision.make(headRevision),
    promptVersion: "walkthrough-v4",
  })

const makeAcceptanceEvidence = (
  repoId: ReviewProjectId,
  idempotencyKey: string,
  headRevision = "head-1",
) =>
  WalkthroughOperationAcceptanceEvidence.make({
    acceptedRequest: {
      applicationInstanceId: "app-persistence",
      processEpoch: "epoch-persistence",
      requestId: "h:persistence",
    },
    idempotencyKey: WalkthroughOperationIdempotencyKey.make(idempotencyKey),
    reviewGeneration: {
      kind: "hosted",
      projectId: repoId,
      snapshotId: ReviewSnapshotId.make(`snapshot:v1:${"a".repeat(32)}`),
      reviewKey: ReviewKey.make("github:fungsi/walkthrough-operations#1"),
      baseRevision: ReviewRevision.make("base-1"),
      headRevision: ReviewRevision.make(headRevision),
    },
    regenerate: false,
    configuredRoute: { mode: "auto", quality: "balanced" },
    candidatePlanFingerprint: WalkthroughOperationCandidatePlanFingerprint.make(
      `walkthrough-plan:v1:${"b".repeat(64)}`,
    ),
    attempts: [],
  })

describe("WalkthroughOperationStore", () => {
  it.effect("round-trips durable acceptance evidence and replays by idempotency key", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* WalkthroughOperationStore
        const repo = yield* createRepository()
        const identity = makeIdentity(repo.id)
        const acceptanceEvidence = makeAcceptanceEvidence(repo.id, "w:persistence-replay")
        const first = yield* store.acceptOrGet({
          operationId: WalkthroughOperationId.make("operation-evidence-1"),
          identity,
          regenerate: false,
          acceptanceEvidence,
        })
        const replay = yield* store.acceptOrGet({
          operationId: WalkthroughOperationId.make("operation-evidence-2"),
          identity,
          regenerate: false,
          acceptanceEvidence: WalkthroughOperationAcceptanceEvidence.make({
            ...acceptanceEvidence,
            acceptedRequest: {
              ...acceptanceEvidence.acceptedRequest,
              requestId: "h:persistence-retry",
            },
          }),
        })

        expect(first.created).toBe(true)
        expect(first.operation.acceptanceEvidence).toEqual(acceptanceEvidence)
        expect(replay.created).toBe(false)
        expect(replay.operation.id).toBe(first.operation.id)
        expect(replay.operation.acceptanceEvidence).toEqual(acceptanceEvidence)
        expect(Option.getOrThrow(yield* store.get(first.operation.id))).toEqual(first.operation)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("rejects reuse of an idempotency key for a different immutable snapshot", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* WalkthroughOperationStore
        const repo = yield* createRepository()
        yield* store.acceptOrGet({
          operationId: WalkthroughOperationId.make("operation-collision-1"),
          identity: makeIdentity(repo.id),
          regenerate: false,
          acceptanceEvidence: makeAcceptanceEvidence(repo.id, "w:persistence-collision"),
        })
        const collidingEvidence = makeAcceptanceEvidence(repo.id, "w:persistence-collision")

        const result = yield* Effect.result(
          store.acceptOrGet({
            operationId: WalkthroughOperationId.make("operation-collision-2"),
            identity: makeIdentity(repo.id),
            regenerate: false,
            acceptanceEvidence: WalkthroughOperationAcceptanceEvidence.make({
              ...collidingEvidence,
              reviewGeneration: {
                ...collidingEvidence.reviewGeneration,
                snapshotId: ReviewSnapshotId.make(`snapshot:v1:${"c".repeat(32)}`),
              },
            }),
          }),
        )

        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(WalkthroughOperationStoreError)
          expect(result.failure.message).toBe(
            "Walkthrough operation persistence failed during acceptOrGet.",
          )
        }
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("rejects acceptance evidence with a mismatched regeneration intent", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* WalkthroughOperationStore
        const repo = yield* createRepository()
        const result = yield* Effect.result(
          store.acceptOrGet({
            operationId: WalkthroughOperationId.make("operation-regenerate-mismatch"),
            identity: makeIdentity(repo.id),
            regenerate: true,
            acceptanceEvidence: makeAcceptanceEvidence(repo.id, "w:regenerate-mismatch"),
          }),
        )

        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(WalkthroughOperationStoreError)
        }
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("returns the same operation for repeated non-regenerate acceptance", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* WalkthroughOperationStore
        const repo = yield* createRepository()
        const identity = makeIdentity(repo.id)
        const first = yield* store.acceptOrGet({
          operationId: WalkthroughOperationId.make("operation-idempotent-1"),
          identity,
          regenerate: false,
        })
        const repeated = yield* store.acceptOrGet({
          operationId: WalkthroughOperationId.make("operation-idempotent-2"),
          identity,
          regenerate: false,
        })

        expect(first.created).toBe(true)
        expect(repeated.created).toBe(false)
        expect(repeated.operation.id).toBe(first.operation.id)
        expect(repeated.operation.state).toBe("accepted")
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("allows distinct review generations to remain active concurrently", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* WalkthroughOperationStore
        const repo = yield* createRepository()
        const first = yield* store.acceptOrGet({
          operationId: WalkthroughOperationId.make("operation-generation-1"),
          identity: makeIdentity(repo.id, "head-1"),
          regenerate: false,
        })
        const second = yield* store.acceptOrGet({
          operationId: WalkthroughOperationId.make("operation-generation-2"),
          identity: makeIdentity(repo.id, "head-2"),
          regenerate: false,
        })

        expect(first.operation.state).toBe("accepted")
        expect(second.operation.state).toBe("accepted")
        expect(first.operation.id).not.toBe(second.operation.id)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("regeneration supersedes active exact work and links the replacement", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* WalkthroughOperationStore
        const repo = yield* createRepository()
        const identity = makeIdentity(repo.id)
        const first = yield* store.acceptOrGet({
          operationId: WalkthroughOperationId.make("operation-regenerate-1"),
          identity,
          regenerate: false,
        })
        const replacement = yield* store.acceptOrGet({
          operationId: WalkthroughOperationId.make("operation-regenerate-2"),
          identity,
          regenerate: true,
        })
        const superseded = yield* store.get(first.operation.id)

        expect(replacement.created).toBe(true)
        expect(replacement.operation.regenerationOfOperationId).toBe(first.operation.id)
        expect(Option.getOrThrow(superseded)).toMatchObject({
          state: "superseded",
          stateVersion: 2,
          supersededByOperationId: replacement.operation.id,
        })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("regeneration supersedes the latest terminal exact operation", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* WalkthroughOperationStore
        const repo = yield* createRepository()
        const identity = makeIdentity(repo.id)
        const first = yield* store.acceptOrGet({
          operationId: WalkthroughOperationId.make("operation-terminal-regenerate-1"),
          identity,
          regenerate: false,
        })
        const failed = yield* store.persistInternalFailure({
          operationId: first.operation.id,
          expectedStateVersion: first.operation.stateVersion,
        })
        const replacement = yield* store.acceptOrGet({
          operationId: WalkthroughOperationId.make("operation-terminal-regenerate-2"),
          identity,
          regenerate: true,
        })
        const superseded = Option.getOrThrow(yield* store.get(first.operation.id))

        expect(failed.operation.state).toBe("failed")
        expect(superseded).toMatchObject({
          state: "superseded",
          stateVersion: 3,
          supersededByOperationId: replacement.operation.id,
          failure: null,
        })
        expect(replacement.operation.regenerationOfOperationId).toBe(first.operation.id)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("orders same-timestamp regenerations by insertion rather than operation ID", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* WalkthroughOperationStore
        const repo = yield* createRepository()
        const identity = makeIdentity(repo.id)
        const first = yield* store.acceptOrGet({
          operationId: WalkthroughOperationId.make("operation-z"),
          identity,
          regenerate: false,
        })
        const second = yield* store.acceptOrGet({
          operationId: WalkthroughOperationId.make("operation-m"),
          identity,
          regenerate: true,
        })
        const third = yield* store.acceptOrGet({
          operationId: WalkthroughOperationId.make("operation-a"),
          identity,
          regenerate: true,
        })

        expect(Option.getOrThrow(yield* store.get(first.operation.id))).toMatchObject({
          state: "superseded",
          supersededByOperationId: second.operation.id,
        })
        expect(Option.getOrThrow(yield* store.get(second.operation.id))).toMatchObject({
          state: "superseded",
          supersededByOperationId: third.operation.id,
        })
        expect(third.operation.state).toBe("accepted")
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("persists one deterministic terminal winner for completion and cancellation", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* WalkthroughOperationStore
        const repo = yield* createRepository()
        const identity = makeIdentity(repo.id)
        const accepted = yield* store.acceptOrGet({
          operationId: WalkthroughOperationId.make("operation-terminal-race"),
          identity,
          regenerate: false,
        })
        const running = yield* store.markRunning({
          operationId: accepted.operation.id,
          expectedStateVersion: accepted.operation.stateVersion,
        })
        const cancelled = yield* store.requestCancellation({
          operationId: accepted.operation.id,
          expectedStateVersion: running.operation.stateVersion,
        })
        const completion = yield* store.completeSuccess({
          operationId: accepted.operation.id,
          expectedStateVersion: running.operation.stateVersion,
          artifact: WalkthroughArtifactReference.make(identity),
        })

        expect(cancelled.won).toBe(true)
        expect(cancelled.operation.state).toBe("cancelled")
        expect(completion.won).toBe(false)
        expect(completion.operation).toEqual(cancelled.operation)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("recovers accepted and running rows as interrupted", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* WalkthroughOperationStore
        const repo = yield* createRepository()
        const accepted = yield* store.acceptOrGet({
          operationId: WalkthroughOperationId.make("operation-recover-accepted"),
          identity: makeIdentity(repo.id, "head-accepted"),
          regenerate: false,
        })
        const runningAccepted = yield* store.acceptOrGet({
          operationId: WalkthroughOperationId.make("operation-recover-running"),
          identity: makeIdentity(repo.id, "head-running"),
          regenerate: false,
        })
        yield* store.markRunning({
          operationId: runningAccepted.operation.id,
          expectedStateVersion: runningAccepted.operation.stateVersion,
        })

        const active = yield* store.listActive
        const recovered = yield* store.recoverActiveAsInterrupted

        expect(active.map(({ id }) => id)).toEqual([
          accepted.operation.id,
          runningAccepted.operation.id,
        ])
        expect(active.map(({ state }) => state)).toEqual(["accepted", "running"])
        expect(recovered.map(({ id }) => id)).toEqual([
          accepted.operation.id,
          runningAccepted.operation.id,
        ])
        expect(recovered.map(({ state }) => state)).toEqual(["interrupted", "interrupted"])
        expect(recovered.map(({ stateVersion }) => stateVersion)).toEqual([2, 3])
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("persists only bounded privacy-safe terminal failure fields", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const store = yield* WalkthroughOperationStore
        const repo = yield* createRepository()
        const accepted = yield* store.acceptOrGet({
          operationId: WalkthroughOperationId.make("operation-safe-failure"),
          identity: makeIdentity(repo.id),
          regenerate: false,
        })
        const failure = WalkthroughExpectedFailure.make({
          kind: "expected",
          category: "provider",
          code: "rate-limited",
        })
        const failed = yield* store.persistExpectedFailure({
          operationId: accepted.operation.id,
          expectedStateVersion: accepted.operation.stateVersion,
          failure,
        })
        const row = yield* database.get(
          `SELECT failure_kind, failure_category, failure_code
           FROM walkthrough_operations WHERE id = ?`,
          [accepted.operation.id],
        )
        const columns = Schema.decodeUnknownSync(
          Schema.Array(Schema.Struct({ name: Schema.String })),
        )(yield* database.all("PRAGMA table_info(walkthrough_operations)"))

        expect(failed.operation).toMatchObject({ state: "failed", failure })
        expect(Option.getOrThrow(row)).toEqual({
          failure_kind: "expected",
          failure_category: "provider",
          failure_code: "rate-limited",
        })
        expect(columns.map(({ name }) => name)).not.toEqual(
          expect.arrayContaining([
            "prompt",
            "diff",
            "stdout",
            "stderr",
            "argv",
            "env",
            "stack",
            "defect",
          ]),
        )
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect(
    "completes by exact artifact cache reference without duplicating walkthrough JSON",
    () =>
      Effect.gen(function* () {
        const databasePath = yield* makeTempDatabasePath

        return yield* Effect.gen(function* () {
          const database = makeDatabase(yield* SqlClient.SqlClient)
          const operations = yield* WalkthroughOperationStore
          const walkthroughs = yield* WalkthroughStore
          const repo = yield* createRepository()
          const identity = makeIdentity(repo.id)
          yield* walkthroughs.save({
            repoId: identity.repoId,
            prNumber: 1,
            reviewKey: identity.reviewKey,
            baseSha: identity.baseRevision,
            headSha: identity.headRevision,
            promptVersion: identity.promptVersion,
            walkthrough: Walkthrough.make({
              title: "Durable walkthrough",
              summary: "Stored once in the walkthrough cache.",
              chapters: [],
              support: [],
            }),
          })
          const accepted = yield* operations.acceptOrGet({
            operationId: WalkthroughOperationId.make("operation-artifact-reference"),
            identity,
            regenerate: false,
          })
          const running = yield* operations.markRunning({
            operationId: accepted.operation.id,
            expectedStateVersion: accepted.operation.stateVersion,
          })
          const completed = yield* operations.completeSuccess({
            operationId: accepted.operation.id,
            expectedStateVersion: running.operation.stateVersion,
            artifact: WalkthroughArtifactReference.make(identity),
          })
          const row = yield* database.get(
            `SELECT artifact_repo_id, artifact_review_key, artifact_base_sha,
                  artifact_head_sha, artifact_prompt_version
           FROM walkthrough_operations WHERE id = ?`,
            [accepted.operation.id],
          )
          const columns = Schema.decodeUnknownSync(
            Schema.Array(Schema.Struct({ name: Schema.String })),
          )(yield* database.all("PRAGMA table_info(walkthrough_operations)"))

          expect(completed.won).toBe(true)
          expect(completed.operation).toMatchObject({
            state: "completed",
            stateVersion: 3,
            artifact: identity,
          })
          expect(Option.getOrThrow(row)).toEqual({
            artifact_repo_id: identity.repoId,
            artifact_review_key: identity.reviewKey,
            artifact_base_sha: identity.baseRevision,
            artifact_head_sha: identity.headRevision,
            artifact_prompt_version: identity.promptVersion,
          })
          expect(columns.map(({ name }) => name)).not.toContain("content_json")
        }).pipe(Effect.provide(makeLayer(databasePath)))
      }),
  )

  it.effect("reports malformed operation rows as typed decoding failures", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const store = yield* WalkthroughOperationStore
        const repo = yield* createRepository()
        const accepted = yield* store.acceptOrGet({
          operationId: WalkthroughOperationId.make("operation-malformed-row"),
          identity: makeIdentity(repo.id),
          regenerate: false,
        })
        yield* database.run(
          "UPDATE walkthrough_operations SET accepted_at = 'not-a-timestamp' WHERE id = ?",
          [accepted.operation.id],
        )

        const result = yield* Effect.result(store.get(accepted.operation.id))

        expect(Result.isFailure(result) && result.failure).toEqual(
          expect.objectContaining<Partial<WalkthroughOperationStoreError>>({
            _tag: "WalkthroughOperationStoreError",
            operation: DiagnosticOperation.make("get.decode"),
          }),
        )
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("reports malformed durable acceptance evidence as a typed decoding failure", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const store = yield* WalkthroughOperationStore
        const repo = yield* createRepository()
        const accepted = yield* store.acceptOrGet({
          operationId: WalkthroughOperationId.make("operation-malformed-evidence"),
          identity: makeIdentity(repo.id),
          regenerate: false,
          acceptanceEvidence: makeAcceptanceEvidence(repo.id, "w:malformed-evidence"),
        })
        yield* database.run(
          "UPDATE walkthrough_operation_acceptances SET evidence_json = '{}' WHERE operation_id = ?",
          [accepted.operation.id],
        )

        const result = yield* Effect.result(store.get(accepted.operation.id))

        expect(Result.isFailure(result) && result.failure).toEqual(
          expect.objectContaining<Partial<WalkthroughOperationStoreError>>({
            _tag: "WalkthroughOperationStoreError",
            operation: DiagnosticOperation.make("get.decode"),
          }),
        )
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )
})
