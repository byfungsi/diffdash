import { RepositorySearchRequest } from "@diffdash/domain/repository"
import { GitService } from "@diffdash/local-git/local-git"
import { ProjectWorkspaceStore } from "@diffdash/persistence/project-workspace-store"
import { Effect } from "effect"

import { CoreMethod } from "../core-contract"
import { GitProvider } from "../services/git-provider"
import { RepositoryLinker, RepositorySelectionIntent } from "../services/repository-linker"
import type { OperationHandlersFor } from "./operation-handlers"

type RepositoryMethod =
  | typeof CoreMethod.favoriteRemoteRepository
  | typeof CoreMethod.forgetRepository
  | typeof CoreMethod.installRepository
  | typeof CoreMethod.linkRepository
  | typeof CoreMethod.listHostedRepositorySearchScopes
  | typeof CoreMethod.listProviders
  | typeof CoreMethod.listRepositories
  | typeof CoreMethod.openProject
  | typeof CoreMethod.projectWorkspaceGet
  | typeof CoreMethod.projectWorkspaceSave
  | typeof CoreMethod.repairRepositoryIdentities
  | typeof CoreMethod.resolveLocalBranch
  | typeof CoreMethod.resolveLastCommit
  | typeof CoreMethod.searchHostedRepositories
  | typeof CoreMethod.setRepositoryFavorite

/** Acquires repository discovery, linking, and project-workspace handlers. */
export const makeRepositoryOperationHandlers: Effect.Effect<
  OperationHandlersFor<RepositoryMethod>,
  never,
  GitProvider | GitService | ProjectWorkspaceStore | RepositoryLinker
> = Effect.gen(function* () {
  const gitProvider = yield* GitProvider
  const git = yield* GitService
  const projectWorkspace = yield* ProjectWorkspaceStore
  const repositories = yield* RepositoryLinker

  return {
    [CoreMethod.favoriteRemoteRepository]: ({ repository }) =>
      repositories.ensureHosted(repository.locator, "mark"),
    [CoreMethod.forgetRepository]: ({ projectId }) => repositories.forget(projectId),
    [CoreMethod.installRepository]: ({ localPath }) => repositories.install(localPath),
    [CoreMethod.linkRepository]: (request) => repositories.link(request),
    [CoreMethod.listHostedRepositorySearchScopes]: ({ providerId }) =>
      gitProvider.listSearchScopes(providerId),
    [CoreMethod.listProviders]: () => gitProvider.listProviders,
    [CoreMethod.listRepositories]: ({ query }) => repositories.list(query ?? undefined),
    [CoreMethod.openProject]: ({ localPath, selectedRepository }) =>
      repositories.openProject(
        localPath,
        selectedRepository === null
          ? RepositorySelectionIntent.Automatic()
          : RepositorySelectionIntent.Selected({ repository: selectedRepository }),
      ),
    [CoreMethod.projectWorkspaceGet]: ({ projectId }) => projectWorkspace.get(projectId),
    [CoreMethod.projectWorkspaceSave]: ({ input }) => projectWorkspace.save(input),
    [CoreMethod.repairRepositoryIdentities]: () => repositories.repairIdentities(),
    [CoreMethod.resolveLocalBranch]: ({ localPath, branchName }) =>
      git.resolveBranchComparison(localPath, branchName),
    [CoreMethod.resolveLastCommit]: ({ localPath }) => git.resolveLastCommit(localPath),
    [CoreMethod.searchHostedRepositories]: ({ providerId, query, namespaces }) =>
      gitProvider.searchRepositories(
        RepositorySearchRequest.make({ providerId, query, owners: namespaces }),
      ),
    [CoreMethod.setRepositoryFavorite]: ({ id, isFavorite }) =>
      repositories.setFavorite(id, isFavorite),
  } satisfies OperationHandlersFor<RepositoryMethod>
})
