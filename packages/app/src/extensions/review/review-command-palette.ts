import type { HostedReviewSummary } from "@diffdash/domain/git-provider"
import type { Repo } from "@diffdash/domain/repository"
import { Option } from "effect"

import type { CommandPaletteItem } from "@/shell/command-palette"
import { PROJECT_WORKSPACE_FILES_ACTIVITY_ID } from "./review-identities"
import type { ProjectSession, ProjectSessionProjection } from "./review-project-session"

/** Projects Review-owned destinations into the shared command palette contract. */
export const reviewCommandPaletteItems = ({
  apply,
  projectSession,
  pullRequests,
  repo,
}: {
  readonly apply: (projection: ProjectSessionProjection) => void
  readonly projectSession: ProjectSession
  readonly pullRequests: readonly HostedReviewSummary[]
  readonly repo: Option.Option<Repo>
}): readonly CommandPaletteItem[] =>
  pullRequests.map((pullRequest) => ({
    id: `hosted-review:${pullRequest.locator.repository.namespace}/${pullRequest.locator.repository.name}#${pullRequest.locator.number}`,
    keywords: `${pullRequest.locator.repository.namespace} ${pullRequest.locator.repository.name} ${pullRequest.title} hosted review`,
    subtitle: `Open review · ${pullRequest.locator.repository.namespace}/${pullRequest.locator.repository.name}`,
    title: `#${pullRequest.locator.number} ${pullRequest.title}`,
    onSelect: () => {
      Option.match(repo, {
        onNone: () => undefined,
        onSome: (selectedRepo) =>
          apply(
            projectSession.project(
              selectedRepo,
              "review",
              PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
              Option.some({ kind: "hosted", review: pullRequest.locator }),
              Option.none(),
            ),
          ),
      })
    },
  }))
