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
  PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
  PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
  PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
  PROJECT_WORKSPACE_WALKTHROUGH_ACTIVITY_ID,
  ProjectWorkspaceActivityId,
  ProjectWorkspaceStateInput,
  type ProjectWorkspaceSurface,
  REVIEW_COMMENTS_ACTIVITY_ID,
} from "@diffdash/domain/project-workspace"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import {
  GitCommitSha,
  RepositoryComparisonRef,
  RepositoryComparisonTarget,
} from "@diffdash/domain/repository-comparison"
import { ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import { HostedReviewTarget } from "@diffdash/domain/review-thread"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Layer, Option, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { makeDatabase } from "./database"
import * as DatabaseNode from "./database-node"
import { ProjectWorkspaceStore, ProjectWorkspaceStoreError } from "./project-workspace-store"

const projectId = ReviewProjectId.make("github:fungsi/diffdash")
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
    selectedReviewTarget,
  })

describe("ProjectWorkspaceStore", () => {
  it.effect("returns null when a project has no workspace state", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        expect(yield* (yield* ProjectWorkspaceStore).get(projectId)).toBeNull()
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("round trips workspace state with no selected review", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        const store = yield* ProjectWorkspaceStore
        const saved = yield* store.save(
          saveInput("review", PROJECT_WORKSPACE_FILES_ACTIVITY_ID, null),
        )

        expect(saved).toEqual(
          expect.objectContaining({
            projectId,
            activeSurface: "review",
            activeActivity: PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
            selectedReviewTarget: null,
          }),
        )
        expect(yield* store.get(projectId)).toEqual(saved)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("round trips the code ribbon without requiring a selected review", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        const store = yield* ProjectWorkspaceStore
        const saved = yield* store.save(saveInput("code", PROJECT_WORKSPACE_CODE_ACTIVITY_ID, null))

        expect(saved.activeSurface).toBe("code")
        expect(saved.activeActivity).toBe(PROJECT_WORKSPACE_CODE_ACTIVITY_ID)
        expect(yield* store.get(projectId)).toEqual(saved)
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
          saveInput("review", PROJECT_WORKSPACE_WALKTHROUGH_ACTIVITY_ID, hostedTarget),
        )

        expect(saved.activeActivity).toBe(PROJECT_WORKSPACE_WALKTHROUGH_ACTIVITY_ID)
        expect(saved.selectedReviewTarget).toEqual(hostedTarget)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("round trips a working-tree target", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        const saved = yield* (yield* ProjectWorkspaceStore).save(
          saveInput("review", PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID, workingTreeTarget),
        )

        expect(saved.selectedReviewTarget).toEqual(workingTreeTarget)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("round trips an exact branch comparison target", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        const saved = yield* (yield* ProjectWorkspaceStore).save(
          saveInput("review", REVIEW_COMMENTS_ACTIVITY_ID, branchTarget),
        )

        expect(saved.selectedReviewTarget).toEqual(branchTarget)
        expect(saved.selectedReviewTarget?.kind).toBe("local")
        if (saved.selectedReviewTarget?.kind === "local") {
          expect(saved.selectedReviewTarget.comparison).toEqual(branchTarget.comparison)
        }
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("round trips an immutable local revision range", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        const saved = yield* (yield* ProjectWorkspaceStore).save(
          saveInput("review", REVIEW_COMMENTS_ACTIVITY_ID, revisionRangeTarget),
        )

        expect(saved.selectedReviewTarget).toEqual(revisionRangeTarget)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("round trips every immutable repository comparison revision", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        const store = yield* ProjectWorkspaceStore
        yield* store.save(
          saveInput("review", PROJECT_WORKSPACE_FILES_ACTIVITY_ID, comparisonTarget),
        )

        const restored = yield* store.get(projectId)
        expect(restored?.selectedReviewTarget).toEqual(comparisonTarget)
        expect(restored?.selectedReviewTarget).toMatchObject({
          baseSha: comparisonTarget.baseSha,
          headSha: comparisonTarget.headSha,
          mergeBaseSha: comparisonTarget.mergeBaseSha,
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
        yield* store.save(saveInput("review", PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID, hostedTarget))
        yield* database.run(
          "UPDATE project_workspace_state SET updated_at = '2000-01-01T00:00:00.000Z' WHERE repo_id = ?",
          [projectId],
        )

        const latest = yield* store.save(
          saveInput("review", REVIEW_COMMENTS_ACTIVITY_ID, branchTarget),
        )
        const count = decodeCountRow(
          Option.getOrThrow(
            yield* database.get("SELECT COUNT(*) AS count FROM project_workspace_state"),
          ),
        )

        expect(count.count).toBe(1)
        expect(latest.activeActivity).toBe(REVIEW_COMMENTS_ACTIVITY_ID)
        expect(latest.selectedReviewTarget).toEqual(branchTarget)
        expect(latest.updatedAt).not.toBe("2000-01-01T00:00:00.000Z")
        expect(yield* store.get(projectId)).toEqual(latest)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("reports invalid persisted target JSON as a typed decode error", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        const store = yield* ProjectWorkspaceStore
        const database = makeDatabase(yield* SqlClient.SqlClient)
        yield* store.save(saveInput("review", PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID, hostedTarget))
        yield* database.run(
          "UPDATE project_workspace_state SET selected_review_target_json = '{' WHERE repo_id = ?",
          [projectId],
        )

        const result = yield* Effect.result(store.get(projectId))
        expect(Result.isFailure(result) && result.failure).toEqual(
          expect.objectContaining<Partial<ProjectWorkspaceStoreError>>({
            _tag: "ProjectWorkspaceStoreError",
            operation: "get.decode",
          }),
        )
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
          store.save(saveInput("review", PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID, null)),
        )
        expect(Result.isFailure(orphan) && orphan.failure).toEqual(
          expect.objectContaining<Partial<ProjectWorkspaceStoreError>>({
            _tag: "ProjectWorkspaceStoreError",
            operation: "save.query",
          }),
        )

        yield* insertProject
        yield* store.save(saveInput("review", PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID, hostedTarget))
        yield* database.run("DELETE FROM repos WHERE id = ?", [projectId])
        expect(yield* store.get(projectId)).toBeNull()
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )
})
