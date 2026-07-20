import type { HostedRepository } from "@diffdash/domain/git-provider"
import type { Repo } from "@diffdash/domain/repository"
import type { LinkRepositoryCheckoutRequest } from "@diffdash/protocol/repository-link"
import { type RepositoryQueryInvalidations, runRepositoryMutation } from "./repository-mutations"

/** Repository mutation methods with cache invalidation hidden from shell navigation. */
type RepositoryMutations = {
  readonly favorite: (repository: HostedRepository) => Promise<Repo>
  readonly install: (localPath: string) => Promise<Repo>
  readonly link: (request: LinkRepositoryCheckoutRequest) => Promise<Repo>
  readonly remove: (repository: Repo) => Promise<Repo>
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
  install: (localPath) =>
    runRepositoryMutation(
      "install",
      () => window.diffDash.repositories.install(localPath),
      invalidations,
    ),
  link: (request) =>
    runRepositoryMutation("link", () => window.diffDash.repositories.link(request), invalidations),
  remove: (repository) =>
    runRepositoryMutation(
      "remove",
      () => window.diffDash.repositories.setFavorite(repository.id, false),
      invalidations,
    ),
})
