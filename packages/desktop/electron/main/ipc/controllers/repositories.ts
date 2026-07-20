import type { HostedRepository } from "@diffdash/domain/git-provider"
import type { Repo, RepositorySearchScope } from "@diffdash/domain/repository"
import { RepositorySearchRequest } from "@diffdash/domain/repository"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { dialog } from "electron"
import { GitProvider } from "../../../../src/main/services/git-provider"
import { RepositoryLinker } from "../../../../src/main/services/repository-linker"
import type { ApplicationRuntime } from "../../application-runtime"
import { IpcControllerRegistry } from "./controller-registry"

/** Defines repositories IPC handler implementations. */
export const defineRepositoryHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  const run = runtime.runPromise

  handlers.define(
    InvokeChannel.listRepositories,
    async (_event, { query }): Promise<readonly Repo[]> => {
      const repositories = await run(RepositoryLinker)
      return run(repositories.list(query ?? undefined))
    },
  )

  handlers.define(
    InvokeChannel.setRepositoryFavorite,
    async (_event, { id, isFavorite }): Promise<Repo> => {
      const repositories = await run(RepositoryLinker)
      return run(repositories.setFavorite(id, isFavorite))
    },
  )

  handlers.define(
    InvokeChannel.favoriteRemoteRepository,
    async (_event, { repository: repo }): Promise<Repo> => {
      const repositories = await run(RepositoryLinker)
      return run(repositories.ensureHosted(repo.locator, true))
    },
  )

  handlers.define(InvokeChannel.installRepository, async (_event, { localPath }): Promise<Repo> => {
    const linker = await run(RepositoryLinker)
    return run(linker.install(localPath))
  })

  handlers.define(InvokeChannel.linkRepository, async (_event, request): Promise<Repo> => {
    const linker = await run(RepositoryLinker)
    return run(linker.link(request))
  })

  handlers.define(InvokeChannel.selectLocalFolder, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Select a local Git repository",
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handlers.define(
    InvokeChannel.listProviders,
    async (): Promise<readonly import("@diffdash/domain/git-provider").GitProviderDescriptor[]> => {
      const gitProvider = await run(GitProvider)
      return run(gitProvider.listProviders)
    },
  )

  handlers.define(
    InvokeChannel.searchHostedRepositories,
    async (_event, request): Promise<readonly HostedRepository[]> => {
      const gitProvider = await run(GitProvider)
      return run(
        gitProvider.searchRepositories(
          RepositorySearchRequest.make({
            providerId: request.providerId,
            query: request.query,
            owners: request.namespaces,
          }),
        ),
      )
    },
  )

  handlers.define(
    InvokeChannel.listHostedRepositorySearchScopes,
    async (_event, request): Promise<readonly RepositorySearchScope[]> => {
      const gitProvider = await run(GitProvider)
      return run(gitProvider.listSearchScopes(request.providerId))
    },
  )
}
