import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeHostedRepositoryLocator, makeHostedReviewLocator } from "@diffdash/domain/git-provider"
import {
  BranchComparison,
  LocalReviewTarget,
  RevisionRangeComparison,
  workingTreeReviewTarget,
} from "@diffdash/domain/local-review"
import {
  ProjectWorkspaceActivityId,
  ProjectWorkspaceNavigationContributionId,
  ProjectWorkspaceNavigationEnvelope,
  type ProjectWorkspaceNavigationLocation,
  ProjectWorkspaceStateInput,
  type ProjectWorkspaceSurface,
} from "@diffdash/domain/project-workspace"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import {
  GitCommitSha,
  RepositoryComparisonRef,
  RepositoryComparisonTarget,
} from "@diffdash/domain/repository-comparison"
import { ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import { HostedReviewTarget, ReviewThreadTarget } from "@diffdash/domain/review-thread"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Layer, Option, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { makeDatabase } from "./database"
import * as DatabaseNode from "./database-node"
import { ProjectWorkspaceStore, ProjectWorkspaceStoreError } from "./project-workspace-store"

const projectId = ReviewProjectId.make("github:fungsi/diffdash")
const reviewsActivityId = ProjectWorkspaceActivityId.make("diffdash.fixture.reviews")
const filesActivityId = ProjectWorkspaceActivityId.make("diffdash.fixture.files")
const codeActivityId = ProjectWorkspaceActivityId.make("diffdash.fixture.code")
const walkthroughActivityId = ProjectWorkspaceActivityId.make("diffdash.fixture.walkthrough")
const commentsActivityId = ProjectWorkspaceActivityId.make("diffdash.fixture.comments")
const navigationContributionId = ProjectWorkspaceNavigationContributionId.make(
  "diffdash.fixture.navigation",
)
const hostedTarget = HostedReviewTarget.make({
  kind: "hosted",
  review: makeHostedReviewLocator("github", "fungsi", "diffdash", 147),
})
const checkoutPath = RepositoryCheckoutPath.make("/workspace/diffdash")
const workingTreeTarget = workingTreeReviewTarget(checkoutPath)
const branchTarget = LocalReviewTarget.make({
  kind: "local",
  rootPath: checkoutPath,
  comparison: BranchComparison.make({
    branchName: RepositoryComparisonRef.make("main"),
    baseRef: RepositoryComparisonRef.make("refs/heads/main"),
    baseSha: ReviewRevision.make("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
  }),
})
const revisionRangeTarget = LocalReviewTarget.make({
  kind: "local",
  rootPath: checkoutPath,
  comparison: RevisionRangeComparison.make({
    baseRef: RepositoryComparisonRef.make("v1.0.0"),
    headRef: RepositoryComparisonRef.make("HEAD"),
    baseSha: ReviewRevision.make("a".repeat(40)),
    headSha: ReviewRevision.make("b".repeat(40)),
    mergeBaseSha: ReviewRevision.make("a".repeat(40)),
  }),
})
const comparisonTarget = RepositoryComparisonTarget.make({
  kind: "repositoryComparison",
  repository: makeHostedRepositoryLocator("github", "fungsi", "diffdash"),
  baseRef: RepositoryComparisonRef.make("v1.0.0"),
  headRef: RepositoryComparisonRef.make("v1.1.0"),
  baseSha: GitCommitSha.make("a".repeat(40)),
  headSha: GitCommitSha.make("b".repeat(40)),
  mergeBaseSha: GitCommitSha.make("c".repeat(40)),
})

const CountRow = Schema.Struct({ count: Schema.Number })
const decodeCountRow = Schema.decodeUnknownSync(CountRow)

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-project-workspace-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const makeLayer = (databasePath: string) =>
  ProjectWorkspaceStore.layer.pipe(Layer.provideMerge(DatabaseNode.layer(databasePath)))

const insertProject = Effect.gen(function* () {
  const database = makeDatabase(yield* SqlClient.SqlClient)
  yield* database.run(
    `INSERT INTO repos (
      id, provider, owner, name, remote_url, local_path, is_favorite,
      last_opened_at, last_synced_at, created_at, updated_at
    ) VALUES (?, 'github', 'fungsi', 'diffdash', 'https://github.com/fungsi/diffdash',
      '/workspace/diffdash', 0, NULL, NULL, ?, ?)`,
    [projectId, "2026-08-02T00:00:00.000Z", "2026-08-02T00:00:00.000Z"],
  )
})

const saveInput = (
  activeSurface: ProjectWorkspaceSurface,
  activeActivity: ProjectWorkspaceActivityId,
  selectedReviewTarget:
    | typeof hostedTarget
    | typeof workingTreeTarget
    | typeof branchTarget
    | typeof revisionRangeTarget
    | typeof comparisonTarget
    | null,
) =>
  ProjectWorkspaceStateInput.make({
    projectId,
    activeSurface,
    activeActivity,
    navigation: ProjectWorkspaceNavigationEnvelope.make({
      contributionId: navigationContributionId,
      location: {
        opaqueTarget:
          selectedReviewTarget === null
            ? null
            : Schema.encodeSync(ReviewThreadTarget)(selectedReviewTarget),
      },
    }),
  })

const saveNavigationLocationInput = (location: ProjectWorkspaceNavigationLocation) =>
  ProjectWorkspaceStateInput.make({
    projectId,
    activeSurface: "review",
    activeActivity: reviewsActivityId,
    navigation: ProjectWorkspaceNavigationEnvelope.make({
      contributionId: navigationContributionId,
      location,
    }),
  })

describe("ProjectWorkspaceStore", () => {
  it.effect("returns none when a project has no workspace state", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        expect(yield* (yield* ProjectWorkspaceStore).get(projectId)).toEqual(Option.none())
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("round trips workspace state with no selected review", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        const store = yield* ProjectWorkspaceStore
        const saved = yield* store.save(saveInput("review", filesActivityId, null))

        expect(saved).toEqual(
          expect.objectContaining({
            projectId,
            activeSurface: "review",
            activeActivity: filesActivityId,
            navigation: {
              contributionId: navigationContributionId,
              location: { opaqueTarget: null },
            },
          }),
        )
        expect(yield* store.get(projectId)).toEqual(Option.some(saved))
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("round trips the code ribbon without requiring a selected review", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        const store = yield* ProjectWorkspaceStore
        const saved = yield* store.save(saveInput("code", codeActivityId, null))

        expect(saved.activeSurface).toBe("code")
        expect(saved.activeActivity).toBe(codeActivityId)
        expect(yield* store.get(projectId)).toEqual(Option.some(saved))
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("round trips an extension activity without a built-in database constraint", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        const activityId = ProjectWorkspaceActivityId.make("example.extension.comments")
        const saved = yield* (yield* ProjectWorkspaceStore).save(
          saveInput("code", activityId, null),
        )

        expect(saved.activeSurface).toBe("code")
        expect(saved.activeActivity).toBe(activityId)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("round trips a hosted target independently from the active ribbon", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        const saved = yield* (yield* ProjectWorkspaceStore).save(
          saveInput("review", walkthroughActivityId, hostedTarget),
        )

        expect(saved.activeActivity).toBe(walkthroughActivityId)
        expect(saved.navigation.location).toEqual({
          opaqueTarget: Schema.encodeSync(ReviewThreadTarget)(hostedTarget),
        })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("round trips a working-tree target", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        const saved = yield* (yield* ProjectWorkspaceStore).save(
          saveInput("review", reviewsActivityId, workingTreeTarget),
        )

        expect(saved.navigation.location).toEqual({
          opaqueTarget: Schema.encodeSync(ReviewThreadTarget)(workingTreeTarget),
        })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("round trips an exact branch comparison target", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        const saved = yield* (yield* ProjectWorkspaceStore).save(
          saveInput("review", commentsActivityId, branchTarget),
        )

        expect(saved.navigation.location).toEqual({
          opaqueTarget: Schema.encodeSync(ReviewThreadTarget)(branchTarget),
        })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("round trips an immutable local revision range", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        const saved = yield* (yield* ProjectWorkspaceStore).save(
          saveInput("review", commentsActivityId, revisionRangeTarget),
        )

        expect(saved.navigation.location).toEqual({
          opaqueTarget: Schema.encodeSync(ReviewThreadTarget)(revisionRangeTarget),
        })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("round trips every immutable repository comparison revision", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        const store = yield* ProjectWorkspaceStore
        yield* store.save(saveInput("review", filesActivityId, comparisonTarget))

        const restored = Option.getOrThrow(yield* store.get(projectId))
        expect(restored.navigation.location).toEqual({
          opaqueTarget: Schema.encodeSync(ReviewThreadTarget)(comparisonTarget),
        })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("updates one row with the last saved state and timestamp", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        const store = yield* ProjectWorkspaceStore
        const database = makeDatabase(yield* SqlClient.SqlClient)
        yield* store.save(saveInput("review", reviewsActivityId, hostedTarget))
        yield* database.run(
          "UPDATE project_workspace_state SET updated_at = '2000-01-01T00:00:00.000Z' WHERE repo_id = ?",
          [projectId],
        )

        const latest = yield* store.save(saveInput("review", commentsActivityId, branchTarget))
        const count = decodeCountRow(
          Option.getOrThrow(
            yield* database.get("SELECT COUNT(*) AS count FROM project_workspace_state"),
          ),
        )

        expect(count.count).toBe(1)
        expect(latest.activeActivity).toBe(commentsActivityId)
        expect(latest.navigation.location).toEqual({
          opaqueTarget: Schema.encodeSync(ReviewThreadTarget)(branchTarget),
        })
        expect(latest.updatedAt).not.toBe("2000-01-01T00:00:00.000Z")
        expect(yield* store.get(projectId)).toEqual(Option.some(latest))
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("rejects malformed opaque JSON at the SQLite boundary", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        const store = yield* ProjectWorkspaceStore
        const database = makeDatabase(yield* SqlClient.SqlClient)
        yield* store.save(saveInput("review", reviewsActivityId, hostedTarget))
        const result = yield* Effect.result(
          database.run(
            "UPDATE project_workspace_state SET navigation_location_json = '{' WHERE repo_id = ?",
            [projectId],
          ),
        )
        expect(Result.isFailure(result)).toBe(true)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("enforces the serialized navigation UTF-8 byte budget in the store and SQLite", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        const store = yield* ProjectWorkspaceStore
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const serializedEmptyPayloadBytes = JSON.stringify({ payload: "" }).length
        const asciiBoundary = {
          payload: "x".repeat(1_048_576 - serializedEmptyPayloadBytes),
        }
        const multibyteOversized = {
          payload: "🚀".repeat(Math.floor((1_048_576 - serializedEmptyPayloadBytes) / 4) + 1),
        }

        const saved = yield* store.save(saveNavigationLocationInput(asciiBoundary))
        expect(saved.navigation.location).toEqual(asciiBoundary)

        const sqliteResult = yield* Effect.result(
          database.run(
            "UPDATE project_workspace_state SET navigation_location_json = ? WHERE repo_id = ?",
            [JSON.stringify(multibyteOversized), projectId],
          ),
        )
        expect(Result.isFailure(sqliteResult)).toBe(true)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("rejects orphan state and cascades state when its repository is deleted", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const store = yield* ProjectWorkspaceStore
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const orphan = yield* Effect.result(
          store.save(saveInput("review", reviewsActivityId, null)),
        )
        expect(Result.isFailure(orphan) && orphan.failure).toEqual(
          expect.objectContaining<Partial<ProjectWorkspaceStoreError>>({
            _tag: "ProjectWorkspaceStoreError",
            operation: "save.query",
          }),
        )

        yield* insertProject
        yield* store.save(saveInput("review", reviewsActivityId, hostedTarget))
        yield* database.run("DELETE FROM repos WHERE id = ?", [projectId])
        expect(yield* store.get(projectId)).toEqual(Option.none())
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )
})
