import { describe, expect, it } from "@effect/vitest"
import { makeHostedRepositoryLocator } from "@diffdash/domain/git-provider"
import {
  ReviewKey,
  ReviewRevision,
  ReviewSnapshotId,
  type ReviewProjectId,
} from "@diffdash/domain/review-identity"
import { hostedRepositoryInput, remoteOnlyRepositoryCheckout } from "@diffdash/domain/repository"
import {
  WalkthroughOperationAcceptanceEvidence,
  WalkthroughOperationCandidatePlanFingerprint,
  WalkthroughOperationId,
  WalkthroughOperationIdempotencyKey,
  WalkthroughOperationIdentity,
  type WalkthroughOperation,
} from "@diffdash/domain/walkthrough-operation"
import * as DatabaseNode from "@diffdash/persistence/database-node"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import { WalkthroughOperationStore } from "@diffdash/persistence/walkthrough-operation-store"
import { Effect, Exit, Layer, Option, Ref } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  acceptWalkthroughOperation,
  persistWalkthroughTerminalExit,
  recoverInterruptedWalkthroughOperations,
  requestWalkthroughCancellation,
  type WalkthroughTerminalOperation,
} from "./walkthrough-operations"

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-walkthrough-hints-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "core.sqlite")))

const makeLayer = (databasePath: string) =>
  Layer.mergeAll(RepositoryStore.layer, WalkthroughOperationStore.layer).pipe(
    Layer.provideMerge(DatabaseNode.layer(databasePath)),
  )

const createRepository = Effect.fn("test.createWalkthroughHintRepository")(function* () {
  const repositories = yield* RepositoryStore
  return yield* repositories.upsertRepository(
    hostedRepositoryInput(
      makeHostedRepositoryLocator("github", "fungsi", "walkthrough-hints"),
      remoteOnlyRepositoryCheckout("https://github.com/fungsi/walkthrough-hints"),
      "preserve",
    ),
  )
})

const identity = (repoId: ReviewProjectId) =>
  WalkthroughOperationIdentity.make({
    repoId,
    reviewKey: ReviewKey.make("github:fungsi/walkthrough-hints#1"),
    baseRevision: ReviewRevision.make("base-hints"),
    headRevision: ReviewRevision.make("head-hints"),
    promptVersion: "walkthrough-v4",
  })

const evidence = (repoId: ReviewProjectId, key: string, regenerate: boolean) =>
  WalkthroughOperationAcceptanceEvidence.make({
    acceptedRequest: {
      applicationInstanceId: "app-walkthrough-hints",
      processEpoch: "epoch-walkthrough-hints",
      requestId: `h:${key.slice(2)}`,
    },
    idempotencyKey: WalkthroughOperationIdempotencyKey.make(key),
    reviewGeneration: {
      kind: "hosted",
      projectId: repoId,
      snapshotId: ReviewSnapshotId.make(`snapshot:v1:${"a".repeat(32)}`),
      reviewKey: ReviewKey.make("github:fungsi/walkthrough-hints#1"),
      baseRevision: ReviewRevision.make("base-hints"),
      headRevision: ReviewRevision.make("head-hints"),
    },
    regenerate,
    configuredRoute: { mode: "auto", quality: "balanced" },
    candidatePlanFingerprint: WalkthroughOperationCandidatePlanFingerprint.make(
      `walkthrough-plan:v1:${"b".repeat(64)}`,
    ),
    attempts: [],
  })

const accept = (
  store: WalkthroughOperationStore["Service"],
  repoId: ReviewProjectId,
  id: string,
  regenerate = false,
) =>
  acceptWalkthroughOperation(
    store,
    {
      operationId: WalkthroughOperationId.make(id),
      identity: identity(repoId),
      regenerate,
      acceptanceEvidence: evidence(repoId, `w:${id}`, regenerate),
    },
    () => Effect.void,
  )

const requireStored = (store: WalkthroughOperationStore["Service"], operationId: string) =>
  store.get(WalkthroughOperationId.make(operationId)).pipe(Effect.map(Option.getOrThrow))

