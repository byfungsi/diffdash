import { Context, Effect, Layer, Option } from "effect"

import type { LocalReviewTarget } from "@diffdash/domain/local-review"
import type { ResolvedRepositoryComparison } from "@diffdash/protocol/review-snapshot"
import type { OpenRepositoryComparisonCommand } from "@diffdash/protocol/cli-navigation"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { PreloadClient } from "./preload-client"
import { invokePreload, type RendererApiError } from "./renderer-api-error"

/** Renderer operations that resolve local and repository-comparison workspace targets. */
export class ProjectWorkspace extends Context.Tag("@diffdash/app/ProjectWorkspace")<
  ProjectWorkspace,
  {
    readonly resolveLocalReview: (
      localPath: string,
      branchName: Option.Option<string>,
    ) => Effect.Effect<LocalReviewTarget, RendererApiError>
    readonly resolveRepositoryComparison: (
      command: OpenRepositoryComparisonCommand,
    ) => Effect.Effect<ResolvedRepositoryComparison, RendererApiError>
  }
>() {}

/** Desktop implementation of project target resolution. */
export const projectWorkspaceLayer = Layer.effect(
  ProjectWorkspace,
  Effect.gen(function* () {
    const api = yield* PreloadClient
    return ProjectWorkspace.of({
      resolveLocalReview: (localPath, branchName) =>
        invokePreload(InvokeChannel.resolveLocalBranch, () =>
          api.localReviews.resolveBranch(localPath, Option.getOrNull(branchName)),
        ),
      resolveRepositoryComparison: (command) =>
        invokePreload(InvokeChannel.resolveRepositoryComparison, () =>
          api.repositoryComparisons.resolve(command),
        ),
    })
  }),
)
