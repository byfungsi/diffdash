import type { HostedRepository } from "@diffdash/domain/git-provider"
import type { Repo } from "@diffdash/domain/repository"
import type { ReviewProjectId } from "@diffdash/domain/review-identity"
import type { LinkRepositoryCheckoutRequest } from "@diffdash/protocol/repository-link"
import { type RepositoryQueryInvalidations, runRepositoryMutation } from "./repository-mutations"

/** Repository mutation methods with cache invalidation hidden from shell navigation. */
type RepositoryMutations = {
  readonly favorite: (repository: HostedRepository) => Promise<Repo>
  readonly rememberRemote: (repository: HostedRepository) => Promise<Repo>
  readonly setFavorite: (repository: Repo, isFavorite: boolean) => Promise<Repo>
  readonly install: (localPath: string) => Promise<Repo>
  readonly link: (request: LinkRepositoryCheckoutRequest) => Promise<Repo>
  readonly forget: (projectId: ReviewProjectId) => Promise<Repo>
}

/** Creates repository mutations whose exact dependent-query lists are domain-owned. */
export const useRepositoryMutations = (
  invalidations: RepositoryQueryInvalidations,
): RepositoryMutations => ({
  favorite: (repository) =>
    runRepositoryMutation(
      "favorite",
      () => window.diffDash.repositories.favoriteRemote(repository),
      invalidations,
    ),
  rememberRemote: (repository) =>
    runRepositoryMutation(
      "rememberRemote",
      async () => {
        const saved = await window.diffDash.repositories.favoriteRemote(repository)
        return window.diffDash.repositories.setFavorite(saved.id, false)
      },
      invalidations,
    ),
  setFavorite: (repository, isFavorite) =>
    runRepositoryMutation(
      "setFavorite",
      () => window.diffDash.repositories.setFavorite(repository.id, isFavorite),
      invalidations,
    ),
  install: (localPath) =>
    runRepositoryMutation(
      "install",
      () => window.diffDash.repositories.install(localPath),
      invalidations,
    ),
  link: (request) =>
    runRepositoryMutation("link", () => window.diffDash.repositories.link(request), invalidations),
  forget: (projectId) =>
    runRepositoryMutation(
      "forget",
      () => window.diffDash.repositories.forget(projectId),
      invalidations,
    ),
})
