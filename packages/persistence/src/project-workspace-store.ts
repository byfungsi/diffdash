import { Context, Effect, Layer, Schema } from "effect"

import {
  ProjectWorkspaceRibbon,
  ProjectWorkspaceState,
  type ProjectWorkspaceStateInput,
} from "@diffdash/domain/project-workspace"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { ReviewThreadTarget } from "@diffdash/domain/review-thread"
import { DatabaseService } from "./database"

const ReviewTargetJson = Schema.parseJson(ReviewThreadTarget)

const ProjectWorkspaceStateRow = Schema.Struct({
  repo_id: ReviewProjectId,
  active_ribbon: ProjectWorkspaceRibbon,
  selected_review_target_json: Schema.NullOr(ReviewTargetJson),
  updated_at: Schema.String,
})

/** A typed failure from project workspace persistence operations. */
export class ProjectWorkspaceStoreError extends Schema.TaggedError<ProjectWorkspaceStoreError>()(
  "ProjectWorkspaceStoreError",
  {
    operation: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** Domain-oriented persistence for the last workspace state of each review project. */
export class ProjectWorkspaceStore extends Context.Tag("@diffdash/ProjectWorkspaceStore")<
  ProjectWorkspaceStore,
  {
    readonly get: (
      projectId: ReviewProjectId,
    ) => Effect.Effect<ProjectWorkspaceState | null, ProjectWorkspaceStoreError>
    readonly save: (
      input: ProjectWorkspaceStateInput,
    ) => Effect.Effect<ProjectWorkspaceState, ProjectWorkspaceStoreError>
  }
>() {
  static readonly layer = Layer.effect(
    ProjectWorkspaceStore,
    Effect.gen(function* () {
      const database = yield* DatabaseService

      const get = Effect.fn("ProjectWorkspaceStore.get")(function (projectId: ReviewProjectId) {
        return database
          .get("SELECT * FROM project_workspace_state WHERE repo_id = ?", [projectId])
          .pipe(
            Effect.mapError((cause) =>
              ProjectWorkspaceStoreError.make({ operation: "get.query", cause }),
            ),
            Effect.flatMap((row) =>
              row === undefined ? Effect.succeed(null) : decodeStateRow("get.decode", row),
            ),
          )
      })

      const save = Effect.fn("ProjectWorkspaceStore.save")(function* (
        input: ProjectWorkspaceStateInput,
      ) {
        const selectedReviewTargetJson =
          input.selectedReviewTarget === null
            ? null
            : yield* Schema.encode(ReviewTargetJson)(input.selectedReviewTarget).pipe(
                Effect.mapError((cause) =>
                  ProjectWorkspaceStoreError.make({ operation: "save.encodeTarget", cause }),
                ),
              )
        const updatedAt = new Date().toISOString()

        yield* database
          .run(
            `INSERT INTO project_workspace_state (
              repo_id, active_ribbon, selected_review_target_json, updated_at
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(repo_id) DO UPDATE SET
              active_ribbon = excluded.active_ribbon,
              selected_review_target_json = excluded.selected_review_target_json,
              updated_at = excluded.updated_at`,
            [input.projectId, input.activeRibbon, selectedReviewTargetJson, updatedAt],
          )
          .pipe(
            Effect.mapError((cause) =>
              ProjectWorkspaceStoreError.make({ operation: "save.query", cause }),
            ),
          )

        const state = yield* get(input.projectId)
        if (state === null) {
          return yield* ProjectWorkspaceStoreError.make({
            operation: "save.get",
            cause: new Error("Project workspace state was not found after save."),
          })
        }
        return state
      })

      return ProjectWorkspaceStore.of({ get, save })
    }),
  )
}

const decodeStateRow = (operation: string, input: unknown) =>
  Schema.decodeUnknown(ProjectWorkspaceStateRow)(input).pipe(
    Effect.mapError((cause) => ProjectWorkspaceStoreError.make({ operation, cause })),
    Effect.map((row) =>
      ProjectWorkspaceState.make({
        projectId: row.repo_id,
        activeRibbon: row.active_ribbon,
        selectedReviewTarget: row.selected_review_target_json,
        updatedAt: row.updated_at,
      }),
    ),
  )
