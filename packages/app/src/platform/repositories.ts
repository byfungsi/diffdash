import { Context, Effect, Layer, Option } from "effect"

import type {
  GitProviderDescriptor,
  HostedRepository,
  HostedRepositoryLocator,
} from "@diffdash/domain/git-provider"
import type { ProjectOpenResult } from "@diffdash/domain/project-workspace"
import type {
  Repo,
  RepositoryIdentityRepairSummary,
  RepositorySearchScope,
} from "@diffdash/domain/repository"
import type { ReviewProjectId } from "@diffdash/domain/review-identity"
import type {
  HostedProviderRequest,
  HostedRepositorySearchRequest,
} from "@diffdash/protocol/hosted-git"
import type { LinkRepositoryCheckoutRequest } from "@diffdash/protocol/repository-link"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { PreloadClient } from "./preload-client"
import { invokePreload, type RendererApiError } from "./renderer-api-error"

/** Renderer repository catalog, discovery, and local-checkout capabilities. */
export class Repositories extends Context.Tag("@diffdash/app/Repositories")<
  Repositories,
  {
    readonly list: (
      query: Option.Option<string>,
    ) => Effect.Effect<readonly Repo[], RendererApiError>
    readonly listProviders: () => Effect.Effect<readonly GitProviderDescriptor[], RendererApiError>
    readonly searchHosted: (
      request: HostedRepositorySearchRequest,
    ) => Effect.Effect<readonly HostedRepository[], RendererApiError>
    readonly listSearchScopes: (
      request: HostedProviderRequest,
    ) => Effect.Effect<readonly RepositorySearchScope[], RendererApiError>
    readonly favoriteHosted: (repository: HostedRepository) => Effect.Effect<Repo, RendererApiError>
    readonly rememberHosted: (repository: HostedRepository) => Effect.Effect<Repo, RendererApiError>
    readonly setFavorite: (id: string, isFavorite: boolean) => Effect.Effect<Repo, RendererApiError>
    readonly install: (localPath: string) => Effect.Effect<Repo, RendererApiError>
    readonly link: (request: LinkRepositoryCheckoutRequest) => Effect.Effect<Repo, RendererApiError>
    readonly forget: (projectId: ReviewProjectId) => Effect.Effect<Repo, RendererApiError>
    readonly openProject: (
      localPath: string,
      selectedRepository: Option.Option<HostedRepositoryLocator>,
    ) => Effect.Effect<ProjectOpenResult, RendererApiError>
    readonly selectLocalFolder: () => Effect.Effect<Option.Option<string>, RendererApiError>
    readonly repairIdentities: () => Effect.Effect<
      RepositoryIdentityRepairSummary,
      RendererApiError
    >
  }
>() {}

/** Desktop implementation of renderer repository capabilities. */
export const repositoriesLayer = Layer.effect(
  Repositories,
  Effect.gen(function* () {
    const api = yield* PreloadClient
    const favoriteHosted = (repository: HostedRepository) =>
      invokePreload(InvokeChannel.favoriteRemoteRepository, () =>
        api.repositories.favoriteRemote(repository),
      )

    return Repositories.of({
      list: (query) =>
        invokePreload(InvokeChannel.listRepositories, () =>
          api.repositories.list(Option.getOrUndefined(query)),
        ),
      listProviders: () => invokePreload(InvokeChannel.listProviders, () => api.providers.list()),
      searchHosted: (request) =>
        invokePreload(InvokeChannel.searchHostedRepositories, () =>
          api.hostedRepositories.searchRepositories(request),
        ),
      listSearchScopes: (request) =>
        invokePreload(InvokeChannel.listHostedRepositorySearchScopes, () =>
          api.hostedRepositories.listSearchScopes(request),
        ),
      favoriteHosted,
      rememberHosted: (repository) =>
        favoriteHosted(repository).pipe(
          Effect.flatMap((saved) =>
            invokePreload(InvokeChannel.setRepositoryFavorite, () =>
              api.repositories.setFavorite(saved.id, false),
            ),
          ),
        ),
      setFavorite: (id, isFavorite) =>
        invokePreload(InvokeChannel.setRepositoryFavorite, () =>
          api.repositories.setFavorite(id, isFavorite),
        ),
      install: (localPath) =>
        invokePreload(InvokeChannel.installRepository, () => api.repositories.install(localPath)),
      link: (request) =>
        invokePreload(InvokeChannel.linkRepository, () => api.repositories.link(request)),
      forget: (projectId) =>
        invokePreload(InvokeChannel.forgetRepository, () => api.repositories.forget(projectId)),
      openProject: (localPath, selectedRepository) =>
        invokePreload(InvokeChannel.openProject, () =>
          api.repositories.openProject(localPath, Option.getOrUndefined(selectedRepository)),
        ),
      selectLocalFolder: () =>
        invokePreload(InvokeChannel.selectLocalFolder, () =>
          api.repositories.selectLocalFolder(),
        ).pipe(Effect.map(Option.fromNullable)),
      repairIdentities: () =>
        invokePreload(InvokeChannel.repairRepositoryIdentities, () =>
          api.repositories.repairIdentities(),
        ),
    })
  }),
)
