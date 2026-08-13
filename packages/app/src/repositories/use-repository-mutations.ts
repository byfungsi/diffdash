import type { HostedRepository } from "@diffdash/domain/git-provider"
import type { Repo } from "@diffdash/domain/repository"
import type { ReviewProjectId } from "@diffdash/domain/review-identity"
import type { LinkRepositoryCheckoutRequest } from "@diffdash/protocol/repository-link"
import { runRendererPromise, useRepositories } from "@/platform/renderer-runtime"
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
): RepositoryMutations => {
  const repositories = useRepositories()
  return {
    favorite: (repository) =>
      runRepositoryMutation(
        "favorite",
        () => runRendererPromise(repositories.favoriteHosted(repository)),
        invalidations,
      ),
    rememberRemote: (repository) =>
      runRepositoryMutation(
        "rememberRemote",
        () => runRendererPromise(repositories.rememberHosted(repository)),
        invalidations,
      ),
    setFavorite: (repository, isFavorite) =>
      runRepositoryMutation(
        "setFavorite",
        () => runRendererPromise(repositories.setFavorite(repository.id, isFavorite)),
        invalidations,
      ),
    install: (localPath) =>
      runRepositoryMutation(
        "install",
        () => runRendererPromise(repositories.install(localPath)),
        invalidations,
      ),
    link: (request) =>
      runRepositoryMutation(
        "link",
        () => runRendererPromise(repositories.link(request)),
        invalidations,
      ),
    forget: (projectId) =>
      runRepositoryMutation(
        "forget",
        () => runRendererPromise(repositories.forget(projectId)),
        invalidations,
      ),
  }
}