const requireRunning = (operation: WalkthroughOperation) =>
  operation.state === "running"
    ? Effect.succeed(operation)
    : Effect.die("Expected a running walkthrough operation")

describe("Walkthrough terminal hints", () => {
  it.effect("persists a single terminal winner before isolated publication", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.gen(function* () {
        const store = yield* WalkthroughOperationStore
        const repo = yield* createRepository()
        const accepted = yield* accept(store, repo.id, "operation-internal-failure")
        const running = yield* store.markRunning({
          operationId: accepted.operation.id,
          expectedStateVersion: accepted.operation.stateVersion,
        })
        const runningOperation = yield* requireRunning(running.operation)
        const publications = yield* Ref.make(0)
        const publish = (operation: WalkthroughTerminalOperation) =>
          Effect.gen(function* () {
            const persisted = yield* requireStored(store, operation.id)
            expect(persisted).toEqual(operation)
            yield* Ref.update(publications, (count) => count + 1)
            return yield* Effect.fail(new Error("delivery dropped"))
          })

        yield* persistWalkthroughTerminalExit(
          store,
          runningOperation,
          Exit.die("provider defect"),
          publish,
        )
        yield* persistWalkthroughTerminalExit(
          store,
          runningOperation,
          Exit.die("duplicate completion"),
          publish,
        )

        expect(yield* requireStored(store, runningOperation.id)).toMatchObject({
          state: "failed",
          stateVersion: 3,
          failure: { kind: "internal" },
        })
        expect(yield* Ref.get(publications)).toBe(1)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("publishes committed cancellation and supersession states", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.gen(function* () {
        const store = yield* WalkthroughOperationStore
        const repo = yield* createRepository()
        const hinted = yield* Ref.make<readonly WalkthroughOperation[]>([])
        const publish = (operation: WalkthroughTerminalOperation) =>
          Ref.update(hinted, (all) => [...all, operation])

        const cancellable = yield* accept(store, repo.id, "operation-cancelled")
        yield* requestWalkthroughCancellation(
          store,
          {
            operationId: cancellable.operation.id,
            expectedStateVersion: cancellable.operation.stateVersion,
          },
          publish,
        )
        const original = yield* accept(store, repo.id, "operation-original", true)
        yield* acceptWalkthroughOperation(
          store,
          {
            operationId: WalkthroughOperationId.make("operation-replacement"),
            identity: identity(repo.id),
            regenerate: true,
            acceptanceEvidence: evidence(repo.id, "w:operation-replacement", true),
          },
          publish,
        )

        expect(yield* Ref.get(hinted)).toEqual([
          expect.objectContaining({
            id: cancellable.operation.id,
            state: "cancelled",
            stateVersion: 2,
          }),
          expect.objectContaining({
            id: original.operation.id,
            state: "superseded",
            stateVersion: 2,
          }),
        ])
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect(
    "keeps authoritative recovery queries correct under dropped and duplicate delivery",
    () =>
      Effect.gen(function* () {
        const databasePath = yield* makeTempDatabasePath
        yield* Effect.gen(function* () {
          const store = yield* WalkthroughOperationStore
          const repo = yield* createRepository()
          const dropped = yield* accept(store, repo.id, "operation-dropped-recovery")
          const duplicated = yield* accept(store, repo.id, "operation-duplicate-recovery", true)
          const delivered = yield* Ref.make<readonly WalkthroughTerminalOperation[]>([])

          const recovered = yield* recoverInterruptedWalkthroughOperations(store, (operation) =>
            operation.id === dropped.operation.id
              ? Effect.void
              : Ref.update(delivered, (all) => [...all, operation, operation]),
          )

          expect(recovered.map(({ state }) => state)).toEqual(["interrupted"])
          expect(yield* Ref.get(delivered)).toHaveLength(2)
          for (const operation of [dropped.operation, duplicated.operation]) {
            const authoritative = yield* requireStored(store, operation.id)
            expect(
              authoritative.state === "superseded" || authoritative.state === "interrupted",
            ).toBe(true)
            expect(authoritative.stateVersion).toBe(2)
          }
        }).pipe(Effect.provide(makeLayer(databasePath)))
      }),
  )
})
