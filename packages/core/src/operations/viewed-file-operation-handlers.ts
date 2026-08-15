import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { ViewedFileStore } from "@diffdash/persistence/viewed-file-store"
import { ViewedFileRecord } from "@diffdash/protocol/viewed-files"
import { Effect } from "effect"

import { CoreMethod } from "../core-contract"
import { RepositoryComparisonSource } from "../services/repository-comparison-source"
import { RepositoryLinker } from "../services/repository-linker"
import type { OperationHandlersFor } from "./operation-handlers"
import { comparisonViewedFileScope, localViewedFileScope } from "./viewed-file-scope"

type ViewedFileMethod =
  | typeof CoreMethod.listLocalViewedFiles
  | typeof CoreMethod.listRepositoryComparisonViewedFiles
  | typeof CoreMethod.listViewedFiles
  | typeof CoreMethod.setLocalViewedFile
  | typeof CoreMethod.setRepositoryComparisonViewedFile
  | typeof CoreMethod.setViewedFile

/** Acquires viewed-file handlers while preserving each review identity scheme. */
export const makeViewedFileOperationHandlers: Effect.Effect<
  OperationHandlersFor<ViewedFileMethod>,
  never,
  RepositoryComparisonSource | RepositoryLinker | ViewedFileStore
> = Effect.gen(function* () {
  const comparisons = yield* RepositoryComparisonSource
  const repositories = yield* RepositoryLinker
  const viewedFiles = yield* ViewedFileStore

  return {
    [CoreMethod.listViewedFiles]: (request) =>
      repositories.ensureHosted(request.review.repository, "preserve").pipe(
        Effect.flatMap((repo) =>
          viewedFiles
            .listHosted({
              repoId: repo.id,
              prNumber: request.review.number,
              baseRefName: request.baseRefName,
            })
            .pipe(Effect.map((records) => records.map((record) => ViewedFileRecord.make(record)))),
        ),
      ),
    [CoreMethod.setViewedFile]: (request) =>
      repositories.ensureHosted(request.review.repository, "preserve").pipe(
        Effect.flatMap((repo) =>
          viewedFiles.setHosted({
            repoId: repo.id,
            prNumber: request.review.number,
            baseRefName: request.baseRefName,
            reviewKey: request.reviewKey,
            patchHash: request.patchHash,
            viewed: request.viewed,
          }),
        ),
      ),
    [CoreMethod.listLocalViewedFiles]: (request) =>
      repositories
        .ensureLocal(RepositoryCheckoutPath.make(request.target.rootPath))
        .pipe(
          Effect.flatMap((repo) =>
            viewedFiles
              .listLocal(
                localViewedFileScope(
                  repo.id,
                  request.target,
                  request.sourceBranch === null
                    ? null
                    : RepositoryComparisonRef.make(request.sourceBranch),
                ),
              )
              .pipe(
                Effect.map((records) => records.map((record) => ViewedFileRecord.make(record))),
              ),
          ),
        ),
    [CoreMethod.setLocalViewedFile]: (request) =>
      repositories.ensureLocal(RepositoryCheckoutPath.make(request.target.rootPath)).pipe(
        Effect.flatMap((repo) =>
          viewedFiles.setLocal(
            localViewedFileScope(
              repo.id,
              request.target,
              request.sourceBranch === null
                ? null
                : RepositoryComparisonRef.make(request.sourceBranch),
            ),
            {
              reviewKey: request.reviewKey,
              patchHash: request.patchHash,
              viewed: request.viewed,
            },
          ),
        ),
      ),
    [CoreMethod.listRepositoryComparisonViewedFiles]: ({ target }) =>
      comparisons
        .repository(target)
        .pipe(
          Effect.flatMap((repo) =>
            viewedFiles
              .listLocal(comparisonViewedFileScope(repo.id, target))
              .pipe(
                Effect.map((records) => records.map((record) => ViewedFileRecord.make(record))),
              ),
          ),
        ),
    [CoreMethod.setRepositoryComparisonViewedFile]: (request) =>
      comparisons.repository(request.target).pipe(
        Effect.flatMap((repo) =>
          viewedFiles.setLocal(comparisonViewedFileScope(repo.id, request.target), {
            reviewKey: request.reviewKey,
            patchHash: request.patchHash,
            viewed: request.viewed,
          }),
        ),
      ),
  } satisfies OperationHandlersFor<ViewedFileMethod>
})
