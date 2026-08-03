import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeHostedReviewLocator } from "@diffdash/domain/git-provider"
import {
  BranchComparison,
  LocalReviewTarget,
  workingTreeReviewTarget,
} from "@diffdash/domain/local-review"
import { ProjectWorkspaceStateInput } from "@diffdash/domain/project-workspace"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { HostedReviewTarget } from "@diffdash/domain/review-thread"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Either, Layer, Schema } from "effect"
import { DatabaseService } from "./database"
import { ProjectWorkspaceStore, ProjectWorkspaceStoreError } from "./project-workspace-store"

const projectId = ReviewProjectId.make("github:fungsi/diffdash")
const hostedTarget = HostedReviewTarget.make({
  kind: "hosted",
  review: makeHostedReviewLocator("github", "fungsi", "diffdash", 147),
})
const workingTreeTarget = workingTreeReviewTarget("/workspace/diffdash")
const branchTarget = LocalReviewTarget.make({
  kind: "local",
  rootPath: "/workspace/diffdash",
  comparison: BranchComparison.make({
    branchName: "main",
    baseRef: "refs/heads/main",
    baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  }),
})

const CountRow = Schema.Struct({ count: Schema.Number })
const decodeCountRow = Schema.decodeUnknownSync(CountRow)

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-project-workspace-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const makeLayer = (databasePath: string) =>
  ProjectWorkspaceStore.layer.pipe(Layer.provideMerge(DatabaseService.layer(databasePath)))

const insertProject = Effect.gen(function* () {
  const database = yield* DatabaseService
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
  activeRibbon: "reviews" | "files" | "walkthrough" | "threads",
  selectedReviewTarget: typeof hostedTarget | typeof workingTreeTarget | typeof branchTarget | null,
) =>
  ProjectWorkspaceStateInput.make({
    projectId,
    activeRibbon,
    selectedReviewTarget,
  })

describe("ProjectWorkspaceStore", () => {
  it.scoped("returns null when a project has no workspace state", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        expect(yield* (yield* ProjectWorkspaceStore).get(projectId)).toBeNull()
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("round trips workspace state with no selected review", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        const store = yield* ProjectWorkspaceStore
        const saved = yield* store.save(saveInput("files", null))

        expect(saved).toEqual(
          expect.objectContaining({
            projectId,
            activeRibbon: "files",
            selectedReviewTarget: null,
          }),
        )
        expect(yield* store.get(projectId)).toEqual(saved)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("round trips a hosted target independently from the active ribbon", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        const saved = yield* (yield* ProjectWorkspaceStore).save(
          saveInput("walkthrough", hostedTarget),
        )

        expect(saved.activeRibbon).toBe("walkthrough")
        expect(saved.selectedReviewTarget).toEqual(hostedTarget)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("round trips a working-tree target", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        const saved = yield* (yield* ProjectWorkspaceStore).save(
          saveInput("reviews", workingTreeTarget),
        )

        expect(saved.selectedReviewTarget).toEqual(workingTreeTarget)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("round trips an exact branch comparison target", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        const saved = yield* (yield* ProjectWorkspaceStore).save(saveInput("threads", branchTarget))

        expect(saved.selectedReviewTarget).toEqual(branchTarget)
        expect(saved.selectedReviewTarget?.kind).toBe("local")
        if (saved.selectedReviewTarget?.kind === "local") {
          expect(saved.selectedReviewTarget.comparison).toEqual(branchTarget.comparison)
        }
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("updates one row with the last saved state and timestamp", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        const store = yield* ProjectWorkspaceStore
        const database = yield* DatabaseService
        yield* store.save(saveInput("reviews", hostedTarget))
        yield* database.run(
          "UPDATE project_workspace_state SET updated_at = '2000-01-01T00:00:00.000Z' WHERE repo_id = ?",
          [projectId],
        )

        const latest = yield* store.save(saveInput("threads", branchTarget))
        const count = decodeCountRow(
          yield* database.get("SELECT COUNT(*) AS count FROM project_workspace_state"),
        )

        expect(count.count).toBe(1)
        expect(latest.activeRibbon).toBe("threads")
        expect(latest.selectedReviewTarget).toEqual(branchTarget)
        expect(latest.updatedAt).not.toBe("2000-01-01T00:00:00.000Z")
        expect(yield* store.get(projectId)).toEqual(latest)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("reports invalid persisted target JSON as a typed decode error", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        yield* insertProject
        const store = yield* ProjectWorkspaceStore
        const database = yield* DatabaseService
        yield* store.save(saveInput("reviews", hostedTarget))
        yield* database.run(
          "UPDATE project_workspace_state SET selected_review_target_json = '{' WHERE repo_id = ?",
          [projectId],
        )

        const result = yield* Effect.either(store.get(projectId))
        expect(Either.isLeft(result) && result.left).toEqual(
          expect.objectContaining<Partial<ProjectWorkspaceStoreError>>({
            _tag: "ProjectWorkspaceStoreError",
            operation: "get.decode",
          }),
        )
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("rejects orphan state and cascades state when its repository is deleted", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const store = yield* ProjectWorkspaceStore
        const database = yield* DatabaseService
        const orphan = yield* Effect.either(store.save(saveInput("reviews", null)))
        expect(Either.isLeft(orphan) && orphan.left).toEqual(
          expect.objectContaining<Partial<ProjectWorkspaceStoreError>>({
            _tag: "ProjectWorkspaceStoreError",
            operation: "save.query",
          }),
        )

        yield* insertProject
        yield* store.save(saveInput("reviews", hostedTarget))
        yield* database.run("DELETE FROM repos WHERE id = ?", [projectId])
        expect(yield* store.get(projectId)).toBeNull()
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )
})
